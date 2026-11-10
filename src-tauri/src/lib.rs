// Tauri port of src/index.js: owns the SQLite database, the floating timer
// window and the commands behind window.api (see tauri/tauri-api.js).

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::types::ValueRef;
use rusqlite::{params, Connection, OptionalExtension, ToSql};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::DialogExt;

const MINI_WIDGET_SETTING_KEY: &str = "mini_widget_on_minimize";
const MINI_LABEL: &str = "mini";
const MAIN_LABEL: &str = "main";

struct Db(Mutex<Connection>);

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

// Same file the Electron build uses (%APPDATA%\inmo), so existing history carries over.
// INMO_DB_PATH overrides it for testing.
fn db_path() -> PathBuf {
    if let Ok(p) = std::env::var("INMO_DB_PATH") {
        return PathBuf::from(p);
    }
    let base = std::env::var("APPDATA").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("."));
    base.join("inmo").join("academic_steam_spotify.db")
}

fn open_db() -> rusqlite::Result<Connection> {
    let path = db_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = Connection::open(path)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS courses (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            code TEXT NOT NULL,
            total_seconds INTEGER DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS study_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            course_id TEXT,
            duration INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
         );
         CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            course_id TEXT,
            text TEXT NOT NULL,
            completed INTEGER DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
         );
         CREATE TABLE IF NOT EXISTS active_session (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            course_id TEXT,
            start_timestamp INTEGER,
            mode TEXT
         );",
    )?;
    // Columns added in later versions. "duplicate column" means the database already has it.
    for sql in [
        "ALTER TABLE active_session ADD COLUMN last_heartbeat INTEGER",
        "ALTER TABLE courses ADD COLUMN weekly_goal_seconds INTEGER DEFAULT 0",
    ] {
        if let Err(e) = conn.execute(sql, []) {
            if !e.to_string().to_lowercase().contains("duplicate column") {
                eprintln!("Migration failed ({sql}): {e}");
            }
        }
    }
    Ok(conn)
}

// Runs a query and returns each row as a JSON object keyed by column name,
// which is the shape the frontend got from sqlite3 in Electron.
fn query_json(conn: &Connection, sql: &str, args: &[&dyn ToSql]) -> rusqlite::Result<Vec<Value>> {
    let mut stmt = conn.prepare(sql)?;
    let names: Vec<String> = stmt.column_names().map(|s| s.to_string()).collect();
    let rows = stmt.query_map(args, |row| {
        let mut obj = Map::new();
        for (i, name) in names.iter().enumerate() {
            let value = match row.get_ref(i)? {
                ValueRef::Null | ValueRef::Blob(_) => Value::Null,
                ValueRef::Integer(n) => json!(n),
                ValueRef::Real(f) => json!(f),
                ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
            };
            obj.insert(name.clone(), value);
        }
        Ok(Value::Object(obj))
    })?;
    rows.collect()
}

fn get_setting_value(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM settings WHERE key = ?", [key], |r| r.get(0))
        .optional()
        .map(Option::flatten)
}

// ---------- Courses ----------

#[tauri::command]
fn get_courses(db: State<Db>) -> CmdResult<Vec<Value>> {
    let conn = db.0.lock().map_err(err)?;
    query_json(&conn, "SELECT * FROM courses", &[]).map_err(err)
}

#[tauri::command]
fn add_course(db: State<Db>, title: String, code: String) -> CmdResult<Value> {
    let conn = db.0.lock().map_err(err)?;
    let id = now_ms().to_string();
    conn.execute(
        "INSERT INTO courses (id, title, code, total_seconds) VALUES (?, ?, ?, 0)",
        params![id, title, code],
    )
    .map_err(err)?;
    Ok(json!({ "id": id, "title": title, "code": code, "total_seconds": 0 }))
}

#[tauri::command]
fn update_course(db: State<Db>, course_id: String, title: String, code: String) -> CmdResult<Value> {
    let conn = db.0.lock().map_err(err)?;
    let changes = conn
        .execute("UPDATE courses SET title = ?, code = ? WHERE id = ?", params![title, code, course_id])
        .map_err(err)?;
    Ok(json!({ "success": true, "changes": changes, "id": course_id, "title": title, "code": code }))
}

