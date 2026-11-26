// Sync with an inmo account: the local side. The app keeps working from the
// local database; triggers note every change a person makes, and the page
// (src/sync.js) sends those to Supabase and hands back what other devices
// changed. Whichever change was made last wins, row by row.
//
// Synced: subjects, tasks and sessions. Not synced: settings, the running
// session, and subjects' cached totals (each device adds up its own sessions).
//
// Bookkeeping, added by `migrate`:
// - `updated_at` (Unix ms) on each synced row: when it last changed.
// - `sync_dirty`: 1 while a local change hasn't been uploaded.
// - `study_sessions.uid`: a random id, since the integer ids clash between devices.
// - `sync_tombstones`: rows deleted here, until the delete is uploaded.
// - `sync_meta`: `applying` is '1' while remote changes are written, so the
//   triggers don't take them for local ones.

use rusqlite::types::Value as SqlValue;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use tauri::State;

use crate::db::{err, query_json, CmdResult, Db};

const NOW_MS: &str = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
const NOT_APPLYING: &str = "(SELECT value FROM sync_meta WHERE key = 'applying') IS NOT '1'";

pub struct Table {
    pub name: &'static str,
    // The column that identifies a row on every device.
    pub key: &'static str,
    // Columns sent to the server, the key first. A change to any of them
    // (other than the key) counts as a local edit.
    pub columns: &'static [&'static str],
}

// In the order remote changes are applied: subjects before what belongs to them.
pub const TABLES: [Table; 3] = [
    Table {
        name: "courses",
        key: "id",
        columns: &[
            "id",
            "title",
            "code",
            "weekly_goal_seconds",
            "archived",
            "exam_date",
            "exam_target_seconds",
            "term",
            "color",
        ],
    },
    Table {
        name: "tasks",
        key: "id",
        columns: &["id", "course_id", "text", "completed", "due_date", "position", "completed_at"],
    },
    Table {
        name: "study_sessions",
        key: "uid",
        columns: &["uid", "course_id", "duration", "created_at", "note", "task_id"],
    },
];

