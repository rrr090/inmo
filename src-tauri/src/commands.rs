// The commands behind window.api (src/tauri-api.js). They run off the UI thread
// (`async`), so a slow disk never freezes the window.

use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::db::{self, err, now_ms, query_json, CmdResult, Db};
use crate::timer::{self, Mode, Phase};
use crate::trash::{Deleted, Trash};

fn deleted_reply(trash: &Trash, deleted: Deleted) -> Value {
    json!({ "success": true, "undoId": trash.put(deleted) })
}

// Puts back the latest delete, if `undo_id` is still the latest one.
#[tauri::command(async)]
pub fn undo_delete(db: State<'_, Db>, trash: State<'_, Trash>, undo_id: u64) -> CmdResult<Value> {
    let mut conn = db.0.lock().map_err(err)?;
    trash.undo(&mut conn, undo_id)?;
    Ok(json!({ "success": true }))
}

// ---------- Subjects ----------

#[tauri::command(async)]
pub fn get_courses(db: State<'_, Db>) -> CmdResult<Vec<Value>> {
    let conn = db.0.lock().map_err(err)?;
    query_json(&conn, "SELECT * FROM courses ORDER BY rowid", &[]).map_err(err)
}

pub const MAX_TERM_CHARS: usize = 40;

// A term name ("Fall 2026"), trimmed; empty means none.
pub fn clean_term(term: Option<&str>) -> Option<String> {
    let term = term?.trim();
    (!term.is_empty()).then(|| term.chars().take(MAX_TERM_CHARS).collect())
}

// A subject color is "#rrggbb", or none for the automatic one.
pub fn clean_color(color: Option<&str>) -> Result<Option<String>, String> {
    let Some(c) = color.map(str::trim).filter(|c| !c.is_empty()) else { return Ok(None) };
    let hex = c.strip_prefix('#').unwrap_or("");
    if hex.len() == 6 && hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
        Ok(Some(c.to_lowercase()))
    } else {
        Err("Pick a color like #3987e5".into())
    }
}

