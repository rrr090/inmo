// The commands behind window.api (src/tauri-api.js). They run off the UI thread
// (`async`), so a slow disk never freezes the window.

use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::db::{self, err, now_ms, query_json, CmdResult, Db};
use crate::timer::{self, Mode, Phase};

// ---------- Subjects ----------

#[tauri::command(async)]
pub fn get_courses(db: State<'_, Db>) -> CmdResult<Vec<Value>> {
    let conn = db.0.lock().map_err(err)?;
    query_json(&conn, "SELECT * FROM courses ORDER BY rowid", &[]).map_err(err)
}

#[tauri::command(async)]
pub fn add_course(db: State<'_, Db>, title: String, code: String) -> CmdResult<Value> {
    let conn = db.0.lock().map_err(err)?;
    let id = new_id(&conn, "courses");
    conn.execute(
        "INSERT INTO courses (id, title, code, total_seconds) VALUES (?, ?, ?, 0)",
        params![id, title, code],
    )
    .map_err(err)?;
    Ok(json!({ "id": id, "title": title, "code": code, "total_seconds": 0 }))
}

// Millisecond timestamps as ids, like the Electron build, bumped if two land in the same ms.
fn new_id(conn: &Connection, table: &str) -> String {
    let mut id = now_ms();
    let sql = format!("SELECT 1 FROM {table} WHERE id = ?");
    while conn.query_row(&sql, [id.to_string()], |_| Ok(())).optional().ok().flatten().is_some() {
        id += 1;
    }
    id.to_string()
}

#[tauri::command(async)]
pub fn update_course(db: State<'_, Db>, course_id: String, title: String, code: String) -> CmdResult<Value> {
    let conn = db.0.lock().map_err(err)?;
    let changes = conn
        .execute("UPDATE courses SET title = ?, code = ? WHERE id = ?", params![title, code, course_id])
        .map_err(err)?;
    Ok(json!({ "success": true, "changes": changes, "id": course_id, "title": title, "code": code }))
}

#[tauri::command(async)]
pub fn delete_course(app: AppHandle, course_id: String) -> CmdResult<Value> {
    timer::with_timer(&app, |state, conn, _| {
        // A running session for this subject has nowhere to be logged.
        if state.phase == Phase::Focus && state.course_id.as_deref() == Some(course_id.as_str()) {
            timer::cancel(state, conn);
        }
        let tx = conn.transaction().map_err(err)?;
        tx.execute("DELETE FROM courses WHERE id = ?", [&course_id]).map_err(err)?;
        tx.execute("DELETE FROM tasks WHERE course_id = ?", [&course_id]).map_err(err)?;
        tx.execute("DELETE FROM study_sessions WHERE course_id = ?", [&course_id]).map_err(err)?;
        tx.commit().map_err(err)?;
        Ok((json!({ "success": true }), vec![]))
    })
}

// Archived subjects keep their sessions and tasks, still count in analytics, and
// leave the library and the timer until restored.
#[tauri::command(async)]
pub fn set_course_archived(app: AppHandle, course_id: String, archived: bool) -> CmdResult<Value> {
    timer::with_timer(&app, |state, conn, now| {
        let mut events = vec![];
        if archived && state.phase == Phase::Focus && state.course_id.as_deref() == Some(course_id.as_str()) {
            events.push(timer::stop(state, conn, now)?);
        }
        conn.execute("UPDATE courses SET archived = ? WHERE id = ?", params![archived as i64, course_id])
            .map_err(err)?;
        Ok((json!({ "success": true }), events))
    })
}

#[tauri::command(async)]
pub fn reset_course_time(db: State<'_, Db>, course_id: String) -> CmdResult<Value> {
    let mut conn = db.0.lock().map_err(err)?;
    let tx = conn.transaction().map_err(err)?;
    tx.execute("UPDATE courses SET total_seconds = 0 WHERE id = ?", [&course_id]).map_err(err)?;
    tx.execute("DELETE FROM study_sessions WHERE course_id = ?", [&course_id]).map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(json!({ "success": true }))
}

