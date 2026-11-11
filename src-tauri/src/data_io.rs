// Getting data in and out: CSV export and import, and database backups.

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::db::{self, err, query_json, CmdResult, Db};
use crate::timer::{Phase, Timer, MAIN_LABEL};

pub const CSV_HEADER: &str = "Date,Start,End,Subject Code,Subject Title,Duration (min),Duration (sec),Note";

fn csv_field(value: &Value) -> String {
    let text = match value {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    if text.contains(['"', ',', '\r', '\n']) {
        format!("\"{}\"", text.replace('"', "\"\""))
    } else {
        text
    }
}

pub fn sessions_csv(conn: &Connection) -> rusqlite::Result<(String, usize)> {
    let rows = query_json(
        conn,
        "SELECT
           strftime('%Y-%m-%d', s.created_at, 'localtime') AS date,
           strftime('%H:%M', s.created_at, '-' || s.duration || ' seconds', 'localtime') AS start,
           strftime('%H:%M', s.created_at, 'localtime') AS end,
           c.code, c.title, s.duration, s.note
         FROM study_sessions s
         LEFT JOIN courses c ON s.course_id = c.id
         ORDER BY s.created_at ASC",
        &[],
    )?;
    // The BOM makes Excel read the file as UTF-8, so non-Latin subject names survive.
    let mut out = format!("\u{FEFF}{CSV_HEADER}\r\n");
    for r in &rows {
        let secs = r["duration"].as_i64().unwrap_or(0);
        let fields = [
            r["date"].clone(),
            r["start"].clone(),
            r["end"].clone(),
            r["code"].clone(),
            r["title"].clone(),
            Value::String(format!("{:.1}", secs as f64 / 60.0)),
            json!(secs),
            r["note"].clone(),
        ];
        out.push_str(&fields.iter().map(csv_field).collect::<Vec<_>>().join(","));
        out.push_str("\r\n");
    }
    Ok((out, rows.len()))
}

fn main_window_dialog(app: &AppHandle) -> tauri_plugin_dialog::FileDialogBuilder<tauri::Wry> {
    let mut dialog = app.dialog().file();
    if let Some(main) = app.get_webview_window(MAIN_LABEL) {
        dialog = dialog.set_parent(&main);
    }
    dialog
}

// Asks where to save, then writes every session as CSV.
#[tauri::command(async)]
pub fn export_sessions_csv(app: AppHandle, db: State<'_, Db>) -> CmdResult<Value> {
    let today = {
        let conn = db.0.lock().map_err(err)?;
        db::local_today(&conn)
    };
    let mut dialog = main_window_dialog(&app)
        .set_title("Export sessions")
        .set_file_name(format!("inmo-sessions-{today}.csv"))
        .add_filter("CSV", &["csv"]);
    if let Ok(docs) = app.path().document_dir() {
        dialog = dialog.set_directory(docs);
    }
    let Some(file) = dialog.blocking_save_file() else {
        return Ok(json!({ "canceled": true }));
    };
    let path = file.into_path().map_err(err)?;
    let (csv, count) = {
        let conn = db.0.lock().map_err(err)?;
        sessions_csv(&conn).map_err(err)?
    };
    std::fs::write(&path, csv).map_err(err)?;
    Ok(json!({ "canceled": false, "filePath": path.to_string_lossy(), "count": count }))
}

// Reads a CSV in the export format. Subjects are matched by code (then title) and
// created if missing; a session already in the database (same subject, end minute
// and length) is skipped, so importing the same file twice adds nothing.
pub fn import_csv_text(conn: &mut Connection, text: &str) -> Result<Value, String> {
    let text = text.trim_start_matches('\u{FEFF}');
    let mut reader = csv::ReaderBuilder::new().flexible(true).trim(csv::Trim::All).from_reader(text.as_bytes());
    let headers: Vec<String> = reader.headers().map_err(err)?.iter().map(|h| h.to_lowercase()).collect();
    let col = |name: &str| headers.iter().position(|h| h == name);
    let (Some(c_date), Some(c_end), Some(c_code)) = (col("date"), col("end"), col("subject code")) else {
        return Err(format!("This doesn't look like an inmo export. The first line should be:\n{CSV_HEADER}"));
    };
    let (c_title, c_sec, c_min) = (col("subject title"), col("duration (sec)"), col("duration (min)"));
    // Exports from before 1.2.1 have no Note column.
    let c_note = col("note");

    let tx = conn.transaction().map_err(err)?;
    let (mut imported, mut duplicates, mut invalid) = (0, 0, 0);
    let mut new_subjects: Vec<String> = Vec::new();
    for record in reader.records() {
        let Ok(record) = record else {
            invalid += 1;
            continue;
        };
        let get = |i: Option<usize>| i.and_then(|i| record.get(i)).unwrap_or("").to_string();
        let (date, end, code) = (get(Some(c_date)), get(Some(c_end)), get(Some(c_code)));
        let title = Some(get(c_title)).filter(|t| !t.is_empty()).unwrap_or_else(|| code.clone());
        let duration = get(c_sec)
            .parse::<i64>()
            .ok()
            .or_else(|| get(c_min).parse::<f64>().ok().map(|m| (m * 60.0).round() as i64))
            .unwrap_or(0);

        // Local "date end" to UTC, the way created_at is stored. NULL if malformed.
        let ended_utc: Option<String> = tx
            .query_row(
                "SELECT datetime(?1 || ' ' || ?2, 'utc') WHERE ?1 GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
                                                         AND ?2 GLOB '[0-9][0-9]:[0-9][0-9]'",
                params![date, end],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)?
            .flatten();
        let (Some(ended_utc), false, true) = (ended_utc, code.is_empty(), (1..=crate::commands::MAX_SESSION_SECS).contains(&duration))
        else {
            invalid += 1;
            continue;
        };

        // Same code and title; or the code alone, if only one subject has it
        // (several subjects can share a code, like "SELF").
        let existing: Option<String> = tx
            .query_row(
                "SELECT id FROM courses WHERE code = ?1 AND title = ?2 ORDER BY rowid LIMIT 1",
                params![code, title],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)?
            .or(tx
                .query_row(
                    "SELECT MIN(id) FROM courses WHERE code = ?1 HAVING COUNT(*) = 1",
                    [&code],
                    |r| r.get(0),
                )
                .optional()
                .map_err(err)?);
        let course_id = match existing {
            Some(id) => id,
            None => {
                let id = format!("{}{}", db::now_ms(), new_subjects.len());
                tx.execute(
                    "INSERT INTO courses (id, title, code, total_seconds) VALUES (?, ?, ?, 0)",
                    params![id, title, code],
                )
                .map_err(err)?;
                new_subjects.push(code.clone());
                id
            }
        };

        let duplicate = tx
            .query_row(
                "SELECT 1 FROM study_sessions WHERE course_id = ? AND duration = ?
                   AND strftime('%Y-%m-%d %H:%M', created_at, 'localtime') = ? || ' ' || ?",
                params![course_id, duration, date, end],
                |_| Ok(()),
            )
            .optional()
            .map_err(err)?
            .is_some();
        if duplicate {
            duplicates += 1;
            continue;
        }
        let note = crate::commands::clean_note(Some(&get(c_note)));
        tx.execute(
            "INSERT INTO study_sessions (course_id, duration, created_at, note) VALUES (?, ?, ?, ?)",
            params![course_id, duration, ended_utc, note],
        )
        .map_err(err)?;
        tx.execute("UPDATE courses SET total_seconds = total_seconds + ? WHERE id = ?", params![duration, course_id])
            .map_err(err)?;
        imported += 1;
    }
    tx.commit().map_err(err)?;
    Ok(json!({ "imported": imported, "duplicates": duplicates, "invalid": invalid, "newSubjects": new_subjects }))
}

fn before_change_snapshot(conn: &Connection, what: &str) -> Result<PathBuf, String> {
    let dest = db::backups_dir().join(format!("inmo-before-{what}-{}.db", db::local_today(conn)));
    db::snapshot(conn, &dest).map_err(|e| format!("Couldn't back up your data first, so nothing was changed: {e}"))?;
    Ok(dest)
}

#[tauri::command(async)]
pub fn import_sessions_csv(app: AppHandle, db: State<'_, Db>) -> CmdResult<Value> {
    let Some(file) = main_window_dialog(&app)
        .set_title("Import sessions")
        .add_filter("CSV", &["csv"])
        .blocking_pick_file()
    else {
        return Ok(json!({ "canceled": true }));
    };
    let path = file.into_path().map_err(err)?;
    let text = std::fs::read_to_string(&path).map_err(|e| format!("Couldn't read {}: {e}", path.display()))?;
    let mut conn = db.0.lock().map_err(err)?;
    before_change_snapshot(&conn, "import")?;
    let mut result = import_csv_text(&mut conn, &text)?;
    result["canceled"] = json!(false);
    Ok(result)
}

// ---------- Backups ----------

fn timer_idle(app: &AppHandle) -> Result<(), String> {
    let timer = app.state::<Timer>();
    let state = timer.0.lock().map_err(err)?;
    if state.phase == Phase::Focus {
        return Err("Stop the timer first".into());
    }
    Ok(())
}

fn file_date(path: &Path) -> Option<String> {
    path.file_stem()?.to_str()?.strip_prefix("inmo-").map(str::to_string)
}

#[tauri::command(async)]
pub fn get_backup_info() -> CmdResult<Value> {
    let auto = db::list_auto_backups(&db::auto_backups_dir());
    Ok(json!({
        "folder": db::backups_dir().to_string_lossy(),
        "latest": auto.first().and_then(|p| file_date(p)),
        "count": auto.len(),
        "kept": db::AUTO_BACKUPS_KEPT,
    }))
}

#[tauri::command(async)]
pub fn backup_now(db: State<'_, Db>) -> CmdResult<Value> {
    let conn = db.0.lock().map_err(err)?;
    let dir = db::auto_backups_dir();
    let dest = dir.join(format!("inmo-{}.db", db::local_today(&conn)));
    db::snapshot(&conn, &dest).map_err(err)?;
    db::prune_auto_backups(&dir, db::AUTO_BACKUPS_KEPT);
    Ok(json!({ "path": dest.to_string_lossy() }))
}

#[tauri::command(async)]
pub fn open_backups_folder() -> CmdResult<()> {
    let dir = db::backups_dir();
    std::fs::create_dir_all(&dir).map_err(err)?;
    std::process::Command::new("explorer").arg(&dir).spawn().map_err(err)?;
    Ok(())
}

// Checks a file is an inmo database before anything is replaced.
pub fn check_backup_file(path: &Path) -> Result<(), String> {
    let src = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| "That file isn't a database".to_string())?;
    let tables: i64 = src
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('courses', 'study_sessions')",
            [],
            |r| r.get(0),
        )
        .map_err(|_| "That file isn't a database".to_string())?;
    if tables < 2 {
        return Err("That file isn't an inmo backup".into());
    }
    Ok(())
}

