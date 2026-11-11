// The study timer. It lives here rather than in the page so it keeps exact time
// while the window is minimized or closed to the tray, and so the tray, the
// global shortcut and the floating widget can all drive the same timer.
//
// The logic is plain functions over (state, connection, now) so it can be tested
// without a clock; the background thread at the bottom feeds it real time.

use std::sync::Mutex;
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::db::{self, now_ms, setting_i64, Db};

// A session has to be longer than this to be logged.
pub const MIN_SESSION_SECS: i64 = 30;
// A running session records it's alive this often. A crash loses at most this much.
pub const HEARTBEAT_MS: i64 = 30_000;
// Input within this long counts as "back at the computer" after an idle stretch.
const BACK_THRESHOLD_MS: u64 = 10_000;

// Settings, in minutes unless noted. Defaults match the classic Pomodoro routine.
pub const FOCUS_MIN: (&str, i64) = ("pomodoro_focus_min", 25);
pub const SHORT_BREAK_MIN: (&str, i64) = ("pomodoro_short_break_min", 5);
pub const LONG_BREAK_MIN: (&str, i64) = ("pomodoro_long_break_min", 15);
pub const LONG_BREAK_EVERY: (&str, i64) = ("pomodoro_long_break_every", 4); // pomodoros
pub const IDLE_MIN: (&str, i64) = ("idle_threshold_min", 10); // 0 turns idle detection off
// Start the next Pomodoro by itself when a break ends.
pub const AUTO_CONTINUE: (&str, bool) = ("pomodoro_auto_continue", false);

// Desktop notifications (shown while the window isn't in front), by type, and
// the chime at the end of a Pomodoro or a break.
pub const NOTIFY_POMODORO: (&str, bool) = ("notify_pomodoro", true); // Pomodoro done, break over
pub const NOTIFY_AWAY: (&str, bool) = ("notify_away", true); // back after an idle stretch
pub const NOTIFY_SESSION: (&str, bool) = ("notify_session", true); // started or saved from the tray/shortcut
pub const SOUND: (&str, bool) = ("pomodoro_sound", true);

pub fn focus_secs(conn: &Connection) -> i64 {
    setting_i64(conn, FOCUS_MIN.0, FOCUS_MIN.1, 1, 180) * 60
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Phase {
    Idle,
    Focus,
    Break,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Mode {
    Stopwatch,
    Pomodoro,
}

impl Mode {
    pub fn parse(s: &str) -> Mode {
        if s == "pomodoro" {
            Mode::Pomodoro
        } else {
            Mode::Stopwatch
        }
    }
    fn as_str(self) -> &'static str {
        match self {
            Mode::Stopwatch => "stopwatch",
            Mode::Pomodoro => "pomodoro",
        }
    }
}

// An idle stretch during a stopwatch session: no input since `from_ms`, and
// input again at `back_ms` once the person returns.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Away {
    pub from_ms: i64,
    pub back_ms: Option<i64>,
}

#[derive(Debug)]
pub struct TimerState {
    pub phase: Phase,
    pub mode: Mode,
    pub course_id: Option<String>,
    pub course_code: String,
    pub course_title: String,
    pub start_ms: i64,
    // Countdown length; 0 means counting up (stopwatch).
    pub target_secs: i64,
    pub long_break: bool,
    // Pomodoros finished since the last long break.
    pub pomodoros_done: i64,
    pub last_heartbeat_ms: i64,
    pub away: Option<Away>,
}

impl Default for TimerState {
    fn default() -> Self {
        TimerState {
            phase: Phase::Idle,
            mode: Mode::Stopwatch,
            course_id: None,
            course_code: String::new(),
            course_title: String::new(),
            start_ms: 0,
            target_secs: 0,
            long_break: false,
            pomodoros_done: 0,
            last_heartbeat_ms: 0,
            away: None,
        }
    }
}

pub struct Timer(pub Mutex<TimerState>);

pub fn format_clock(secs: i64, with_hours: bool) -> String {
    let secs = secs.max(0);
    let (h, m, s) = (secs / 3600, (secs % 3600) / 60, secs % 60);
    if with_hours {
        format!("{h:02}:{m:02}:{s:02}")
    } else {
        format!("{:02}:{s:02}", secs / 60)
    }
}

impl TimerState {
    pub fn elapsed_secs(&self, now: i64) -> i64 {
        ((now - self.start_ms) / 1000).max(0)
    }

    // What the clock shows: time so far for the stopwatch, time left for a countdown.
    pub fn shown_secs(&self, now: i64) -> i64 {
        if self.phase == Phase::Idle {
            return 0;
        }
        if self.target_secs > 0 {
            (self.target_secs - self.elapsed_secs(now)).max(0)
        } else {
            self.elapsed_secs(now)
        }
    }