#[tauri::command]
fn delete_course(db: State<Db>, course_id: String) -> CmdResult<Value> {
    let mut conn = db.0.lock().map_err(err)?;
    let tx = conn.transaction().map_err(err)?;
    tx.execute("DELETE FROM courses WHERE id = ?", [&course_id]).map_err(err)?;
    tx.execute("DELETE FROM tasks WHERE course_id = ?", [&course_id]).map_err(err)?;
    tx.execute("DELETE FROM study_sessions WHERE course_id = ?", [&course_id]).map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(json!({ "success": true }))
}

#[tauri::command]
fn reset_course_time(db: State<Db>, course_id: String) -> CmdResult<Value> {
    let mut conn = db.0.lock().map_err(err)?;
    let tx = conn.transaction().map_err(err)?;
    tx.execute("UPDATE courses SET total_seconds = 0 WHERE id = ?", [&course_id]).map_err(err)?;
    tx.execute("DELETE FROM study_sessions WHERE course_id = ?", [&course_id]).map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(json!({ "success": true }))
}

#[tauri::command]
fn set_course_goal(db: State<Db>, course_id: String, seconds: f64) -> CmdResult<Value> {
    let conn = db.0.lock().map_err(err)?;
    let value = if seconds.is_finite() { seconds.max(0.0).round() as i64 } else { 0 };
    conn.execute("UPDATE courses SET weekly_goal_seconds = ? WHERE id = ?", params![value, course_id])
        .map_err(err)?;
    Ok(json!({ "success": true }))
}

// ---------- Sessions ----------

#[tauri::command]
fn save_session(db: State<Db>, course_id: String, duration: i64) -> CmdResult<Value> {
    let mut conn = db.0.lock().map_err(err)?;
    let tx = conn.transaction().map_err(err)?;
    tx.execute("INSERT INTO study_sessions (course_id, duration) VALUES (?, ?)", params![course_id, duration])
        .map_err(err)?;
    tx.execute("UPDATE courses SET total_seconds = total_seconds + ? WHERE id = ?", params![duration, course_id])
        .map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(json!({ "success": true }))
}

#[tauri::command]
fn get_history(db: State<Db>) -> CmdResult<Vec<Value>> {
    let conn = db.0.lock().map_err(err)?;
    query_json(
        &conn,
        "SELECT s.id, c.title, c.code, s.duration, strftime('%d.%m.%Y, %H:%M', s.created_at, 'localtime') AS created_at
         FROM study_sessions s
         JOIN courses c ON s.course_id = c.id
         ORDER BY s.created_at DESC LIMIT 50",
        &[],
    )
    .map_err(err)
}