fn table(name: &str) -> Result<&'static Table, String> {
    TABLES.iter().find(|t| t.name == name).ok_or_else(|| format!("Unknown table {name}"))
}

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    for sql in [
        "ALTER TABLE courses ADD COLUMN updated_at INTEGER",
        "ALTER TABLE courses ADD COLUMN sync_dirty INTEGER DEFAULT 1",
        "ALTER TABLE tasks ADD COLUMN updated_at INTEGER",
        "ALTER TABLE tasks ADD COLUMN sync_dirty INTEGER DEFAULT 1",
        "ALTER TABLE study_sessions ADD COLUMN updated_at INTEGER",
        "ALTER TABLE study_sessions ADD COLUMN sync_dirty INTEGER DEFAULT 1",
        "ALTER TABLE study_sessions ADD COLUMN uid TEXT",
    ] {
        if let Err(e) = conn.execute(sql, []) {
            if !e.to_string().to_lowercase().contains("duplicate column") {
                return Err(e);
            }
        }
    }
    conn.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS sync_tombstones (
            tbl TEXT NOT NULL,
            id TEXT NOT NULL,
            deleted_at INTEGER NOT NULL,
            PRIMARY KEY (tbl, id)
         );
         CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value TEXT);
         DELETE FROM sync_meta WHERE key = 'applying';
         UPDATE study_sessions SET uid = lower(hex(randomblob(16))) WHERE uid IS NULL;
         CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_uid ON study_sessions(uid);
         UPDATE courses SET updated_at = {NOW_MS} WHERE updated_at IS NULL;
         UPDATE tasks SET updated_at = {NOW_MS} WHERE updated_at IS NULL;
         UPDATE study_sessions SET updated_at = {NOW_MS} WHERE updated_at IS NULL;"
    ))?;
    for t in &TABLES {
        let edited: Vec<&str> = t.columns.iter().copied().filter(|c| *c != t.key).collect();
        let fill_uid = if t.key == "uid" { "uid = COALESCE(NEW.uid, lower(hex(randomblob(16)))), " } else { "" };
        conn.execute_batch(&format!(
            "DROP TRIGGER IF EXISTS sync_{name}_insert;
             DROP TRIGGER IF EXISTS sync_{name}_update;
             DROP TRIGGER IF EXISTS sync_{name}_delete;
             CREATE TRIGGER sync_{name}_insert AFTER INSERT ON {name} WHEN {NOT_APPLYING}
             BEGIN
               UPDATE {name} SET {fill_uid}updated_at = MAX(COALESCE(NEW.updated_at, 0) + 1, {NOW_MS}), sync_dirty = 1
                 WHERE rowid = NEW.rowid;
               DELETE FROM sync_tombstones WHERE tbl = '{name}' AND id = NEW.{key};
             END;
             CREATE TRIGGER sync_{name}_update AFTER UPDATE OF {edited} ON {name} WHEN {NOT_APPLYING}
             BEGIN
               UPDATE {name} SET updated_at = MAX(COALESCE(OLD.updated_at, 0) + 1, {NOW_MS}), sync_dirty = 1
                 WHERE rowid = NEW.rowid;
             END;
             CREATE TRIGGER sync_{name}_delete AFTER DELETE ON {name} WHEN {NOT_APPLYING} AND OLD.{key} IS NOT NULL
             BEGIN
               INSERT OR REPLACE INTO sync_tombstones (tbl, id, deleted_at) VALUES ('{name}', OLD.{key}, MAX(COALESCE(OLD.updated_at, 0) + 1, {NOW_MS}));
             END;",
            name = t.name,
            key = t.key,
            edited = edited.join(", "),
        ))?;
    }
    // The triggers are made afresh on every launch, so a changed definition
    // reaches databases that already have the old one.
    // Change times only move forward, even for two edits in the same millisecond,
    // so an edit made while an upload runs is never taken for the uploaded one.
    // Rows saved by the app never set a uid themselves; the insert trigger does,
    // and rows from the server always carry theirs.
    Ok(())
}

// ---------- Which account this database syncs with ----------

// The first sync with an account, or with a different account than last time,
// starts over: every local row is uploaded and everything is downloaded again.
pub fn link_account(conn: &Connection, user_id: &str) -> rusqlite::Result<bool> {
    let current: Option<String> =
        conn.query_row("SELECT value FROM sync_meta WHERE key = 'user_id'", [], |r| r.get(0)).optional()?;
    if current.as_deref() == Some(user_id) {
        return Ok(false);
    }
    let tx = conn.unchecked_transaction()?;
    for t in &TABLES {
        tx.execute(&format!("UPDATE {} SET sync_dirty = 1", t.name), [])?;
    }
    tx.execute("DELETE FROM sync_meta WHERE key LIKE 'cursor:%'", [])?;
    tx.execute("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('user_id', ?)", [user_id])?;
    tx.commit()?;
    Ok(true)
}

// ---------- Uploading ----------

fn to_remote(t: &Table, row: &Value) -> Value {
    let mut out = Map::new();
    for c in t.columns {
        let name = if *c == t.key { "id" } else { c };
        out.insert(name.to_string(), row.get(*c).cloned().unwrap_or(Value::Null));
    }
    out.insert("updated_at".into(), row.get("updated_at").cloned().unwrap_or(json!(0)));
    out.insert("deleted".into(), json!(false));
    Value::Object(out)
}