    pub fn course_label(&self) -> String {
        match self.phase {
            Phase::Idle => "No active subject".into(),
            Phase::Break if self.long_break => "Long break".into(),
            Phase::Break => "Short break".into(),
            Phase::Focus => format!("{} — {}", self.course_code, self.course_title),
        }
    }

    pub fn snapshot(&self, conn: &Connection, now: i64) -> Value {
        let shown = self.shown_secs(now);
        let time_str = if self.phase == Phase::Idle {
            String::new()
        } else {
            format_clock(shown, self.target_secs == 0)
        };
        let every = setting_i64(conn, LONG_BREAK_EVERY.0, LONG_BREAK_EVERY.1, 1, 12);
        json!({
            "phase": match self.phase { Phase::Idle => "idle", Phase::Focus => "focus", Phase::Break => "break" },
            "mode": self.mode.as_str(),
            "isStudying": self.phase != Phase::Idle,
            "courseId": self.course_id,
            "courseLabel": self.course_label(),
            "shownSecs": shown,
            "elapsedSecs": if self.phase == Phase::Idle { 0 } else { self.elapsed_secs(now) },
            "timeStr": time_str,
            "longBreak": self.long_break,
            "pomodorosDone": self.pomodoros_done,
            "longBreakEvery": every,
            "awaySecs": self.away.and_then(|a| a.back_ms.map(|b| (b - a.from_ms) / 1000)),
        })
    }
}

fn course_info(conn: &Connection, course_id: &str) -> rusqlite::Result<Option<(String, String, bool)>> {
    conn.query_row(
        "SELECT code, title, COALESCE(archived, 0) FROM courses WHERE id = ?",
        [course_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? != 0)),
    )
    .optional()
}

pub fn save_session(conn: &mut Connection, course_id: &str, duration: i64) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    tx.execute("INSERT INTO study_sessions (course_id, duration) VALUES (?, ?)", params![course_id, duration])?;
    tx.execute("UPDATE courses SET total_seconds = total_seconds + ? WHERE id = ?", params![duration, course_id])?;
    tx.commit()
}

fn clear_active(conn: &Connection) {
    if let Err(e) = conn.execute("DELETE FROM active_session WHERE id = 1", []) {
        eprintln!("Failed to clear active session: {e}");
    }
}

// Starts a focus session. Starting while on a break ends the break.
pub fn start(state: &mut TimerState, conn: &Connection, course_id: &str, mode: Mode, now: i64) -> Result<(), String> {
    if state.phase == Phase::Focus {
        return Err("The timer is already running".into());
    }
    let Some((code, title, archived)) = course_info(conn, course_id).map_err(db::err)? else {
        return Err("That subject no longer exists".into());
    };
    if archived {
        return Err("That subject is archived. Restore it to time it again.".into());
    }
    // Record the session right away so a crash or power cut can't lose it.
    conn.execute(
        "INSERT INTO active_session (id, course_id, start_timestamp, mode, last_heartbeat) VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET course_id = excluded.course_id,
                                       start_timestamp = excluded.start_timestamp,
                                       mode = excluded.mode,
                                       last_heartbeat = excluded.last_heartbeat",
        params![course_id, now, mode.as_str(), now],
    )
    .map_err(db::err)?;

    if mode != state.mode {
        state.pomodoros_done = 0;
    }
    state.phase = Phase::Focus;
    state.mode = mode;
    state.course_id = Some(course_id.to_string());
    state.course_code = code;
    state.course_title = title;
    state.start_ms = now;
    state.target_secs = if mode == Mode::Pomodoro { focus_secs(conn) } else { 0 };
    state.long_break = false;
    state.last_heartbeat_ms = now;
    state.away = None;
    Ok(())
}

fn session_event(kind: &str, state: &TimerState, saved: bool, duration: i64) -> Value {
    json!({
        "kind": kind,
        "saved": saved,
        "duration": duration,
        "courseId": state.course_id,
        "courseCode": state.course_code,
        "courseTitle": state.course_title,
    })
}

// Stops whatever is running. A focus session longer than MIN_SESSION_SECS is
// logged; a break just ends. Returns the event describing what happened.
pub fn stop(state: &mut TimerState, conn: &mut Connection, now: i64) -> Result<Value, String> {
    let event = match state.phase {
        Phase::Idle => json!({ "kind": "none" }),
        Phase::Break => {
            state.phase = Phase::Idle;
            json!({ "kind": "break-skipped" })
        }
        Phase::Focus => {
            let mut duration = state.elapsed_secs(now);
            if state.target_secs > 0 {
                duration = duration.min(state.target_secs);
            }
            clear_active(conn);
            let saved = duration > MIN_SESSION_SECS;
            if saved {
                let course_id = state.course_id.clone().unwrap_or_default();
                save_session(conn, &course_id, duration).map_err(db::err)?;
            }
            state.phase = Phase::Idle;
            state.away = None;
            session_event("stopped", state, saved, duration)
        }
    };
    state.target_secs = 0;
    Ok(event)
}