#[tauri::command(async)]
pub fn set_course_goal(db: State<'_, Db>, course_id: String, seconds: f64) -> CmdResult<Value> {
    let conn = db.0.lock().map_err(err)?;
    let value = if seconds.is_finite() { seconds.max(0.0).round() as i64 } else { 0 };
    conn.execute("UPDATE courses SET weekly_goal_seconds = ? WHERE id = ?", params![value, course_id])
        .map_err(err)?;
    Ok(json!({ "success": true }))
}

// ---------- Sessions ----------

// Newest first. ended_at is Unix seconds, for editing.
#[tauri::command(async)]
pub fn get_history(db: State<'_, Db>, limit: Option<i64>) -> CmdResult<Value> {
    let conn = db.0.lock().map_err(err)?;
    let limit = limit.unwrap_or(50).clamp(1, 100_000);
    let rows = query_json(
        &conn,
        "SELECT s.id, s.course_id, c.title, c.code, s.duration,
                strftime('%d.%m.%Y, %H:%M', s.created_at, 'localtime') AS created_at,
                CAST(strftime('%s', s.created_at) AS INTEGER) AS ended_at
         FROM study_sessions s
         JOIN courses c ON s.course_id = c.id
         ORDER BY s.created_at DESC, s.id DESC LIMIT ?",
        &[&limit],
    )
    .map_err(err)?;
    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM study_sessions s JOIN courses c ON s.course_id = c.id", [], |r| r.get(0))
        .map_err(err)?;
    Ok(json!({ "rows": rows, "total": total }))
}

pub const MAX_SESSION_SECS: i64 = 12 * 3600;

fn check_session(conn: &Connection, course_id: &str, ended_at: i64, duration: i64) -> Result<(), String> {
    if !(60..=MAX_SESSION_SECS).contains(&duration) {
        return Err("A session must be between 1 minute and 12 hours long".into());
    }
    if ended_at > now_ms() / 1000 + 60 {
        return Err("A session can't end in the future".into());
    }
    let exists = conn
        .query_row("SELECT 1 FROM courses WHERE id = ?", [course_id], |_| Ok(()))
        .optional()
        .map_err(err)?
        .is_some();
    if !exists {
        return Err("That subject no longer exists".into());
    }
    Ok(())
}

// For time studied without the timer running. created_at is the session's end, in UTC.
pub fn add_session_at(conn: &mut Connection, course_id: &str, ended_at: i64, duration: i64) -> Result<i64, String> {
    check_session(conn, course_id, ended_at, duration)?;
    let tx = conn.transaction().map_err(err)?;
    tx.execute(
        "INSERT INTO study_sessions (course_id, duration, created_at) VALUES (?, ?, datetime(?, 'unixepoch'))",
        params![course_id, duration, ended_at],
    )
    .map_err(err)?;
    let id = tx.last_insert_rowid();
    tx.execute("UPDATE courses SET total_seconds = total_seconds + ? WHERE id = ?", params![duration, course_id])
        .map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(id)
}