#[tauri::command]
fn delete_session(db: State<Db>, session_id: i64) -> CmdResult<Value> {
    let mut conn = db.0.lock().map_err(err)?;
    let tx = conn.transaction().map_err(err)?;
    let row: Option<(String, i64)> = tx
        .query_row("SELECT course_id, duration FROM study_sessions WHERE id = ?", [session_id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()
        .map_err(err)?;
    if let Some((course_id, duration)) = row {
        tx.execute(
            "UPDATE courses SET total_seconds = MAX(0, total_seconds - ?) WHERE id = ?",
            params![duration, course_id],
        )
        .map_err(err)?;
    }
    tx.execute("DELETE FROM study_sessions WHERE id = ?", [session_id]).map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(json!({ "success": true }))
}

#[tauri::command]
fn get_daily_stats(db: State<Db>) -> CmdResult<Vec<Value>> {
    let conn = db.0.lock().map_err(err)?;
    query_json(
        &conn,
        "SELECT DATE(created_at, 'localtime') as date, SUM(duration) as total_seconds
         FROM study_sessions
         GROUP BY DATE(created_at, 'localtime')
         ORDER BY date DESC",
        &[],
    )
    .map_err(err)
}

// ended_at is Unix seconds; the Analytics tab groups by local date/hour itself.
#[tauri::command]
fn get_sessions(db: State<Db>) -> CmdResult<Vec<Value>> {
    let conn = db.0.lock().map_err(err)?;
    query_json(
        &conn,
        "SELECT id, course_id, duration, CAST(strftime('%s', created_at) AS INTEGER) AS ended_at
         FROM study_sessions
         ORDER BY created_at ASC",
        &[],
    )
    .map_err(err)
}

// ---------- Tasks ----------

#[tauri::command]
fn get_tasks(db: State<Db>, course_id: String) -> CmdResult<Vec<Value>> {
    let conn = db.0.lock().map_err(err)?;
    query_json(&conn, "SELECT * FROM tasks WHERE course_id = ?", &[&course_id]).map_err(err)
}

#[tauri::command]
fn add_task(db: State<Db>, course_id: String, text: String) -> CmdResult<Value> {
    let conn = db.0.lock().map_err(err)?;
    let id = now_ms().to_string();
    conn.execute(
        "INSERT INTO tasks (id, course_id, text, completed) VALUES (?, ?, ?, 0)",
        params![id, course_id, text],
    )
    .map_err(err)?;
    Ok(json!({ "id": id, "courseId": course_id, "text": text, "completed": 0 }))
}

#[tauri::command]
fn toggle_task(db: State<Db>, task_id: String) -> CmdResult<Value> {
    let conn = db.0.lock().map_err(err)?;
    conn.execute("UPDATE tasks SET completed = NOT completed WHERE id = ?", [task_id]).map_err(err)?;
    Ok(json!({ "success": true }))
}

#[tauri::command]
fn delete_task(db: State<Db>, task_id: String) -> CmdResult<Value> {
    let conn = db.0.lock().map_err(err)?;
    conn.execute("DELETE FROM tasks WHERE id = ?", [task_id]).map_err(err)?;
    Ok(json!({ "success": true }))
}

#[tauri::command]
fn get_task_stats(db: State<Db>) -> CmdResult<Vec<Value>> {
    let conn = db.0.lock().map_err(err)?;
    query_json(
        &conn,
        "SELECT course_id, COUNT(*) AS total, SUM(CASE WHEN completed THEN 1 ELSE 0 END) AS done
         FROM tasks
         GROUP BY course_id",
        &[],
    )
    .map_err(err)
}

// ---------- Settings ----------

#[tauri::command]
fn get_setting(db: State<Db>, key: String) -> CmdResult<Option<String>> {
    let conn = db.0.lock().map_err(err)?;
    get_setting_value(&conn, &key).map_err(err)
}

#[tauri::command]
fn set_setting(db: State<Db>, key: String, value: String) -> CmdResult<Value> {
    let conn = db.0.lock().map_err(err)?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(err)?;
    Ok(json!({ "success": true }))
}

// ---------- Crash-safe active session ----------

#[tauri::command]
fn start_active_session(db: State<Db>, course_id: String, start_timestamp: i64, mode: String) -> CmdResult<Value> {
    let conn = db.0.lock().map_err(err)?;
    conn.execute(
        "INSERT INTO active_session (id, course_id, start_timestamp, mode, last_heartbeat) VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET course_id = excluded.course_id,
                                       start_timestamp = excluded.start_timestamp,
                                       mode = excluded.mode,
                                       last_heartbeat = excluded.last_heartbeat",
        params![course_id, start_timestamp, mode, now_ms()],
    )
    .map_err(err)?;
    Ok(json!({ "success": true }))
}

// Sent periodically while the timer runs, so recovery knows when the app was last alive.
#[tauri::command]
fn heartbeat_active_session(db: State<Db>) -> CmdResult<Value> {
    let conn = db.0.lock().map_err(err)?;
    conn.execute("UPDATE active_session SET last_heartbeat = ? WHERE id = 1", [now_ms()]).map_err(err)?;
    Ok(json!({ "success": true }))
}

#[tauri::command]
fn clear_active_session(db: State<Db>) -> CmdResult<Value> {
    let conn = db.0.lock().map_err(err)?;
    conn.execute("DELETE FROM active_session WHERE id = 1", []).map_err(err)?;
    Ok(json!({ "success": true }))
}

// Called on startup: if a session was left open by a crash, close it out at its
// last heartbeat, so time spent with the app closed isn't credited.
#[tauri::command]
fn recover_active_session(db: State<Db>) -> CmdResult<Value> {
    let mut conn = db.0.lock().map_err(err)?;
    let row: Option<(Option<String>, Option<i64>, Option<String>, Option<i64>)> = conn
        .query_row(
            "SELECT course_id, start_timestamp, mode, last_heartbeat FROM active_session WHERE id = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(err)?;

    let (course_id, start, mode, heartbeat) = match row {
        Some((Some(c), Some(s), m, h)) if s != 0 => (c, s, m, h),
        _ => return Ok(json!({ "recovered": false })),
    };

    // Sessions started before heartbeats existed have none to go on.
    let end = heartbeat.unwrap_or_else(now_ms);
    let mut duration = (end - start) / 1000;
    // A pomodoro can never legitimately exceed 25 minutes of credited time.
    if mode.as_deref() == Some("pomodoro") {
        duration = duration.min(25 * 60);
    }

    // Guard against nonsense values (clock changes, absurdly long gaps).
    const MAX_REASONABLE: i64 = 12 * 60 * 60;
    if duration < 30 || duration > MAX_REASONABLE {
        conn.execute("DELETE FROM active_session WHERE id = 1", []).map_err(err)?;
        return Ok(json!({ "recovered": false, "discarded": true, "duration": duration }));
    }

    let course: Option<(String, String)> = conn
        .query_row("SELECT title, code FROM courses WHERE id = ?", [&course_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .map_err(err)?;
    let Some((title, code)) = course else {
        // Course was deleted while the session was open - drop the orphan.
        conn.execute("DELETE FROM active_session WHERE id = 1", []).map_err(err)?;
        return Ok(json!({ "recovered": false, "discarded": true }));
    };

    let tx = conn.transaction().map_err(err)?;
    tx.execute("INSERT INTO study_sessions (course_id, duration) VALUES (?, ?)", params![course_id, duration])
        .map_err(err)?;
    tx.execute("UPDATE courses SET total_seconds = total_seconds + ? WHERE id = ?", params![duration, course_id])
        .map_err(err)?;
    tx.execute("DELETE FROM active_session WHERE id = 1", []).map_err(err)?;
    tx.commit().map_err(err)?;

    Ok(json!({ "recovered": true, "duration": duration, "courseTitle": title, "courseCode": code }))
}

// ---------- CSV export ----------

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

// Asks where to save, then writes every session as CSV.
#[tauri::command]
async fn export_sessions_csv(app: AppHandle, db: State<'_, Db>) -> CmdResult<Value> {
    let today: String = {
        let conn = db.0.lock().map_err(err)?;
        conn.query_row("SELECT date('now', 'localtime')", [], |r| r.get(0)).map_err(err)?
    };

    let mut dialog = app
        .dialog()
        .file()
        .set_title("Export sessions")
        .set_file_name(format!("inmo-sessions-{today}.csv"))
        .add_filter("CSV", &["csv"]);
    if let Ok(docs) = app.path().document_dir() {
        dialog = dialog.set_directory(docs);
    }
    if let Some(main) = app.get_webview_window(MAIN_LABEL) {
        dialog = dialog.set_parent(&main);
    }
    let Some(file) = dialog.blocking_save_file() else {
        return Ok(json!({ "canceled": true }));
    };
    let path = file.into_path().map_err(err)?;

    let rows = {
        let conn = db.0.lock().map_err(err)?;
        query_json(
            &conn,
            "SELECT
               strftime('%Y-%m-%d', s.created_at, 'localtime') AS date,
               strftime('%H:%M', s.created_at, '-' || s.duration || ' seconds', 'localtime') AS start,
               strftime('%H:%M', s.created_at, 'localtime') AS end,
               c.code, c.title, s.duration
             FROM study_sessions s
             LEFT JOIN courses c ON s.course_id = c.id
             ORDER BY s.created_at ASC",
            &[],
        )
        .map_err(err)?
    };

    let mut out = String::from("\u{FEFF}Date,Start,End,Subject Code,Subject Title,Duration (min),Duration (sec)\r\n");
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
        ];
        out.push_str(&fields.iter().map(csv_field).collect::<Vec<_>>().join(","));
        out.push_str("\r\n");
    }
    std::fs::write(&path, out).map_err(err)?;

    Ok(json!({ "canceled": false, "filePath": path.to_string_lossy(), "count": rows.len() }))
}

// ---------- Floating timer widget ----------

fn show_mini_widget(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MINI_LABEL) {
        let _ = w.show();
        return;
    }
    let mut builder = WebviewWindowBuilder::new(app, MINI_LABEL, WebviewUrl::App("src/mini-widget.html".into()))
        .title("Mini Timer")
        .inner_size(240.0, 84.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false);
    // Bottom-right corner of the primary screen's work area, like the Electron build.
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let scale = monitor.scale_factor();
        let area = monitor.work_area();
        let pos = area.position.to_logical::<f64>(scale);
        let size = area.size.to_logical::<f64>(scale);
        builder = builder.position(pos.x + size.width - 260.0, pos.y + size.height - 110.0);
    }
    if let Err(e) = builder.build() {
        eprintln!("Failed to create mini widget: {e}");
    }
}

fn destroy_mini_widget(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MINI_LABEL) {
        let _ = w.destroy();
    }
}