// Drops the running session without logging it (its subject was deleted).
pub fn cancel(state: &mut TimerState, conn: &Connection) {
    if state.phase == Phase::Focus {
        clear_active(conn);
    }
    state.phase = Phase::Idle;
    state.target_secs = 0;
    state.away = None;
}

// Advances the timer to `now`. `idle_ms` is how long since the last keyboard or
// mouse input, when known. Returns events for the page and notifications.
pub fn tick(state: &mut TimerState, conn: &mut Connection, now: i64, idle_ms: Option<u64>) -> Vec<Value> {
    let mut events = Vec::new();
    match state.phase {
        Phase::Idle => {}
        Phase::Focus => {
            if now - state.last_heartbeat_ms >= HEARTBEAT_MS {
                state.last_heartbeat_ms = now;
                if let Err(e) = conn.execute("UPDATE active_session SET last_heartbeat = ? WHERE id = 1", [now]) {
                    eprintln!("Failed to record heartbeat: {e}");
                }
            }

            if state.target_secs > 0 && state.elapsed_secs(now) >= state.target_secs {
                let duration = state.target_secs;
                clear_active(conn);
                let saved = save_session(conn, &state.course_id.clone().unwrap_or_default(), duration).is_ok();
                state.pomodoros_done += 1;
                let every = setting_i64(conn, LONG_BREAK_EVERY.0, LONG_BREAK_EVERY.1, 1, 12);
                let long = state.pomodoros_done % every == 0;
                let (key, default) = if long { LONG_BREAK_MIN } else { SHORT_BREAK_MIN };
                let break_secs = setting_i64(conn, key, default, 0, 120) * 60;

                let mut ev = session_event("pomodoro-complete", state, saved, duration);
                ev["breakSecs"] = json!(break_secs);
                ev["longBreak"] = json!(long);

                if long {
                    state.pomodoros_done = 0;
                }
                if break_secs > 0 {
                    state.phase = Phase::Break;
                    state.start_ms = now;
                    state.target_secs = break_secs;
                    state.long_break = long;
                } else {
                    state.phase = Phase::Idle;
                    state.target_secs = 0;
                    ev["autoStarted"] = json!(continue_cycle(state, conn, now));
                }
                events.push(ev);
                return events;
            }

            // Idle detection, for the stopwatch only: a Pomodoro is a fixed block.
            let threshold_ms = setting_i64(conn, IDLE_MIN.0, IDLE_MIN.1, 0, 240) as u64 * 60_000;
            if let (Mode::Stopwatch, Some(idle)) = (state.mode, idle_ms) {
                match state.away {
                    None if threshold_ms > 0 && idle >= threshold_ms => {
                        // Never count away time from before the session started.
                        let from = (now - idle as i64).max(state.start_ms);
                        state.away = Some(Away { from_ms: from, back_ms: None });
                    }
                    Some(Away { from_ms, back_ms: None }) if idle < BACK_THRESHOLD_MS => {
                        let back = now - idle as i64;
                        state.away = Some(Away { from_ms, back_ms: Some(back) });
                        events.push(json!({
                            "kind": "idle-return",
                            "awaySecs": (back - from_ms) / 1000,
                            "courseCode": state.course_code,
                        }));
                    }
                    _ => {}
                }
            }
        }
        Phase::Break => {
            if state.elapsed_secs(now) >= state.target_secs {
                let long_break = state.long_break;
                state.phase = Phase::Idle;
                state.target_secs = 0;
                let auto = continue_cycle(state, conn, now);
                events.push(json!({
                    "kind": "break-over",
                    "longBreak": long_break,
                    "autoStarted": auto,
                    "courseCode": state.course_code,
                }));
            }
        }
    }
    events
}

// With auto-continue on, starts the next Pomodoro on the same subject. Returns
// false (and leaves the timer idle) if it's off or the subject is gone or archived.
fn continue_cycle(state: &mut TimerState, conn: &Connection, now: i64) -> bool {
    if state.mode != Mode::Pomodoro || !db::setting_bool(conn, AUTO_CONTINUE.0, AUTO_CONTINUE.1) {
        return false;
    }
    let Some(course_id) = state.course_id.clone() else { return false };
    start(state, conn, &course_id, Mode::Pomodoro, now).is_ok()
}