#[tauri::command(async)]
pub fn add_course(
    db: State<'_, Db>,
    title: String,
    code: String,
    term: Option<String>,
    color: Option<String>,
) -> CmdResult<Value> {
    let conn = db.0.lock().map_err(err)?;
    let (term, color) = (clean_term(term.as_deref()), clean_color(color.as_deref())?);
    let id = new_id(&conn, "courses");
    conn.execute(
        "INSERT INTO courses (id, title, code, total_seconds, term, color) VALUES (?, ?, ?, 0, ?, ?)",
        params![id, title, code, term, color],
    )
    .map_err(err)?;
    Ok(json!({ "id": id, "title": title, "code": code, "total_seconds": 0, "term": term, "color": color }))
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
pub fn update_course(
    db: State<'_, Db>,
    course_id: String,
    title: String,
    code: String,
    term: Option<String>,
    color: Option<String>,
) -> CmdResult<Value> {
    let conn = db.0.lock().map_err(err)?;
    let (term, color) = (clean_term(term.as_deref()), clean_color(color.as_deref())?);
    let changes = conn
        .execute(
            "UPDATE courses SET title = ?, code = ?, term = ?, color = ? WHERE id = ?",
            params![title, code, term, color, course_id],
        )
        .map_err(err)?;
    Ok(json!({ "success": true, "changes": changes, "id": course_id, "title": title, "code": code, "term": term, "color": color }))
}

// Deletes a subject with its tasks and sessions; returns them for Undo.
pub fn delete_course_at(conn: &mut Connection, course_id: &str) -> Result<Deleted, String> {
    let mut deleted = Deleted::new();
    let tx = conn.transaction().map_err(err)?;
    deleted.keep(&tx, "courses", "id = ?", &course_id).map_err(err)?;
    deleted.keep(&tx, "tasks", "course_id = ?", &course_id).map_err(err)?;
    deleted.keep(&tx, "study_sessions", "course_id = ?", &course_id).map_err(err)?;
    tx.execute("DELETE FROM courses WHERE id = ?", [course_id]).map_err(err)?;
    tx.execute("DELETE FROM tasks WHERE course_id = ?", [course_id]).map_err(err)?;
    tx.execute("DELETE FROM study_sessions WHERE course_id = ?", [course_id]).map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(deleted)
}

#[tauri::command(async)]
pub fn delete_course(app: AppHandle, course_id: String) -> CmdResult<Value> {
    let deleted = timer::with_timer(&app, |state, conn, _| {
        // A running session for this subject has nowhere to be logged.
        if state.phase == Phase::Focus && state.course_id.as_deref() == Some(course_id.as_str()) {
            timer::cancel(state, conn);
        }
        Ok((delete_course_at(conn, &course_id)?, vec![]))
    })?;
    Ok(deleted_reply(&app.state::<Trash>(), deleted))
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

pub fn reset_course_time_at(conn: &mut Connection, course_id: &str) -> Result<Deleted, String> {
    let mut deleted = Deleted::new();
    let tx = conn.transaction().map_err(err)?;
    let total: i64 = tx
        .query_row("SELECT COALESCE(total_seconds, 0) FROM courses WHERE id = ?", [course_id], |r| r.get(0))
        .optional()
        .map_err(err)?
        .unwrap_or(0);
    deleted.keep(&tx, "study_sessions", "course_id = ?", &course_id).map_err(err)?;
    deleted.add_back(course_id, total);
    tx.execute("UPDATE courses SET total_seconds = 0 WHERE id = ?", [course_id]).map_err(err)?;
    tx.execute("DELETE FROM study_sessions WHERE course_id = ?", [course_id]).map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(deleted)
}

#[tauri::command(async)]
pub fn reset_course_time(db: State<'_, Db>, trash: State<'_, Trash>, course_id: String) -> CmdResult<Value> {
    let mut conn = db.0.lock().map_err(err)?;
    let deleted = reset_course_time_at(&mut conn, &course_id)?;
    Ok(deleted_reply(&trash, deleted))
}

// An exam date (YYYY-MM-DD, or none) and how many hours to have studied by then
// (0 for no target).
#[tauri::command(async)]
pub fn set_course_exam(db: State<'_, Db>, course_id: String, date: Option<String>, target_hours: f64) -> CmdResult<Value> {
    let conn = db.0.lock().map_err(err)?;
    let date = clean_date(&conn, date.as_deref())?;
    if !target_hours.is_finite() || !(0.0..=2000.0).contains(&target_hours) {
        return Err("The target must be between 0 and 2000 hours".into());
    }
    let target = (target_hours * 3600.0).round() as i64;
    conn.execute(
        "UPDATE courses SET exam_date = ?, exam_target_seconds = ? WHERE id = ?",
        params![date, if date.is_some() { target } else { 0 }, course_id],
    )
    .map_err(err)?;
    Ok(json!({ "success": true }))
}

// A YYYY-MM-DD date, trimmed; empty means none.
pub fn clean_date(conn: &Connection, date: Option<&str>) -> Result<Option<String>, String> {
    let Some(d) = date.map(str::trim).filter(|d| !d.is_empty()) else { return Ok(None) };
    let valid: Option<String> = conn.query_row("SELECT date(?)", [d], |r| r.get(0)).map_err(err)?;
    if valid.as_deref() != Some(d) {
        return Err("Pick a valid date".into());
    }
    Ok(Some(d.to_string()))
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

// Newest first, optionally only sessions whose note, subject title or code
// contains `search`. ended_at is Unix seconds, for editing.
#[tauri::command(async)]
pub fn get_history(db: State<'_, Db>, limit: Option<i64>, search: Option<String>) -> CmdResult<Value> {
    let conn = db.0.lock().map_err(err)?;
    history_rows(&conn, limit.unwrap_or(50), search.as_deref().unwrap_or(""))
}

pub fn history_rows(conn: &Connection, limit: i64, search: &str) -> CmdResult<Value> {
    let limit = limit.clamp(1, 100_000);
    let search = search.trim();
    let pattern = format!("%{}%", search.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
    let filter = "(?1 = '' OR s.note LIKE ?2 ESCAPE '\\' OR c.title LIKE ?2 ESCAPE '\\' OR c.code LIKE ?2 ESCAPE '\\'
                   OR t.text LIKE ?2 ESCAPE '\\')";
    let rows = query_json(
        conn,
        &format!(
            "SELECT s.id, s.course_id, c.title, c.code, s.duration, s.note, s.task_id, t.text AS task_text,
                    strftime('%d.%m.%Y, %H:%M', s.created_at, 'localtime') AS created_at,
                    CAST(strftime('%s', s.created_at) AS INTEGER) AS ended_at
             FROM study_sessions s
             JOIN courses c ON s.course_id = c.id
             LEFT JOIN tasks t ON s.task_id = t.id
             WHERE {filter}
             ORDER BY s.created_at DESC, s.id DESC LIMIT ?3"
        ),
        &[&search, &pattern, &limit],
    )
    .map_err(err)?;
    let total: i64 = conn
        .query_row(
            &format!(
                "SELECT COUNT(*) FROM study_sessions s JOIN courses c ON s.course_id = c.id
                 LEFT JOIN tasks t ON s.task_id = t.id WHERE {filter}"
            ),
            params![search, pattern],
            |r| r.get(0),
        )
        .map_err(err)?;
    Ok(json!({ "rows": rows, "total": total }))
}

pub const MAX_NOTE_CHARS: usize = 500;

// Trims a note; empty means none. Long notes are cut at MAX_NOTE_CHARS.
pub fn clean_note(note: Option<&str>) -> Option<String> {
    let note = note?.trim();
    (!note.is_empty()).then(|| note.chars().take(MAX_NOTE_CHARS).collect())
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
pub fn add_session_at(
    conn: &mut Connection,
    course_id: &str,
    ended_at: i64,
    duration: i64,
    note: Option<&str>,
) -> Result<i64, String> {
    check_session(conn, course_id, ended_at, duration)?;
    let tx = conn.transaction().map_err(err)?;
    tx.execute(
        "INSERT INTO study_sessions (course_id, duration, created_at, note) VALUES (?, ?, datetime(?, 'unixepoch'), ?)",
        params![course_id, duration, ended_at, clean_note(note)],
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
    note: Option<&str>,
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
        // Moved to another subject, it can't stay on a task of the old one.
        "UPDATE study_sessions SET course_id = ?1, duration = ?2, created_at = datetime(?3, 'unixepoch'), note = ?4,
                                   task_id = CASE WHEN course_id = ?1 THEN task_id END
         WHERE id = ?5",
        params![course_id, duration, ended_at, clean_note(note), session_id],
    )
    .map_err(err)?;
    tx.commit().map_err(err)
}

#[tauri::command(async)]
pub fn add_session(
    db: State<'_, Db>,
    course_id: String,
    ended_at: i64,
    duration: i64,
    note: Option<String>,
) -> CmdResult<Value> {
    let mut conn = db.0.lock().map_err(err)?;
    let id = add_session_at(&mut conn, &course_id, ended_at, duration, note.as_deref())?;
    Ok(json!({ "success": true, "id": id }))
}

#[tauri::command(async)]
pub fn update_session(
    db: State<'_, Db>,
    session_id: i64,
    course_id: String,
    ended_at: i64,
    duration: i64,
    note: Option<String>,
) -> CmdResult<Value> {
    let mut conn = db.0.lock().map_err(err)?;
    update_session_at(&mut conn, session_id, &course_id, ended_at, duration, note.as_deref())?;
    Ok(json!({ "success": true }))
}

pub fn delete_session_at(conn: &mut Connection, session_id: i64) -> Result<Deleted, String> {
    let mut deleted = Deleted::new();
    let tx = conn.transaction().map_err(err)?;
    deleted.keep(&tx, "study_sessions", "id = ?", &session_id).map_err(err)?;
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
        deleted.add_back(&course_id, duration);
    }
    tx.execute("DELETE FROM study_sessions WHERE id = ?", [session_id]).map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(deleted)
}

#[tauri::command(async)]
pub fn delete_session(db: State<'_, Db>, trash: State<'_, Trash>, session_id: i64) -> CmdResult<Value> {
    let mut conn = db.0.lock().map_err(err)?;
    let deleted = delete_session_at(&mut conn, session_id)?;
    Ok(deleted_reply(&trash, deleted))
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

pub const MAX_TASK_CHARS: usize = 300;

fn clean_task_text(text: &str) -> Result<String, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("A task needs some text".into());
    }
    Ok(text.chars().take(MAX_TASK_CHARS).collect())
}

// Open tasks first, in the order they were dragged into, then done ones.
// logged_seconds is the time of the sessions spent on each.
pub fn tasks_of(conn: &Connection, course_id: &str) -> rusqlite::Result<Vec<Value>> {
    query_json(
        conn,
        "SELECT t.id, t.course_id, t.text, t.completed, t.due_date, t.position, t.completed_at,
                COALESCE((SELECT SUM(duration) FROM study_sessions s WHERE s.task_id = t.id), 0) AS logged_seconds
         FROM tasks t
         WHERE t.course_id = ?
         ORDER BY t.completed, COALESCE(t.position, 0), t.rowid",
        &[&course_id],
    )
}

#[tauri::command(async)]
pub fn get_tasks(db: State<'_, Db>, course_id: String) -> CmdResult<Vec<Value>> {
    let conn = db.0.lock().map_err(err)?;
    tasks_of(&conn, &course_id).map_err(err)
}

// New tasks go to the end of the list.
pub fn add_task_at(conn: &Connection, course_id: &str, text: &str, due_date: Option<&str>) -> Result<String, String> {
    let text = clean_task_text(text)?;
    let due = clean_date(conn, due_date)?;
    let id = new_id(conn, "tasks");
    conn.execute(
        "INSERT INTO tasks (id, course_id, text, completed, due_date, position)
         VALUES (?1, ?2, ?3, 0, ?4, (SELECT COALESCE(MAX(position), 0) + 1 FROM tasks WHERE course_id = ?2))",
        params![id, course_id, text, due],
    )
    .map_err(err)?;
    Ok(id)
}

#[tauri::command(async)]
pub fn add_task(db: State<'_, Db>, course_id: String, text: String, due_date: Option<String>) -> CmdResult<Value> {
    let conn = db.0.lock().map_err(err)?;
    let id = add_task_at(&conn, &course_id, &text, due_date.as_deref())?;
    Ok(json!({ "id": id, "courseId": course_id, "text": text, "completed": 0 }))
}

#[tauri::command(async)]
pub fn update_task(db: State<'_, Db>, task_id: String, text: String, due_date: Option<String>) -> CmdResult<Value> {
    let conn = db.0.lock().map_err(err)?;
    let text = clean_task_text(&text)?;
    let due = clean_date(&conn, due_date.as_deref())?;
    let changes = conn
        .execute("UPDATE tasks SET text = ?, due_date = ? WHERE id = ?", params![text, due, task_id])
        .map_err(err)?;
    if changes == 0 {
        return Err("That task no longer exists".into());
    }
    Ok(json!({ "success": true }))
}

// Records when a task was ticked off, for the weekly review.
pub fn toggle_task_at(conn: &Connection, task_id: &str, now_secs: i64) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE tasks SET completed = NOT completed,
                          completed_at = CASE WHEN completed THEN NULL ELSE ? END
         WHERE id = ?",
        params![now_secs, task_id],
    )
}