pub fn update_session_at(
    conn: &mut Connection,
    session_id: i64,
    course_id: &str,
    ended_at: i64,
    duration: i64,
) -> Result<(), String> {
    check_session(conn, course_id, ended_at, duration)?;
    let tx = conn.transaction().map_err(err)?;
    let old: Option<(String, i64)> = tx
        .query_row("SELECT course_id, duration FROM study_sessions WHERE id = ?", [session_id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()
        .map_err(err)?;
    let Some((old_course, old_duration)) = old else {
        return Err("That session no longer exists".into());
    };
    tx.execute(
        "UPDATE courses SET total_seconds = MAX(0, total_seconds - ?) WHERE id = ?",
        params![old_duration, old_course],
    )
    .map_err(err)?;
    tx.execute("UPDATE courses SET total_seconds = total_seconds + ? WHERE id = ?", params![duration, course_id])
        .map_err(err)?;
    tx.execute(
        "UPDATE study_sessions SET course_id = ?, duration = ?, created_at = datetime(?, 'unixepoch') WHERE id = ?",
        params![course_id, duration, ended_at, session_id],
    )
    .map_err(err)?;
    tx.commit().map_err(err)
}

#[tauri::command(async)]
pub fn add_session(db: State<'_, Db>, course_id: String, ended_at: i64, duration: i64) -> CmdResult<Value> {
    let mut conn = db.0.lock().map_err(err)?;
    let id = add_session_at(&mut conn, &course_id, ended_at, duration)?;
    Ok(json!({ "success": true, "id": id }))
}

#[tauri::command(async)]
pub fn update_session(
    db: State<'_, Db>,
    session_id: i64,
    course_id: String,
    ended_at: i64,
    duration: i64,
) -> CmdResult<Value> {
    let mut conn = db.0.lock().map_err(err)?;
    update_session_at(&mut conn, session_id, &course_id, ended_at, duration)?;
    Ok(json!({ "success": true }))
}

#[tauri::command(async)]
pub fn delete_session(db: State<'_, Db>, session_id: i64) -> CmdResult<Value> {
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

#[tauri::command(async)]
pub fn get_daily_stats(db: State<'_, Db>) -> CmdResult<Vec<Value>> {
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
#[tauri::command(async)]
pub fn get_sessions(db: State<'_, Db>) -> CmdResult<Vec<Value>> {
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

#[tauri::command(async)]
pub fn get_tasks(db: State<'_, Db>, course_id: String) -> CmdResult<Vec<Value>> {
    let conn = db.0.lock().map_err(err)?;
    query_json(&conn, "SELECT * FROM tasks WHERE course_id = ?", &[&course_id]).map_err(err)
}

#[tauri::command(async)]
pub fn add_task(db: State<'_, Db>, course_id: String, text: String) -> CmdResult<Value> {
    let conn = db.0.lock().map_err(err)?;
    let id = new_id(&conn, "tasks");
    conn.execute(
        "INSERT INTO tasks (id, course_id, text, completed) VALUES (?, ?, ?, 0)",
        params![id, course_id, text],
    )
    .map_err(err)?;
    Ok(json!({ "id": id, "courseId": course_id, "text": text, "completed": 0 }))
}

#[tauri::command(async)]
pub fn toggle_task(db: State<'_, Db>, task_id: String) -> CmdResult<Value> {
    let conn = db.0.lock().map_err(err)?;
    conn.execute("UPDATE tasks SET completed = NOT completed WHERE id = ?", [task_id]).map_err(err)?;
    Ok(json!({ "success": true }))
}

#[tauri::command(async)]
pub fn delete_task(db: State<'_, Db>, task_id: String) -> CmdResult<Value> {
    let conn = db.0.lock().map_err(err)?;
    conn.execute("DELETE FROM tasks WHERE id = ?", [task_id]).map_err(err)?;
    Ok(json!({ "success": true }))
}

#[tauri::command(async)]
pub fn get_task_stats(db: State<'_, Db>) -> CmdResult<Vec<Value>> {
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

#[tauri::command(async)]
pub fn get_setting(db: State<'_, Db>, key: String) -> CmdResult<Option<String>> {
    let conn = db.0.lock().map_err(err)?;
    db::get_setting_value(&conn, &key).map_err(err)
}

#[tauri::command(async)]
pub fn set_setting(db: State<'_, Db>, key: String, value: String) -> CmdResult<Value> {
    let conn = db.0.lock().map_err(err)?;
    db::set_setting_value(&conn, &key, &value).map_err(err)?;
    Ok(json!({ "success": true }))
}

// ---------- Timer ----------

#[tauri::command(async)]
pub fn timer_get(app: AppHandle) -> CmdResult<Value> {
    Ok(timer::snapshot_now(&app))
}

#[tauri::command(async)]
pub fn timer_start(app: AppHandle, course_id: String, mode: String) -> CmdResult<Value> {
    timer::with_timer(&app, |state, conn, now| {
        timer::start(state, conn, &course_id, Mode::parse(&mode), now)?;
        Ok((json!({ "success": true }), vec![]))
    })
}

// Every stop, from here, the tray, the shortcut or the widget, is reported as a
// "stopped" timer-event, which is where the page refreshes and shows its toast.
#[tauri::command(async)]
pub fn timer_stop(app: AppHandle) -> CmdResult<Value> {
    timer::with_timer(&app, |state, conn, now| {
        let ev = timer::stop(state, conn, now)?;
        Ok((ev.clone(), vec![ev]))
    })
}

#[tauri::command(async)]
pub fn timer_resolve_idle(app: AppHandle, keep: bool) -> CmdResult<Value> {
    timer::with_timer(&app, |state, conn, _| {
        timer::resolve_idle(state, conn, keep)?;
        Ok((json!({ "success": true }), vec![]))
    })
}

// What crash recovery found at launch. Handed out once, so reloading the page
// can't show it twice.
pub struct Recovery(pub Mutex<Option<Value>>);

#[tauri::command(async)]
pub fn take_recovery_result(recovery: State<'_, Recovery>) -> CmdResult<Value> {
    Ok(recovery.0.lock().map_err(err)?.take().unwrap_or_else(|| json!({ "recovered": false })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_conn;

    fn setup() -> Connection {
        let conn = test_conn();
        conn.execute_batch(
            "INSERT INTO courses (id, title, code, total_seconds) VALUES ('a', 'Algebra', 'MA1', 0);
             INSERT INTO courses (id, title, code, total_seconds) VALUES ('b', 'Biology', 'BI1', 0);",
        )
        .unwrap();
        conn
    }

    fn total(conn: &Connection, id: &str) -> i64 {
        conn.query_row("SELECT total_seconds FROM courses WHERE id = ?", [id], |r| r.get(0)).unwrap()
    }

    const ENDED: i64 = 1_790_000_000; // a past time

    #[test]
    fn manual_sessions_update_totals() {
        let mut conn = setup();
        let id = add_session_at(&mut conn, "a", ENDED, 3600).unwrap();
        assert_eq!(total(&conn, "a"), 3600);
        let stored: String = conn
            .query_row("SELECT created_at FROM study_sessions WHERE id = ?", [id], |r| r.get(0))
            .unwrap();
        assert_eq!(stored, "2026-09-21 14:13:20");

        // Moving it to another subject and shortening it moves the time too.
        update_session_at(&mut conn, id, "b", ENDED, 1800).unwrap();
        assert_eq!(total(&conn, "a"), 0);
        assert_eq!(total(&conn, "b"), 1800);
    }

    #[test]
    fn manual_sessions_are_validated() {
        let mut conn = setup();
        assert!(add_session_at(&mut conn, "a", ENDED, 30).is_err());
        assert!(add_session_at(&mut conn, "a", ENDED, 13 * 3600).is_err());
        assert!(add_session_at(&mut conn, "a", now_ms() / 1000 + 3600, 600).is_err());
        assert!(add_session_at(&mut conn, "zzz", ENDED, 600).is_err());
        assert!(update_session_at(&mut conn, 999, "a", ENDED, 600).is_err());
        assert_eq!(total(&conn, "a"), 0);
    }

    #[test]
    fn ids_stay_unique_within_a_millisecond() {
        let conn = setup();
        let first = new_id(&conn, "tasks");
        conn.execute("INSERT INTO tasks (id, course_id, text) VALUES (?, 'a', 'x')", [&first]).unwrap();
        let second = new_id(&conn, "tasks");
        assert_ne!(first, second);
    }
}