// The answer to "you were away for N minutes, keep that time?". Removing it moves
// the session's start forward by the time away, here and in the crash-recovery row.
pub fn resolve_idle(state: &mut TimerState, conn: &Connection, keep: bool) -> Result<(), String> {
    let Some(Away { from_ms, back_ms: Some(back_ms) }) = state.away else {
        state.away = None;
        return Ok(());
    };
    state.away = None;
    if keep || state.phase != Phase::Focus {
        return Ok(());
    }
    state.start_ms += (back_ms - from_ms).max(0);
    conn.execute("UPDATE active_session SET start_timestamp = ? WHERE id = 1", [state.start_ms])
        .map_err(db::err)?;
    Ok(())
}

// Called once at launch: a session left open by a crash is closed at its last
// heartbeat, so time with the app closed isn't credited, and written to history.
pub fn recover(conn: &mut Connection, now: i64) -> rusqlite::Result<Value> {
    let row: Option<(Option<String>, Option<i64>, Option<String>, Option<i64>)> = conn
        .query_row(
            "SELECT course_id, start_timestamp, mode, last_heartbeat FROM active_session WHERE id = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;

    let (course_id, start, mode, heartbeat) = match row {
        Some((Some(c), Some(s), m, h)) if s != 0 => (c, s, m, h),
        _ => return Ok(json!({ "recovered": false })),
    };

    // Sessions started before heartbeats existed have none to go on.
    let end = heartbeat.unwrap_or(now);
    let mut duration = (end - start) / 1000;
    // A Pomodoro never credits more than its focus length.
    if mode.as_deref() == Some("pomodoro") {
        duration = duration.min(focus_secs(conn));
    }

    // Guard against nonsense values (clock changes, absurdly long gaps).
    const MAX_REASONABLE: i64 = 12 * 60 * 60;
    if duration < MIN_SESSION_SECS || duration > MAX_REASONABLE {
        clear_active(conn);
        return Ok(json!({ "recovered": false, "discarded": true, "duration": duration }));
    }

    let Some((code, title, _)) = course_info(conn, &course_id)? else {
        // The subject was deleted while the session was open - drop the orphan.
        clear_active(conn);
        return Ok(json!({ "recovered": false, "discarded": true }));
    };

    let tx = conn.transaction()?;
    tx.execute("INSERT INTO study_sessions (course_id, duration) VALUES (?, ?)", params![course_id, duration])?;
    tx.execute("UPDATE courses SET total_seconds = total_seconds + ? WHERE id = ?", params![duration, course_id])?;
    tx.execute("DELETE FROM active_session WHERE id = 1", [])?;
    tx.commit()?;

    Ok(json!({ "recovered": true, "duration": duration, "courseTitle": title, "courseCode": code }))
}

// ---------- Runtime: the ticking thread and the bridge to windows ----------

pub const MAIN_LABEL: &str = "main";
pub const MINI_LABEL: &str = "mini";

// Sends the current state to every window, the tray and the floating widget.
pub fn broadcast(app: &AppHandle, snap: &Value) {
    let _ = app.emit("timer-state", snap.clone());
    crate::tray::update(app, snap);
    if snap["isStudying"] == Value::Bool(false) {
        crate::destroy_mini_widget(app);
    }
}

fn main_focused(app: &AppHandle) -> bool {
    app.get_webview_window(MAIN_LABEL).and_then(|w| w.is_focused().ok()).unwrap_or(false)
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
}

// Plays the Windows "Reminder" sound, which people can change or mute in
// Sound settings like any other system sound.
#[cfg(windows)]
fn play_chime() {
    use std::sync::OnceLock;
    use windows_sys::Win32::Media::Audio::{PlaySoundW, SND_ALIAS, SND_ASYNC, SND_NODEFAULT};
    static NAME: OnceLock<Vec<u16>> = OnceLock::new();
    let name = NAME.get_or_init(|| "Notification.Reminder\0".encode_utf16().collect());
    unsafe {
        PlaySoundW(name.as_ptr(), std::ptr::null_mut(), SND_ALIAS | SND_ASYNC | SND_NODEFAULT);
    }
}

#[cfg(not(windows))]
fn play_chime() {}

struct NotifyPrefs {
    pomodoro: bool,
    away: bool,
    session: bool,
    sound: bool,
}

impl NotifyPrefs {
    fn read(app: &AppHandle) -> NotifyPrefs {
        let get = |(key, default): (&str, bool)| {
            app.try_state::<Db>()
                .and_then(|db| db.0.lock().ok().map(|c| db::setting_bool(&c, key, default)))
                .unwrap_or(default)
        };
        NotifyPrefs { pomodoro: get(NOTIFY_POMODORO), away: get(NOTIFY_AWAY), session: get(NOTIFY_SESSION), sound: get(SOUND) }
    }
}

fn short_duration(secs: i64) -> String {
    if secs < 60 {
        format!("{secs} sec")
    } else if secs < 3600 {
        format!("{} min", secs / 60)
    } else {
        format!("{}h {}m", secs / 3600, (secs % 3600) / 60)
    }
}

// The page shows a toast for each event. A desktop notification covers the case
// where the window can't be seen. Called with no locks held: it reads settings.
pub fn publish_events(app: &AppHandle, events: &[Value]) {
    if events.is_empty() {
        return;
    }
    let prefs = NotifyPrefs::read(app);
    let focused = main_focused(app);
    for ev in events {
        let _ = app.emit("timer-event", ev.clone());
        let kind = ev["kind"].as_str().unwrap_or("");
        if prefs.sound && matches!(kind, "pomodoro-complete" | "break-over") {
            play_chime();
        }
        let wanted = match kind {
            "pomodoro-complete" | "break-over" => prefs.pomodoro,
            "idle-return" => prefs.away,
            "started" | "stopped" => prefs.session,
            _ => false,
        };
        if focused || !wanted {
            continue;
        }
        let code = ev["courseCode"].as_str().unwrap_or("");
        match ev["kind"].as_str() {
            Some("pomodoro-complete") if ev["autoStarted"] == Value::Bool(true) => notify(
                app,
                "Pomodoro complete",
                &format!("{} added to {code}. The next one has started.", short_duration(ev["duration"].as_i64().unwrap_or(0))),
            ),
            Some("pomodoro-complete") => {
                let brk = ev["breakSecs"].as_i64().unwrap_or(0);
                let body = if brk > 0 {
                    format!("{} added to {code}. Take a {}-minute break.", short_duration(ev["duration"].as_i64().unwrap_or(0)), brk / 60)
                } else {
                    format!("{} added to {code}.", short_duration(ev["duration"].as_i64().unwrap_or(0)))
                };
                notify(app, "Pomodoro complete", &body);
            }
            Some("started") => notify(app, "Timer started", &format!("Timing {code}")),
            Some("break-over") if ev["autoStarted"] == Value::Bool(true) => {
                notify(app, "Break's over", &format!("The next Pomodoro for {code} has started."))
            }
            Some("break-over") => notify(app, "Break's over", "Ready for the next Pomodoro?"),
            Some("idle-return") => notify(
                app,
                "Welcome back",
                &format!(
                    "You were away for {} while timing {code}. Open inmo to keep or remove that time.",
                    short_duration(ev["awaySecs"].as_i64().unwrap_or(0))
                ),
            ),
            Some("stopped") if ev["saved"] == Value::Bool(true) => notify(
                app,
                "Session saved",
                &format!("{} added to {code}", short_duration(ev["duration"].as_i64().unwrap_or(0))),
            ),
            _ => {}
        }
    }
}

// Locks the timer then the database, in that order everywhere, runs `f`, then
// publishes the resulting state and events.
pub fn with_timer<T>(
    app: &AppHandle,
    f: impl FnOnce(&mut TimerState, &mut Connection, i64) -> Result<(T, Vec<Value>), String>,
) -> Result<T, String> {
    let timer = app.state::<Timer>();
    let db = app.state::<Db>();
    let (out, events, snap) = {
        let mut state = timer.0.lock().map_err(db::err)?;
        let mut conn = db.0.lock().map_err(db::err)?;
        let now = now_ms();
        let (out, events) = f(&mut state, &mut conn, now)?;
        let snap = state.snapshot(&conn, now);
        (out, events, snap)
    };
    broadcast(app, &snap);
    publish_events(app, &events);
    Ok(out)
}

pub fn snapshot_now(app: &AppHandle) -> Value {
    with_timer(app, |s, c, now| Ok((s.snapshot(c, now), vec![]))).unwrap_or(Value::Null)
}

// Starts the timer if it's idle, using the subject and mode last picked in the
// window; stops it otherwise. Used by the tray and the global shortcut.
pub fn toggle(app: &AppHandle) -> Result<(), String> {
    with_timer(app, |state, conn, now| {
        if state.phase == Phase::Focus {
            let ev = stop(state, conn, now)?;
            return Ok(((), vec![ev]));
        }
        let mode = Mode::parse(&db::get_setting_value(conn, "timer_mode").ok().flatten().unwrap_or_default());
        let picked = db::get_setting_value(conn, "active_course_id").ok().flatten();
        let course_id: Option<String> = picked
            .filter(|id| matches!(course_info(conn, id), Ok(Some((_, _, false)))))
            .or_else(|| {
                conn.query_row(
                    "SELECT id FROM courses WHERE COALESCE(archived, 0) = 0 ORDER BY rowid LIMIT 1",
                    [],
                    |r| r.get(0),
                )
                .optional()
                .ok()
                .flatten()
            });
        let Some(course_id) = course_id else {
            return Err("Add a subject first".into());
        };
        start(state, conn, &course_id, mode, now)?;
        Ok(((), vec![json!({ "kind": "started", "courseCode": state.course_code })]))
    })
}

pub fn spawn_ticker(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_shown: Option<(i64, Phase)> = None;
        let mut last_idle_check = 0;
        loop {
            std::thread::sleep(Duration::from_millis(250));
            let now = now_ms();
            // Asking Windows for the idle time is cheap, but once every 2s is plenty.
            let idle_ms = if now - last_idle_check >= 2000 {
                last_idle_check = now;
                crate::idle::idle_ms()
            } else {
                None
            };
            let timer = app.state::<Timer>();
            let db = app.state::<Db>();
            let (events, snap, changed) = {
                let (Ok(mut state), Ok(mut conn)) = (timer.0.lock(), db.0.lock()) else { continue };
                if state.phase == Phase::Idle && last_shown.map_or(false, |(_, p)| p == Phase::Idle) {
                    continue;
                }
                let events = tick(&mut state, &mut conn, now, idle_ms);
                let key = (state.shown_secs(now), state.phase);
                let changed = last_shown != Some(key) || !events.is_empty();
                last_shown = Some(key);
                let snap = if changed { state.snapshot(&conn, now) } else { Value::Null };
                (events, snap, changed)
            };
            if changed {
                broadcast(&app, &snap);
            }
            publish_events(&app, &events);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{set_setting_value, test_conn};

    fn conn_with_course() -> Connection {
        let conn = test_conn();
        conn.execute("INSERT INTO courses (id, title, code, total_seconds) VALUES ('c1', 'Algorithms', 'CS101', 0)", [])
            .unwrap();
        conn
    }

    fn total(conn: &Connection) -> i64 {
        conn.query_row("SELECT total_seconds FROM courses WHERE id = 'c1'", [], |r| r.get(0)).unwrap()
    }

    fn session_count(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM study_sessions", [], |r| r.get(0)).unwrap()
    }

    fn active_rows(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM active_session", [], |r| r.get(0)).unwrap()
    }

    const T0: i64 = 1_800_000_000_000;

    #[test]
    fn stopwatch_logs_its_time_on_stop() {
        let mut conn = conn_with_course();
        let mut s = TimerState::default();
        start(&mut s, &conn, "c1", Mode::Stopwatch, T0).unwrap();
        assert_eq!(active_rows(&conn), 1);
        let ev = stop(&mut s, &mut conn, T0 + 125_000).unwrap();
        assert_eq!(ev["saved"], true);
        assert_eq!(ev["duration"], 125);
        assert_eq!(total(&conn), 125);
        assert_eq!(active_rows(&conn), 0);
        assert_eq!(s.phase, Phase::Idle);
    }

    #[test]
    fn short_sessions_are_not_logged() {
        let mut conn = conn_with_course();
        let mut s = TimerState::default();
        start(&mut s, &conn, "c1", Mode::Stopwatch, T0).unwrap();
        let ev = stop(&mut s, &mut conn, T0 + 30_000).unwrap();
        assert_eq!(ev["saved"], false);
        assert_eq!(session_count(&conn), 0);
        assert_eq!(active_rows(&conn), 0);
    }

    #[test]
    fn archived_subjects_cannot_be_timed() {
        let conn = conn_with_course();
        conn.execute("UPDATE courses SET archived = 1", []).unwrap();
        let mut s = TimerState::default();
        assert!(start(&mut s, &conn, "c1", Mode::Stopwatch, T0).is_err());
        assert!(start(&mut s, &conn, "missing", Mode::Stopwatch, T0).is_err());
    }

    #[test]
    fn heartbeat_is_written_every_30_seconds() {
        let mut conn = conn_with_course();
        let mut s = TimerState::default();
        start(&mut s, &conn, "c1", Mode::Stopwatch, T0).unwrap();
        tick(&mut s, &mut conn, T0 + 29_000, None);
        let hb: i64 = conn.query_row("SELECT last_heartbeat FROM active_session", [], |r| r.get(0)).unwrap();
        assert_eq!(hb, T0);
        tick(&mut s, &mut conn, T0 + 31_000, None);
        let hb: i64 = conn.query_row("SELECT last_heartbeat FROM active_session", [], |r| r.get(0)).unwrap();
        assert_eq!(hb, T0 + 31_000);
    }

    #[test]
    fn pomodoro_cycle_uses_configured_lengths_and_long_breaks() {
        let mut conn = conn_with_course();
        set_setting_value(&conn, FOCUS_MIN.0, "2").unwrap();
        set_setting_value(&conn, SHORT_BREAK_MIN.0, "1").unwrap();
        set_setting_value(&conn, LONG_BREAK_MIN.0, "3").unwrap();
        set_setting_value(&conn, LONG_BREAK_EVERY.0, "2").unwrap();
        let mut s = TimerState::default();
        let mut now = T0;

        // First pomodoro -> short break.
        start(&mut s, &conn, "c1", Mode::Pomodoro, now).unwrap();
        assert_eq!(s.target_secs, 120);
        now += 120_000;
        let ev = tick(&mut s, &mut conn, now, None);
        assert_eq!(ev[0]["kind"], "pomodoro-complete");
        assert_eq!(ev[0]["breakSecs"], 60);
        assert_eq!(s.phase, Phase::Break);
        assert!(!s.long_break);
        assert_eq!(total(&conn), 120);
        assert_eq!(active_rows(&conn), 0);
        now += 60_000;
        let ev = tick(&mut s, &mut conn, now, None);
        assert_eq!(ev[0]["kind"], "break-over");
        assert_eq!(s.phase, Phase::Idle);

        // Second pomodoro -> long break, and the count starts over.
        start(&mut s, &conn, "c1", Mode::Pomodoro, now).unwrap();
        now += 120_000;
        let ev = tick(&mut s, &mut conn, now, None);
        assert_eq!(ev[0]["longBreak"], true);
        assert_eq!(ev[0]["breakSecs"], 180);
        assert_eq!(s.pomodoros_done, 0);
        assert_eq!(total(&conn), 240);
    }

    #[test]
    fn auto_continue_starts_the_next_pomodoro_after_a_break() {
        let mut conn = conn_with_course();
        set_setting_value(&conn, FOCUS_MIN.0, "2").unwrap();
        set_setting_value(&conn, SHORT_BREAK_MIN.0, "1").unwrap();
        set_setting_value(&conn, AUTO_CONTINUE.0, "true").unwrap();
        let mut s = TimerState::default();
        let mut now = T0;
        start(&mut s, &conn, "c1", Mode::Pomodoro, now).unwrap();
        now += 120_000;
        tick(&mut s, &mut conn, now, None);
        assert_eq!(s.phase, Phase::Break);
        now += 60_000;
        let ev = tick(&mut s, &mut conn, now, None);
        assert_eq!(ev[0]["kind"], "break-over");
        assert_eq!(ev[0]["autoStarted"], true);
        assert_eq!(s.phase, Phase::Focus);
        assert_eq!(s.start_ms, now);
        assert_eq!(s.pomodoros_done, 1, "the cycle count carries on");
        assert_eq!(active_rows(&conn), 1, "crash recovery covers the new Pomodoro");

        // Archived during the break: the cycle stops instead.
        now += 120_000;
        tick(&mut s, &mut conn, now, None);
        conn.execute("UPDATE courses SET archived = 1", []).unwrap();
        now += 60_000;
        let ev = tick(&mut s, &mut conn, now, None);
        assert_eq!(ev[0]["autoStarted"], false);
        assert_eq!(s.phase, Phase::Idle);
    }

    #[test]
    fn auto_continue_with_no_break_goes_straight_on() {
        let mut conn = conn_with_course();
        set_setting_value(&conn, FOCUS_MIN.0, "2").unwrap();
        set_setting_value(&conn, SHORT_BREAK_MIN.0, "0").unwrap();
        set_setting_value(&conn, AUTO_CONTINUE.0, "true").unwrap();
        let mut s = TimerState::default();
        start(&mut s, &conn, "c1", Mode::Pomodoro, T0).unwrap();
        let ev = tick(&mut s, &mut conn, T0 + 120_000, None);
        assert_eq!(ev[0]["kind"], "pomodoro-complete");
        assert_eq!(ev[0]["autoStarted"], true);
        assert_eq!(s.phase, Phase::Focus);
        assert_eq!(total(&conn), 120);
    }

    #[test]
    fn without_auto_continue_the_timer_waits() {
        let mut conn = conn_with_course();
        set_setting_value(&conn, FOCUS_MIN.0, "2").unwrap();
        set_setting_value(&conn, SHORT_BREAK_MIN.0, "0").unwrap();
        let mut s = TimerState::default();
        start(&mut s, &conn, "c1", Mode::Pomodoro, T0).unwrap();
        let ev = tick(&mut s, &mut conn, T0 + 120_000, None);
        assert_eq!(ev[0]["autoStarted"], false);
        assert_eq!(s.phase, Phase::Idle);
    }

    #[test]
    fn stopping_a_pomodoro_early_logs_the_part_done() {
        let mut conn = conn_with_course();
        let mut s = TimerState::default();
        start(&mut s, &conn, "c1", Mode::Pomodoro, T0).unwrap();
        let ev = stop(&mut s, &mut conn, T0 + 600_000).unwrap();
        assert_eq!(ev["duration"], 600);
        assert_eq!(total(&conn), 600);
    }

    #[test]
    fn idle_time_can_be_removed() {
        let mut conn = conn_with_course();
        set_setting_value(&conn, IDLE_MIN.0, "10").unwrap();
        let mut s = TimerState::default();
        start(&mut s, &conn, "c1", Mode::Stopwatch, T0).unwrap();

        // Last input 5 minutes in, noticed once 10 minutes pass with none.
        let last_input = T0 + 5 * 60_000;
        let now = last_input + 10 * 60_000;
        assert!(tick(&mut s, &mut conn, now, Some((now - last_input) as u64)).is_empty());
        assert_eq!(s.away, Some(Away { from_ms: last_input, back_ms: None }));

        // Back 30 minutes after the last input.
        let back = last_input + 30 * 60_000;
        let ev = tick(&mut s, &mut conn, back + 1000, Some(1000));
        assert_eq!(ev[0]["kind"], "idle-return");
        assert_eq!(ev[0]["awaySecs"], 30 * 60);

        resolve_idle(&mut s, &conn, false).unwrap();
        let ev = stop(&mut s, &mut conn, back + 60_000).unwrap();
        // 5 min before leaving + 1 min after coming back.
        assert_eq!(ev["duration"], 6 * 60);
    }

    #[test]
    fn idle_time_can_be_kept_and_detection_can_be_off() {
        let mut conn = conn_with_course();
        let mut s = TimerState::default();
        start(&mut s, &conn, "c1", Mode::Stopwatch, T0).unwrap();
        let now = T0 + 20 * 60_000;
        tick(&mut s, &mut conn, now, Some(15 * 60_000));
        tick(&mut s, &mut conn, now + 1000, Some(500));
        resolve_idle(&mut s, &conn, true).unwrap();
        assert_eq!(stop(&mut s, &mut conn, now + 1000).unwrap()["duration"], 20 * 60 + 1);

        set_setting_value(&conn, IDLE_MIN.0, "0").unwrap();
        start(&mut s, &conn, "c1", Mode::Stopwatch, T0).unwrap();
        tick(&mut s, &mut conn, now, Some(15 * 60_000));
        assert_eq!(s.away, None);
    }

    fn put_active(conn: &Connection, start: i64, mode: &str, heartbeat: Option<i64>) {
        conn.execute(
            "INSERT INTO active_session (id, course_id, start_timestamp, mode, last_heartbeat) VALUES (1, 'c1', ?, ?, ?)",
            params![start, mode, heartbeat],
        )
        .unwrap();
    }

    #[test]
    fn recovery_credits_time_up_to_the_last_heartbeat() {
        let mut conn = conn_with_course();
        put_active(&conn, T0, "stopwatch", Some(T0 + 600_000));
        let r = recover(&mut conn, T0 + 5 * 3600_000).unwrap();
        assert_eq!(r["recovered"], true);
        assert_eq!(r["duration"], 600);
        assert_eq!(r["courseCode"], "CS101");
        assert_eq!(total(&conn), 600);
        assert_eq!(active_rows(&conn), 0);
        assert_eq!(recover(&mut conn, T0).unwrap()["recovered"], false);
    }

    #[test]
    fn recovery_caps_pomodoros_at_the_focus_length() {
        let mut conn = conn_with_course();
        set_setting_value(&conn, FOCUS_MIN.0, "50").unwrap();
        put_active(&conn, T0, "pomodoro", Some(T0 + 2 * 3600_000));
        assert_eq!(recover(&mut conn, T0).unwrap()["duration"], 50 * 60);
    }

    #[test]
    fn recovery_discards_unreliable_sessions() {
        for (hb, why) in [(T0 + 20_000, "too short"), (T0 + 13 * 3600_000, "too long")] {
            let mut conn = conn_with_course();
            put_active(&conn, T0, "stopwatch", Some(hb));
            let r = recover(&mut conn, T0).unwrap();
            assert_eq!(r["discarded"], true, "{why}");
            assert_eq!(session_count(&conn), 0, "{why}");
            assert_eq!(active_rows(&conn), 0, "{why}");
        }
    }

    #[test]
    fn recovery_drops_sessions_of_deleted_subjects() {
        let mut conn = conn_with_course();
        put_active(&conn, T0, "stopwatch", Some(T0 + 600_000));
        conn.execute("DELETE FROM courses", []).unwrap();
        let r = recover(&mut conn, T0).unwrap();
        assert_eq!(r["discarded"], true);
        assert_eq!(session_count(&conn), 0);
    }

    #[test]
    fn clock_formats() {
        assert_eq!(format_clock(3725, true), "01:02:05");
        assert_eq!(format_clock(1500, false), "25:00");
        assert_eq!(format_clock(5400, false), "90:00");
    }
}