#[tauri::command(async)]
pub fn toggle_task(db: State<'_, Db>, task_id: String) -> CmdResult<Value> {
    let conn = db.0.lock().map_err(err)?;
    toggle_task_at(&conn, &task_id, now_ms() / 1000).map_err(err)?;
    Ok(json!({ "success": true }))
}

// Saves the order tasks were dragged into. Ids from other subjects are ignored.
pub fn reorder_tasks_at(conn: &mut Connection, course_id: &str, ids: &[String]) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    for (i, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE tasks SET position = ? WHERE id = ? AND course_id = ?",
            params![i as i64 + 1, id, course_id],
        )?;
    }
    tx.commit()
}

#[tauri::command(async)]
pub fn reorder_tasks(db: State<'_, Db>, course_id: String, ids: Vec<String>) -> CmdResult<Value> {
    let mut conn = db.0.lock().map_err(err)?;
    reorder_tasks_at(&mut conn, &course_id, &ids).map_err(err)?;
    Ok(json!({ "success": true }))
}

// Open tasks of subjects in the library that are overdue or due by `until`
// (YYYY-MM-DD), soonest first.
pub fn due_tasks(conn: &Connection, until: &str) -> rusqlite::Result<Vec<Value>> {
    query_json(
        conn,
        "SELECT t.id, t.course_id, t.text, t.due_date, c.code, c.title
         FROM tasks t JOIN courses c ON t.course_id = c.id
         WHERE NOT t.completed AND t.due_date IS NOT NULL AND t.due_date <= ? AND NOT COALESCE(c.archived, 0)
         ORDER BY t.due_date, c.rowid, COALESCE(t.position, 0), t.rowid",
        &[&until],
    )
}