pub fn restore_from(conn: &mut Connection, path: &Path) -> Result<(), String> {
    check_backup_file(path)?;
    conn.restore(rusqlite::MAIN_DB, path, None::<fn(rusqlite::backup::Progress)>)
        .map_err(err)?;
    // A backup from an older version may lack newer columns.
    db::migrate(conn).map_err(err)
}

// Replaces everything with a backup. The current data is saved first.
#[tauri::command(async)]
pub fn restore_backup(app: AppHandle, db: State<'_, Db>) -> CmdResult<Value> {
    timer_idle(&app)?;
    let Some(file) = main_window_dialog(&app)
        .set_title("Restore from backup")
        .set_directory(db::backups_dir())
        .add_filter("inmo backup", &["db"])
        .blocking_pick_file()
    else {
        return Ok(json!({ "canceled": true }));
    };
    let path = file.into_path().map_err(err)?;
    check_backup_file(&path)?;
    timer_idle(&app)?;
    let mut conn = db.0.lock().map_err(err)?;
    let saved = before_change_snapshot(&conn, "restore")?;
    restore_from(&mut conn, &path)?;
    Ok(json!({ "canceled": false, "previous": saved.to_string_lossy() }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_conn;

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn export_then_import_round_trips() {
        let mut src = test_conn();
        src.execute_batch(
            "INSERT INTO courses (id, title, code, total_seconds) VALUES ('a', 'Data, Structures', 'CS2', 5400);
             INSERT INTO study_sessions (course_id, duration, created_at, note) VALUES ('a', 3600, '2026-11-01 10:00:00', 'Trees, \"heaps\"');
             INSERT INTO study_sessions (course_id, duration, created_at) VALUES ('a', 1800, '2026-11-02 23:30:00');",
        )
        .unwrap();
        let (csv, n) = sessions_csv(&src).unwrap();
        assert_eq!(n, 2);
        assert!(csv.starts_with('\u{FEFF}'));
        assert!(csv.contains("\"Data, Structures\""));

        // Into an empty database: the subject is created and totals add up.
        let mut dst = test_conn();
        let r = import_csv_text(&mut dst, &csv).unwrap();
        assert_eq!(r["imported"], 2);
        assert_eq!(r["newSubjects"], json!(["CS2"]));
        assert_eq!(count(&dst, "SELECT total_seconds FROM courses"), 5400);
        assert_eq!(count(&dst, "SELECT COUNT(*) FROM study_sessions WHERE created_at LIKE '2026-11-01 10:00%'"), 1);
        // Notes survive, commas and quotes included; a session without one stays without.
        assert_eq!(count(&dst, "SELECT COUNT(*) FROM study_sessions WHERE note = 'Trees, \"heaps\"'"), 1);
        assert_eq!(count(&dst, "SELECT COUNT(*) FROM study_sessions WHERE note IS NULL"), 1);

        // Again: everything is a duplicate.
        let r = import_csv_text(&mut dst, &csv).unwrap();
        assert_eq!(r["imported"], 0);
        assert_eq!(r["duplicates"], 2);
        assert_eq!(count(&dst, "SELECT total_seconds FROM courses"), 5400);

        // Into the original: nothing new either, even though stored times have seconds.
        let r = import_csv_text(&mut src, &csv).unwrap();
        assert_eq!(r["duplicates"], 2);
    }

    #[test]
    fn import_matches_existing_subjects_and_skips_bad_rows() {
        let mut conn = test_conn();
        conn.execute("INSERT INTO courses (id, title, code, total_seconds) VALUES ('m', 'Math', 'MA1', 0)", [])
            .unwrap();
        let csv = "Date,Start,End,Subject Code,Subject Title,Duration (min),Duration (sec)\n\
                   2026-10-01,09:00,10:00,MA1,Math,60.0,3600\n\
                   2026-10-01,09:00,10:00,MA1,Math,,\n\
                   not a date,09:00,10:00,MA1,Math,60.0,3600\n\
                   2026-10-02,,11:00,MA1,Math,30,\n";
        let r = import_csv_text(&mut conn, csv).unwrap();
        assert_eq!(r["imported"], 2, "{r}");
        assert_eq!(r["invalid"], 2, "{r}");
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM courses"), 1);
        assert_eq!(count(&conn, "SELECT total_seconds FROM courses"), 3600 + 1800);
    }

    #[test]
    fn import_tells_apart_subjects_sharing_a_code() {
        let mut conn = test_conn();
        conn.execute_batch(
            "INSERT INTO courses (id, title, code, total_seconds) VALUES ('ai', 'AI', 'SELF', 0);
             INSERT INTO courses (id, title, code, total_seconds) VALUES ('li', 'Linux', 'SELF', 0);
             INSERT INTO courses (id, title, code, total_seconds) VALUES ('m', 'Math', 'MA1', 0);",
        )
        .unwrap();
        let csv = "Date,Start,End,Subject Code,Subject Title,Duration (min),Duration (sec)
                   2026-10-01,09:00,10:00,SELF,Linux,60.0,3600
                   2026-10-01,11:00,11:30,SELF,Cooking,30.0,1800
                   2026-10-01,12:00,12:10,MA1,Mathematics (renamed),10.0,600
";
        let r = import_csv_text(&mut conn, csv).unwrap();
        assert_eq!(r["imported"], 3, "{r}");
        let total = |id: &str| -> i64 {
            conn.query_row("SELECT total_seconds FROM courses WHERE id = ?", [id], |r| r.get(0)).unwrap()
        };
        assert_eq!(total("li"), 3600);
        assert_eq!(total("ai"), 0);
        // Only one MA1, so a renamed title still matches it.
        assert_eq!(total("m"), 600);
        // "SELF / Cooking" is ambiguous, so it becomes its own subject.
        assert_eq!(r["newSubjects"], json!(["SELF"]));
    }

    #[test]
    fn import_rejects_other_csvs() {
        let mut conn = test_conn();
        assert!(import_csv_text(&mut conn, "name,email\na,b\n").is_err());
    }

    #[test]
    fn restore_replaces_data_and_migrates() {
        let dir = std::env::temp_dir().join(format!("inmo-test-{}", db::now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        // An "old version" backup without the archived column.
        let old = dir.join("old.db");
        let o = Connection::open(&old).unwrap();
        o.execute_batch(
            "CREATE TABLE courses (id TEXT PRIMARY KEY, title TEXT NOT NULL, code TEXT NOT NULL, total_seconds INTEGER DEFAULT 0);
             CREATE TABLE study_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, course_id TEXT, duration INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
             INSERT INTO courses VALUES ('x', 'Old', 'OLD', 60);",
        )
        .unwrap();
        drop(o);

        let mut conn = test_conn();
        conn.execute("INSERT INTO courses (id, title, code) VALUES ('new', 'New', 'NEW')", []).unwrap();
        restore_from(&mut conn, &old).unwrap();
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM courses WHERE id = 'x' AND archived = 0"), 1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM courses WHERE id = 'new'"), 0);

        let not_inmo = dir.join("other.db");
        Connection::open(&not_inmo).unwrap().execute("CREATE TABLE t (a)", []).unwrap();
        assert!(restore_from(&mut conn, &not_inmo).is_err());
        std::fs::write(dir.join("junk.db"), b"hello").unwrap();
        assert!(check_backup_file(&dir.join("junk.db")).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