fn focus_main_window(app: &AppHandle) {
    if let Some(main) = app.get_webview_window(MAIN_LABEL) {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
}

// Relays live timer state from the main window to the widget. If the timer has
// stopped, close the widget rather than leaving a stale one on screen.
#[tauri::command]
fn timer_state_update(app: AppHandle, data: Value) {
    if data.get("isStudying") == Some(&Value::Bool(false)) || data.is_null() {
        destroy_mini_widget(&app);
        return;
    }
    if app.get_webview_window(MINI_LABEL).is_some() {
        let _ = app.emit_to(MINI_LABEL, "timer-state", data);
    }
}

#[tauri::command]
fn restore_main_window(app: AppHandle) {
    focus_main_window(&app);
    destroy_mini_widget(&app);
}

#[tauri::command]
fn stop_timer_from_widget(app: AppHandle) {
    let _ = app.emit_to(MAIN_LABEL, "stop-timer-request", ());
    focus_main_window(&app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let conn = open_db().expect("failed to open the inmo database");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(Db(Mutex::new(conn)))
        .on_window_event(|window, event| {
            if window.label() != MAIN_LABEL {
                return;
            }
            let app = window.app_handle().clone();
            match event {
                // Tauri has no minimize event; a resize that leaves the window minimized is one.
                WindowEvent::Resized(_) => {
                    if window.is_minimized().unwrap_or(false) {
                        let enabled = app
                            .state::<Db>()
                            .0
                            .lock()
                            .ok()
                            .and_then(|conn| get_setting_value(&conn, MINI_WIDGET_SETTING_KEY).ok().flatten());
                        if enabled.as_deref() == Some("true") {
                            // Creating a window from inside the event loop's own callback can
                            // deadlock on Windows, so hand it off.
                            tauri::async_runtime::spawn(async move { show_mini_widget(&app) });
                        }
                    }
                }
                WindowEvent::Focused(true) => destroy_mini_widget(&app),
                WindowEvent::Destroyed => {
                    destroy_mini_widget(&app);
                    app.exit(0);
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_courses,
            add_course,
            update_course,
            delete_course,
            reset_course_time,
            set_course_goal,
            save_session,
            get_history,
            delete_session,
            get_daily_stats,
            get_sessions,
            get_tasks,
            add_task,
            toggle_task,
            delete_task,
            get_task_stats,
            get_setting,
            set_setting,
            start_active_session,
            heartbeat_active_session,
            clear_active_session,
            recover_active_session,
            export_sessions_csv,
            timer_state_update,
            restore_main_window,
            stop_timer_from_widget,
        ])
        .run(tauri::generate_context!())
        .expect("error while running inmo");
}