// Local changes not yet uploaded: changed rows and deletes, at most `limit` per
// table, shaped like the server's rows.
pub fn pending(conn: &Connection, limit: i64) -> rusqlite::Result<Value> {
    let mut out = Map::new();
    for t in &TABLES {
        let cols = t.columns.join(", ");
        let rows = query_json(
            conn,
            &format!("SELECT {cols}, updated_at FROM {} WHERE sync_dirty = 1 ORDER BY rowid LIMIT ?", t.name),
            &[&limit],
        )?;
        let mut list: Vec<Value> = rows.iter().map(|r| to_remote(t, r)).collect();
        let deletes = query_json(
            conn,
            "SELECT id, deleted_at FROM sync_tombstones WHERE tbl = ? ORDER BY deleted_at LIMIT ?",
            &[&t.name, &limit],
        )?;
        for d in deletes {
            let mut row = Map::new();
            row.insert("id".into(), d["id"].clone());
            row.insert("updated_at".into(), d["deleted_at"].clone());
            row.insert("deleted".into(), json!(true));
            list.push(Value::Object(row));
        }
        out.insert(t.name.to_string(), Value::Array(list));
    }
    Ok(Value::Object(out))
}

// After an upload: rows are clean again unless they changed while it ran.
pub fn mark_pushed(conn: &Connection, table_name: &str, rows: &[Value]) -> Result<(), String> {
    let t = table(table_name)?;
    let tx = conn.unchecked_transaction().map_err(err)?;
    for row in rows {
        let id = row["id"].as_str().unwrap_or_default();
        let at = row["updated_at"].as_i64().unwrap_or(0);
        if row["deleted"].as_bool() == Some(true) {
            tx.execute(
                "DELETE FROM sync_tombstones WHERE tbl = ? AND id = ? AND deleted_at = ?",
                params![t.name, id, at],
            )
            .map_err(err)?;
        } else {
            tx.execute(
                &format!("UPDATE {} SET sync_dirty = 0 WHERE {} = ? AND updated_at = ?", t.name, t.key),
                params![id, at],
            )
            .map_err(err)?;
        }
    }
    tx.commit().map_err(err)
}

// ---------- Downloading ----------

fn sql_value(v: &Value) -> SqlValue {
    match v {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(*b as i64),
        Value::Number(n) => {
            n.as_i64().map(SqlValue::Integer).unwrap_or_else(|| SqlValue::Real(n.as_f64().unwrap_or(0.0)))
        }
        Value::String(s) => SqlValue::Text(s.clone()),
        other => SqlValue::Text(other.to_string()),
    }
}

fn adjust_total(conn: &Connection, course_id: Option<&str>, secs: i64) -> rusqlite::Result<()> {
    if let (Some(id), true) = (course_id, secs != 0) {
        conn.execute(
            "UPDATE courses SET total_seconds = MAX(0, COALESCE(total_seconds, 0) + ?) WHERE id = ?",
            params![secs, id],
        )?;
    }
    Ok(())
}