#[tauri::command(async)]
pub fn get_due_tasks(db: State<'_, Db>, until: String) -> CmdResult<Vec<Value>> {
    let conn = db.0.lock().map_err(err)?;
    due_tasks(&conn, &until).map_err(err)
}

// Tasks ticked off between two Unix times (from inclusive, to exclusive).
#[tauri::command(async)]
pub fn get_completed_tasks(db: State<'_, Db>, from: i64, to: i64) -> CmdResult<Vec<Value>> {
    let conn = db.0.lock().map_err(err)?;
    query_json(
        &conn,
        "SELECT id, course_id, text, completed_at FROM tasks
         WHERE completed AND completed_at >= ? AND completed_at < ? ORDER BY completed_at",
        &[&from, &to],
    )
    .map_err(err)
}

#[tauri::command(async)]
pub fn delete_task(db: State<'_, Db>, trash: State<'_, Trash>, task_id: String) -> CmdResult<Value> {
    let mut conn = db.0.lock().map_err(err)?;
    let mut deleted = Deleted::new();
    let tx = conn.transaction().map_err(err)?;
    deleted.keep(&tx, "tasks", "id = ?", &task_id).map_err(err)?;
    tx.execute("DELETE FROM tasks WHERE id = ?", [&task_id]).map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(deleted_reply(&trash, deleted))
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

// The task the current (or next) session on `course_id` is spent on; none clears it.
#[tauri::command(async)]
pub fn timer_set_task(app: AppHandle, task_id: Option<String>, course_id: String) -> CmdResult<Value> {
    timer::with_timer(&app, |state, conn, _| {
        timer::set_task(state, conn, task_id, &course_id)?;
        Ok((json!({ "success": true }), vec![]))
    })
}

// What the current (or next) session is spent on. Saved with the session.
#[tauri::command(async)]
pub fn timer_set_note(app: AppHandle, note: String) -> CmdResult<Value> {
    timer::with_timer(&app, |state, conn, _| {
        timer::set_note(state, conn, clean_note(Some(&note)));
        Ok((json!({ "success": true }), vec![]))
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
        let id = add_session_at(&mut conn, "a", ENDED, 3600, Some("  ch. 4  ")).unwrap();
        assert_eq!(total(&conn, "a"), 3600);
        let stored: String = conn
            .query_row("SELECT created_at FROM study_sessions WHERE id = ?", [id], |r| r.get(0))
            .unwrap();
        assert_eq!(stored, "2026-09-21 14:13:20");

        let note: Option<String> = conn.query_row("SELECT note FROM study_sessions WHERE id = ?", [id], |r| r.get(0)).unwrap();
        assert_eq!(note.as_deref(), Some("ch. 4"));

        // Moving it to another subject and shortening it moves the time too.
        update_session_at(&mut conn, id, "b", ENDED, 1800, Some("")).unwrap();
        assert_eq!(total(&conn, "a"), 0);
        assert_eq!(total(&conn, "b"), 1800);
        let note: Option<String> = conn.query_row("SELECT note FROM study_sessions WHERE id = ?", [id], |r| r.get(0)).unwrap();
        assert_eq!(note, None, "an empty note is removed");
    }

    #[test]
    fn history_search_matches_notes_and_subjects() {
        let mut conn = setup();
        add_session_at(&mut conn, "a", ENDED, 600, Some("Chapter 4 exercises")).unwrap();
        add_session_at(&mut conn, "a", ENDED - 1000, 600, Some("100% done")).unwrap();
        add_session_at(&mut conn, "b", ENDED - 2000, 600, None).unwrap();
        let count = |q: &str| history_rows(&conn, 50, q).unwrap()["total"].as_i64().unwrap();
        assert_eq!(count(""), 3);
        assert_eq!(count("chapter"), 1);
        assert_eq!(count("biology"), 1);
        assert_eq!(count("MA1"), 2);
        assert_eq!(count("100%"), 1, "% is matched literally");
        assert_eq!(count("0%d"), 0);
        assert_eq!(history_rows(&conn, 50, "chapter").unwrap()["rows"][0]["note"], "Chapter 4 exercises");
    }

    #[test]
    fn deleting_a_session_can_be_undone() {
        let mut conn = setup();
        let id = add_session_at(&mut conn, "a", ENDED, 600, Some("x")).unwrap();
        add_session_at(&mut conn, "a", ENDED - 5000, 300, None).unwrap();
        let trash = Trash::default();
        let undo = trash.put(delete_session_at(&mut conn, id).unwrap()).unwrap();
        assert_eq!(total(&conn, "a"), 300);
        trash.undo(&mut conn, undo).unwrap();
        assert_eq!(total(&conn, "a"), 900);
        let (note, created): (String, String) = conn
            .query_row("SELECT note, created_at FROM study_sessions WHERE id = ?", [id], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!((note.as_str(), created.as_str()), ("x", "2026-09-21 14:13:20"), "restored exactly");
        assert!(trash.undo(&mut conn, undo).is_err(), "only once");
    }

    #[test]
    fn deleting_a_subject_can_be_undone() {
        let mut conn = setup();
        add_session_at(&mut conn, "a", ENDED, 600, None).unwrap();
        conn.execute("INSERT INTO tasks (id, course_id, text, completed) VALUES ('t1', 'a', 'Read', 1)", []).unwrap();
        conn.execute("UPDATE courses SET weekly_goal_seconds = 7200, exam_date = '2027-01-15' WHERE id = 'a'", []).unwrap();
        let trash = Trash::default();
        let undo = trash.put(delete_course_at(&mut conn, "a").unwrap()).unwrap();
        let count = |conn: &Connection, sql: &str| conn.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap();
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM courses WHERE id = 'a'"), 0);
        trash.undo(&mut conn, undo).unwrap();
        assert_eq!(total(&conn, "a"), 600);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM study_sessions WHERE course_id = 'a'"), 1);
        assert_eq!(count(&conn, "SELECT completed FROM tasks WHERE id = 't1'"), 1);
        assert_eq!(count(&conn, "SELECT weekly_goal_seconds FROM courses WHERE id = 'a'"), 7200);
        // It keeps its place in the library (rowid order) too: same id, same columns.
        let exam: String = conn.query_row("SELECT exam_date FROM courses WHERE id = 'a'", [], |r| r.get(0)).unwrap();
        assert_eq!(exam, "2027-01-15");
    }

    #[test]
    fn only_the_latest_delete_can_be_undone() {
        let mut conn = setup();
        let first = add_session_at(&mut conn, "a", ENDED, 600, None).unwrap();
        let second = add_session_at(&mut conn, "b", ENDED, 600, None).unwrap();
        let trash = Trash::default();
        let undo1 = trash.put(delete_session_at(&mut conn, first).unwrap()).unwrap();
        let undo2 = trash.put(delete_session_at(&mut conn, second).unwrap()).unwrap();
        assert!(trash.undo(&mut conn, undo1).is_err());
        trash.undo(&mut conn, undo2).unwrap();
        assert_eq!(total(&conn, "b"), 600);
    }

    #[test]
    fn undo_refuses_when_the_subject_is_gone() {
        let mut conn = setup();
        let id = add_session_at(&mut conn, "a", ENDED, 600, None).unwrap();
        let trash = Trash::default();
        let undo = trash.put(delete_session_at(&mut conn, id).unwrap()).unwrap();
        conn.execute("DELETE FROM courses WHERE id = 'a'", []).unwrap();
        assert!(trash.undo(&mut conn, undo).is_err());
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM study_sessions", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn resetting_time_can_be_undone() {
        let mut conn = setup();
        add_session_at(&mut conn, "a", ENDED, 600, None).unwrap();
        let trash = Trash::default();
        let undo = trash.put(reset_course_time_at(&mut conn, "a").unwrap()).unwrap();
        assert_eq!(total(&conn, "a"), 0);
        // Studied more after the reset: undo adds the old time back on top.
        add_session_at(&mut conn, "a", ENDED + 100, 300, None).unwrap();
        trash.undo(&mut conn, undo).unwrap();
        assert_eq!(total(&conn, "a"), 900);
    }

    #[test]
    fn manual_sessions_are_validated() {
        let mut conn = setup();
        assert!(add_session_at(&mut conn, "a", ENDED, 30, None).is_err());
        assert!(add_session_at(&mut conn, "a", ENDED, 13 * 3600, None).is_err());
        assert!(add_session_at(&mut conn, "a", now_ms() / 1000 + 3600, 600, None).is_err());
        assert!(add_session_at(&mut conn, "zzz", ENDED, 600, None).is_err());
        assert!(update_session_at(&mut conn, 999, "a", ENDED, 600, None).is_err());
        assert_eq!(total(&conn, "a"), 0);
    }

    fn task_texts(conn: &Connection, course: &str) -> Vec<String> {
        tasks_of(conn, course).unwrap().iter().map(|t| t["text"].as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn tasks_keep_their_order_due_dates_and_time() {
        let mut conn = setup();
        // A task from before 1.3 has no position; it stays first.
        conn.execute("INSERT INTO tasks (id, course_id, text) VALUES ('old', 'a', 'Old')", []).unwrap();
        let read = add_task_at(&conn, "a", "  Read ch. 5 ", Some("2026-12-01")).unwrap();
        let sheet = add_task_at(&conn, "a", "Problem sheet", None).unwrap();
        assert!(add_task_at(&conn, "a", "   ", None).is_err());
        assert!(add_task_at(&conn, "a", "x", Some("2026-02-30")).is_err());
        assert_eq!(task_texts(&conn, "a"), ["Old", "Read ch. 5", "Problem sheet"]);

        reorder_tasks_at(&mut conn, "a", &[sheet.clone(), "old".into(), read.clone()]).unwrap();
        assert_eq!(task_texts(&conn, "a"), ["Problem sheet", "Old", "Read ch. 5"]);

        // Done tasks sink to the bottom and remember when.
        toggle_task_at(&conn, &sheet, 1_790_000_000).unwrap();
        assert_eq!(task_texts(&conn, "a"), ["Old", "Read ch. 5", "Problem sheet"]);
        let done_at: Option<i64> =
            conn.query_row("SELECT completed_at FROM tasks WHERE id = ?", [&sheet], |r| r.get(0)).unwrap();
        assert_eq!(done_at, Some(1_790_000_000));
        toggle_task_at(&conn, &sheet, 1_790_000_100).unwrap();
        let done_at: Option<i64> =
            conn.query_row("SELECT completed_at FROM tasks WHERE id = ?", [&sheet], |r| r.get(0)).unwrap();
        assert_eq!(done_at, None, "unticking clears it");

        // Time spent on a task adds up from its sessions.
        conn.execute("INSERT INTO study_sessions (course_id, duration, task_id) VALUES ('a', 600, ?)", [&read]).unwrap();
        conn.execute("INSERT INTO study_sessions (course_id, duration, task_id) VALUES ('a', 300, ?)", [&read]).unwrap();
        let tasks = tasks_of(&conn, "a").unwrap();
        let logged = tasks.iter().find(|t| t["id"] == read.as_str()).unwrap()["logged_seconds"].as_i64();
        assert_eq!(logged, Some(900));
    }

    #[test]
    fn due_tasks_cover_open_tasks_in_the_library() {
        let conn = setup();
        add_task_at(&conn, "a", "Overdue", Some("2026-11-01")).unwrap();
        add_task_at(&conn, "a", "Later", Some("2027-03-01")).unwrap();
        add_task_at(&conn, "a", "No date", None).unwrap();
        let done = add_task_at(&conn, "b", "Done", Some("2026-11-10")).unwrap();
        toggle_task_at(&conn, &done, 1).unwrap();
        add_task_at(&conn, "b", "Soon", Some("2026-11-15")).unwrap();
        let texts = |until: &str| -> Vec<String> {
            due_tasks(&conn, until).unwrap().iter().map(|t| t["text"].as_str().unwrap().to_string()).collect()
        };
        assert_eq!(texts("2026-11-20"), ["Overdue", "Soon"]);
        conn.execute("UPDATE courses SET archived = 1 WHERE id = 'b'", []).unwrap();
        assert_eq!(texts("2026-11-20"), ["Overdue"]);
    }

    #[test]
    fn history_shows_and_searches_the_task() {
        let mut conn = setup();
        let task = add_task_at(&conn, "a", "Problem set 3", None).unwrap();
        let id = add_session_at(&mut conn, "a", ENDED, 600, None).unwrap();
        conn.execute("UPDATE study_sessions SET task_id = ? WHERE id = ?", params![task, id]).unwrap();
        add_session_at(&mut conn, "b", ENDED - 1000, 600, None).unwrap();
        let found = history_rows(&conn, 50, "problem set").unwrap();
        assert_eq!(found["total"], 1);
        assert_eq!(found["rows"][0]["task_text"], "Problem set 3");
        // Edited on the same subject, it keeps the task; moved, it loses it.
        update_session_at(&mut conn, id, "a", ENDED, 900, None).unwrap();
        assert_eq!(history_rows(&conn, 50, "problem set").unwrap()["total"], 1);
        update_session_at(&mut conn, id, "b", ENDED, 900, None).unwrap();
        assert_eq!(history_rows(&conn, 50, "problem set").unwrap()["total"], 0);
        // A deleted task leaves the session in place.
        conn.execute("DELETE FROM tasks", []).unwrap();
        assert_eq!(history_rows(&conn, 50, "").unwrap()["total"], 2);
    }

    #[test]
    fn subject_terms_and_colors_are_checked() {
        assert_eq!(clean_term(Some("  Fall 2026 ")).as_deref(), Some("Fall 2026"));
        assert_eq!(clean_term(Some("   ")), None);
        assert_eq!(clean_term(None), None);
        assert_eq!(clean_color(Some("#3987E5")).unwrap().as_deref(), Some("#3987e5"));
        assert_eq!(clean_color(Some("")).unwrap(), None);
        assert!(clean_color(Some("red")).is_err());
        assert!(clean_color(Some("#12345")).is_err());
        assert!(clean_color(Some("#12345g")).is_err());
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