// Writes rows downloaded from the server. A row only replaces the local one if
// it's newer; an older one is skipped, and the local change is uploaded next.
// Returns how many rows changed here.
pub fn apply_remote(conn: &Connection, table_name: &str, rows: &[Value]) -> Result<usize, String> {
    let t = table(table_name)?;
    let sessions = t.name == "study_sessions";
    let tx = conn.unchecked_transaction().map_err(err)?;
    tx.execute("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('applying', '1')", []).map_err(err)?;
    let mut changed = 0;
    for row in rows {
        let Some(id) = row["id"].as_str() else { continue };
        let remote_at = row["updated_at"].as_i64().unwrap_or(0);
        let local: Option<(i64, Option<String>, i64)> = tx
            .query_row(
                &format!(
                    "SELECT COALESCE(updated_at, 0), {course}, {dur} FROM {} WHERE {} = ?",
                    t.name,
                    t.key,
                    course = if t.name == "courses" { "NULL" } else { "course_id" },
                    dur = if sessions { "COALESCE(duration, 0)" } else { "0" },
                ),
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(err)?;
        // Deleted here after the remote change: the delete wins.
        let tombstone: Option<i64> = tx
            .query_row("SELECT deleted_at FROM sync_tombstones WHERE tbl = ? AND id = ?", params![t.name, id], |r| {
                r.get(0)
            })
            .optional()
            .map_err(err)?;
        if tombstone.is_some_and(|at| at >= remote_at) {
            continue;
        }
        if local.as_ref().is_some_and(|(at, _, _)| *at >= remote_at) {
            continue;
        }

        if row["deleted"].as_bool() == Some(true) {
            if let Some((_, course, dur)) = &local {
                tx.execute(&format!("DELETE FROM {} WHERE {} = ?", t.name, t.key), [id]).map_err(err)?;
                if sessions {
                    adjust_total(&tx, course.as_deref(), -dur).map_err(err)?;
                }
                changed += 1;
            }
            continue;
        }

        let values: Vec<SqlValue> = t
            .columns
            .iter()
            .map(|c| sql_value(&row[if *c == t.key { "id" } else { c }]))
            .chain([SqlValue::Integer(remote_at), SqlValue::Integer(0)])
            .collect();
        match &local {
            Some((_, old_course, old_dur)) => {
                let sets: Vec<String> = t.columns.iter().map(|c| format!("{c} = ?")).collect();
                let sql = format!(
                    "UPDATE {} SET {}, updated_at = ?, sync_dirty = ? WHERE {} = ?",
                    t.name,
                    sets.join(", "),
                    t.key
                );
                let mut args = values.clone();
                args.push(SqlValue::Text(id.to_string()));
                tx.execute(&sql, params_from_iter(args)).map_err(err)?;
                if sessions {
                    adjust_total(&tx, old_course.as_deref(), -old_dur).map_err(err)?;
                    adjust_total(&tx, row["course_id"].as_str(), row["duration"].as_i64().unwrap_or(0)).map_err(err)?;
                }
            }
            None => {
                let marks = vec!["?"; t.columns.len() + 2].join(", ");
                let extra = if t.name == "courses" { ", total_seconds" } else { "" };
                let extra_mark = if t.name == "courses" { ", 0" } else { "" };
                let sql = format!(
                    "INSERT INTO {} ({}, updated_at, sync_dirty{extra}) VALUES ({marks}{extra_mark})",
                    t.name,
                    t.columns.join(", ")
                );
                tx.execute(&sql, params_from_iter(values)).map_err(err)?;
                if sessions {
                    adjust_total(&tx, row["course_id"].as_str(), row["duration"].as_i64().unwrap_or(0)).map_err(err)?;
                }
            }
        }
        changed += 1;
    }
    // A subject downloaded after its sessions starts at 0; count them now.
    if t.name == "courses" && changed > 0 {
        tx.execute(
            "UPDATE courses SET total_seconds = (SELECT COALESCE(SUM(duration), 0) FROM study_sessions s WHERE s.course_id = courses.id)
             WHERE COALESCE(total_seconds, 0) = 0",
            [],
        )
        .map_err(err)?;
    }
    tx.execute("DELETE FROM sync_meta WHERE key = 'applying'", []).map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(changed)
}

fn cursor(conn: &Connection, table_name: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM sync_meta WHERE key = ?", [format!("cursor:{table_name}")], |r| r.get(0))
        .optional()
}

// ---------- Restoring a backup ----------

// A restored backup brings its own, older bookkeeping: its rows look already
// uploaded and older than the server's, so the next sync would put back what
// the restore replaced. What's needed from before the restore to prevent that.
pub struct BeforeRestore {
    // Which account this database syncs with, and how far it has downloaded.
    meta: Vec<(String, String)>,
    // Every row that exists now, by its key on every device.
    keys: Vec<(&'static Table, Vec<String>)>,
}

pub fn before_restore(conn: &Connection) -> rusqlite::Result<BeforeRestore> {
    let mut stmt = conn.prepare("SELECT key, value FROM sync_meta WHERE key = 'user_id' OR key LIKE 'cursor:%'")?;
    let meta = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
    let mut keys = Vec::new();
    for t in &TABLES {
        let mut stmt = conn.prepare(&format!("SELECT {key} FROM {} WHERE {key} IS NOT NULL", t.name, key = t.key))?;
        let ids = stmt.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
        keys.push((t, ids));
    }
    Ok(BeforeRestore { meta, keys })
}

// After a restore (and its migration): the backup's rows become the newest
// change, rows it doesn't have are deleted for the account too, and the
// bookkeeping of which account and how far downloads got is put back.
pub fn after_restore(conn: &Connection, before: &BeforeRestore) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM sync_meta WHERE key = 'user_id' OR key LIKE 'cursor:%'", [])?;
    for (key, value) in &before.meta {
        tx.execute("INSERT INTO sync_meta (key, value) VALUES (?, ?)", [key, value])?;
    }
    for (t, ids) in &before.keys {
        tx.execute(
            &format!("UPDATE {} SET updated_at = MAX(COALESCE(updated_at, 0) + 1, {NOW_MS}), sync_dirty = 1", t.name),
            [],
        )?;
        let mut gone = tx.prepare(&format!(
            "INSERT OR REPLACE INTO sync_tombstones (tbl, id, deleted_at)
             SELECT ?1, ?2, {NOW_MS} WHERE NOT EXISTS (SELECT 1 FROM {} WHERE {} = ?2)",
            t.name, t.key
        ))?;
        for id in ids {
            gone.execute(params![t.name, id])?;
        }
    }
    tx.commit()
}

// ---------- Commands (src/sync.js) ----------

#[tauri::command(async)]
pub fn sync_link(db: State<'_, Db>, user_id: String) -> CmdResult<Value> {
    let conn = db.0.lock().map_err(err)?;
    let restarted = link_account(&conn, &user_id).map_err(err)?;
    Ok(json!({ "restarted": restarted }))
}

#[tauri::command(async)]
pub fn sync_pending(db: State<'_, Db>) -> CmdResult<Value> {
    let conn = db.0.lock().map_err(err)?;
    pending(&conn, 500).map_err(err)
}

#[tauri::command(async)]
pub fn sync_mark_pushed(db: State<'_, Db>, table: String, rows: Vec<Value>) -> CmdResult<Value> {
    let conn = db.0.lock().map_err(err)?;
    mark_pushed(&conn, &table, &rows)?;
    Ok(json!({ "success": true }))
}

// `cursor` is the newest server time among the rows, kept for the next download.
#[tauri::command(async)]
pub fn sync_apply(db: State<'_, Db>, table: String, rows: Vec<Value>, cursor: Option<String>) -> CmdResult<Value> {
    let conn = db.0.lock().map_err(err)?;
    let changed = apply_remote(&conn, &table, &rows)?;
    if let Some(c) = cursor {
        conn.execute(
            "INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)",
            params![format!("cursor:{table}"), c],
        )
        .map_err(err)?;
    }
    Ok(json!({ "changed": changed }))
}

#[tauri::command(async)]
pub fn sync_cursors(db: State<'_, Db>) -> CmdResult<Value> {
    let conn = db.0.lock().map_err(err)?;
    let mut out = Map::new();
    for t in &TABLES {
        out.insert(t.name.to_string(), cursor(&conn, t.name).map_err(err)?.map(Value::String).unwrap_or(Value::Null));
    }
    Ok(Value::Object(out))
}

// ---------- Tests ----------

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn).unwrap();
        conn
    }

    fn one<T: rusqlite::types::FromSql>(conn: &Connection, sql: &str) -> T {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    fn rows(v: &Value, table: &str) -> Vec<Value> {
        v[table].as_array().cloned().unwrap_or_default()
    }

    fn push_all(conn: &Connection) {
        let p = pending(conn, 1000).unwrap();
        for t in &TABLES {
            mark_pushed(conn, t.name, &rows(&p, t.name)).unwrap();
        }
    }

    #[test]
    fn local_changes_are_pending_until_pushed() {
        let conn = db();
        conn.execute("INSERT INTO courses (id, title, code, total_seconds) VALUES ('c1', 'Algebra', 'MA1', 0)", [])
            .unwrap();
        conn.execute(
            "INSERT INTO study_sessions (course_id, duration, created_at) VALUES ('c1', 600, '2026-11-20 10:00:00')",
            [],
        )
        .unwrap();
        let p = pending(&conn, 100).unwrap();
        assert_eq!(rows(&p, "courses").len(), 1);
        let session = &rows(&p, "study_sessions")[0];
        assert_eq!(session["id"].as_str().unwrap().len(), 32, "sessions get a random uid");
        assert_eq!(session["duration"], json!(600));

        push_all(&conn);
        let p = pending(&conn, 100).unwrap();
        assert!(rows(&p, "courses").is_empty() && rows(&p, "study_sessions").is_empty());

        // Only real edits count; the cached total doesn't.
        conn.execute("UPDATE courses SET total_seconds = 999 WHERE id = 'c1'", []).unwrap();
        assert!(rows(&pending(&conn, 100).unwrap(), "courses").is_empty());
        conn.execute("UPDATE courses SET title = 'Linear Algebra' WHERE id = 'c1'", []).unwrap();
        assert_eq!(rows(&pending(&conn, 100).unwrap(), "courses")[0]["title"], json!("Linear Algebra"));
    }

    #[test]
    fn deletes_become_tombstones_and_undo_clears_them() {
        let conn = db();
        conn.execute("INSERT INTO tasks (id, course_id, text) VALUES ('t1', 'c1', 'Read')", []).unwrap();
        push_all(&conn);
        conn.execute("DELETE FROM tasks WHERE id = 't1'", []).unwrap();
        let p = pending(&conn, 100).unwrap();
        assert_eq!(rows(&p, "tasks")[0]["deleted"], json!(true));
        // Putting it back (undo) cancels the delete and uploads the row again.
        conn.execute("INSERT INTO tasks (id, course_id, text, sync_dirty) VALUES ('t1', 'c1', 'Read', 0)", []).unwrap();
        let p = pending(&conn, 100).unwrap();
        assert_eq!(rows(&p, "tasks").len(), 1);
        assert_eq!(rows(&p, "tasks")[0]["deleted"], json!(false));
    }

    #[test]
    fn remote_rows_are_applied_without_looking_local() {
        let conn = db();
        let course = json!({ "id": "c9", "title": "Biology", "code": "BI1", "weekly_goal_seconds": 0, "archived": 0,
            "exam_date": null, "exam_target_seconds": 0, "term": null, "color": null, "updated_at": 1000, "deleted": false });
        assert_eq!(apply_remote(&conn, "courses", &[course]).unwrap(), 1);
        let session = json!({ "id": "abc", "course_id": "c9", "duration": 1500, "created_at": "2026-11-20 09:00:00",
            "note": "Cells", "task_id": null, "updated_at": 1000, "deleted": false });
        assert_eq!(apply_remote(&conn, "study_sessions", std::slice::from_ref(&session)).unwrap(), 1);
        assert_eq!(one::<i64>(&conn, "SELECT total_seconds FROM courses WHERE id = 'c9'"), 1500);
        // Nothing to upload: these came from the server.
        let p = pending(&conn, 100).unwrap();
        assert!(rows(&p, "courses").is_empty() && rows(&p, "study_sessions").is_empty());
        // The same row again changes nothing.
        assert_eq!(apply_remote(&conn, "study_sessions", &[session]).unwrap(), 0);

        // A newer edit moves the time; a delete takes it away.
        let edit = json!({ "id": "abc", "course_id": "c9", "duration": 900, "created_at": "2026-11-20 09:00:00",
            "note": "Cells", "task_id": null, "updated_at": 2000, "deleted": false });
        apply_remote(&conn, "study_sessions", &[edit]).unwrap();
        assert_eq!(one::<i64>(&conn, "SELECT total_seconds FROM courses WHERE id = 'c9'"), 900);
        apply_remote(&conn, "study_sessions", &[json!({ "id": "abc", "updated_at": 3000, "deleted": true })]).unwrap();
        assert_eq!(one::<i64>(&conn, "SELECT COUNT(*) FROM study_sessions"), 0);
        assert_eq!(one::<i64>(&conn, "SELECT total_seconds FROM courses WHERE id = 'c9'"), 0);
        assert_eq!(one::<i64>(&conn, "SELECT COUNT(*) FROM sync_tombstones"), 0);
    }

    #[test]
    fn the_newer_change_wins() {
        let conn = db();
        conn.execute("INSERT INTO tasks (id, course_id, text) VALUES ('t1', 'c1', 'Local edit')", []).unwrap();
        let local_at: i64 = one(&conn, "SELECT updated_at FROM tasks");
        let older = json!({ "id": "t1", "course_id": "c1", "text": "Old remote", "completed": 0, "due_date": null,
            "position": 1, "completed_at": null, "updated_at": local_at - 1, "deleted": false });
        assert_eq!(apply_remote(&conn, "tasks", &[older]).unwrap(), 0);
        assert_eq!(one::<String>(&conn, "SELECT text FROM tasks"), "Local edit");
        assert_eq!(one::<i64>(&conn, "SELECT sync_dirty FROM tasks"), 1, "still to be uploaded");

        let newer = json!({ "id": "t1", "course_id": "c1", "text": "New remote", "completed": 1, "due_date": null,
            "position": 1, "completed_at": null, "updated_at": local_at + 1, "deleted": false });
        assert_eq!(apply_remote(&conn, "tasks", &[newer]).unwrap(), 1);
        assert_eq!(one::<String>(&conn, "SELECT text FROM tasks"), "New remote");
        assert_eq!(one::<i64>(&conn, "SELECT sync_dirty FROM tasks"), 0);

        // A local delete made after a remote edit stays deleted.
        conn.execute("DELETE FROM tasks", []).unwrap();
        let stale = json!({ "id": "t1", "course_id": "c1", "text": "Stale", "completed": 0, "due_date": null,
            "position": 1, "completed_at": null, "updated_at": local_at + 1, "deleted": false });
        assert_eq!(apply_remote(&conn, "tasks", &[stale]).unwrap(), 0);
        assert_eq!(one::<i64>(&conn, "SELECT COUNT(*) FROM tasks"), 0);
    }

    #[test]
    fn edits_during_an_upload_stay_pending() {
        let conn = db();
        conn.execute("INSERT INTO courses (id, title, code) VALUES ('c1', 'A', 'A1')", []).unwrap();
        let p = pending(&conn, 100).unwrap();
        let before: i64 = one(&conn, "SELECT updated_at FROM courses");
        conn.execute("UPDATE courses SET title = 'B' WHERE id = 'c1'", []).unwrap();
        assert!(one::<i64>(&conn, "SELECT updated_at FROM courses") > before, "change times move forward");
        mark_pushed(&conn, "courses", &rows(&p, "courses")).unwrap();
        assert_eq!(one::<i64>(&conn, "SELECT sync_dirty FROM courses"), 1);
    }

    #[test]
    fn linking_another_account_uploads_everything_again() {
        let conn = db();
        conn.execute("INSERT INTO courses (id, title, code) VALUES ('c1', 'A', 'A1')", []).unwrap();
        assert!(link_account(&conn, "user-1").unwrap());
        push_all(&conn);
        assert!(!link_account(&conn, "user-1").unwrap());
        assert!(rows(&pending(&conn, 100).unwrap(), "courses").is_empty());
        assert!(link_account(&conn, "user-2").unwrap());
        assert_eq!(rows(&pending(&conn, 100).unwrap(), "courses").len(), 1);
    }

    #[test]
    fn migrating_twice_is_harmless() {
        let conn = db();
        crate::db::migrate(&conn).unwrap();
        conn.execute("INSERT INTO study_sessions (course_id, duration) VALUES ('c1', 60)", []).unwrap();
        assert_eq!(one::<i64>(&conn, "SELECT COUNT(*) FROM study_sessions WHERE uid IS NOT NULL"), 1);
    }
}
