// The SQLite database: where it lives, its schema and migrations, settings, and
// the snapshots kept in backups/.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::types::ValueRef;
use rusqlite::{Connection, OptionalExtension, ToSql};
use serde_json::{json, Map, Value};

pub struct Db(pub Mutex<Connection>);

pub type CmdResult<T> = Result<T, String>;

pub fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

// Same file the Electron builds used (%APPDATA%\inmo), so history carried over.
// INMO_DB_PATH overrides it for testing.
pub fn db_path() -> PathBuf {
    if let Ok(p) = std::env::var("INMO_DB_PATH") {
        return PathBuf::from(p);
    }
    let base = std::env::var("APPDATA").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("."));
    base.join("inmo").join("academic_steam_spotify.db")
}

pub fn backups_dir() -> PathBuf {
    db_path().parent().map(|p| p.join("backups")).unwrap_or_else(|| PathBuf::from("backups"))
}

pub fn open_db() -> rusqlite::Result<Connection> {
    let path = db_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = Connection::open(&path)?;
    backup_before_first_tauri_launch(&conn);
    migrate(&conn)?;
    weekly_backup(&conn);
    Ok(conn)
}

// Creates any missing tables and columns. Safe to run on every launch, and again
// after restoring a backup made by an older version.
pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
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
        // 1.2: archived subjects keep their history but leave the library and timer.
        "ALTER TABLE courses ADD COLUMN archived INTEGER DEFAULT 0",
    ] {
        if let Err(e) = conn.execute(sql, []) {
            if !e.to_string().to_lowercase().contains("duplicate column") {
                eprintln!("Migration failed ({sql}): {e}");
            }
        }
    }
    Ok(())
}

// Runs a query and returns each row as a JSON object keyed by column name.
pub fn query_json(conn: &Connection, sql: &str, args: &[&dyn ToSql]) -> rusqlite::Result<Vec<Value>> {
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

// ---------- Settings ----------

pub fn get_setting_value(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM settings WHERE key = ?", [key], |r| r.get(0))
        .optional()
        .map(Option::flatten)
}

pub fn set_setting_value(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, value],
    )?;
    Ok(())
}

// A whole-number setting, falling back to `default` when unset or not a number,
// and clamped to [min, max].
pub fn setting_i64(conn: &Connection, key: &str, default: i64, min: i64, max: i64) -> i64 {
    get_setting_value(conn, key)
        .ok()
        .flatten()
        .and_then(|v| v.trim().parse::<i64>().ok())
        .unwrap_or(default)
        .clamp(min, max)
}

pub fn setting_bool(conn: &Connection, key: &str, default: bool) -> bool {
    match get_setting_value(conn, key).ok().flatten().as_deref() {
        Some("true") => true,
        Some("false") => false,
        _ => default,
    }
}

// ---------- Backups ----------

// A consistent copy of the open database. VACUUM INTO works while it's in use.
pub fn snapshot(conn: &Connection, dest: &Path) -> rusqlite::Result<()> {
    if let Some(dir) = dest.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::remove_file(dest);
    conn.execute("VACUUM INTO ?", [dest.to_string_lossy()])?;
    Ok(())
}

fn has_tables(conn: &Connection) -> bool {
    conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'", [], |r| r.get::<_, i64>(0))
        .unwrap_or(0)
        > 0
}

pub fn local_today(conn: &Connection) -> String {
    conn.query_row("SELECT date('now', 'localtime')", [], |r| r.get(0)).unwrap_or_else(|_| "today".into())
}

// The first time the Tauri build opens a database the Electron build wrote, keep
// a copy before changing anything, so the switch can be undone.
fn backup_before_first_tauri_launch(conn: &Connection) {
    let backup = backups_dir().join("academic_steam_spotify-before-tauri.db");
    if backup.exists() || !has_tables(conn) {
        return;
    }
    if let Err(e) = snapshot(conn, &backup) {
        eprintln!("Backup before first Tauri launch failed: {e}");
    }
}

pub const AUTO_BACKUPS_KEPT: usize = 8;
const AUTO_BACKUP_EVERY_DAYS: u64 = 7;

pub fn auto_backups_dir() -> PathBuf {
    backups_dir().join("auto")
}

// Weekly snapshot into backups/auto/inmo-YYYY-MM-DD.db, keeping the newest 8.
fn weekly_backup(conn: &Connection) {
    let dir = auto_backups_dir();
    let newest_age = list_auto_backups(&dir)
        .first()
        .and_then(|p| p.metadata().ok())
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.elapsed().ok());
    let due = newest_age.map_or(true, |age| age.as_secs() >= AUTO_BACKUP_EVERY_DAYS * 24 * 3600);
    if !due || !has_tables(conn) {
        return;
    }
    let dest = dir.join(format!("inmo-{}.db", local_today(conn)));
    if let Err(e) = snapshot(conn, &dest) {
        eprintln!("Weekly backup failed: {e}");
        return;
    }
    prune_auto_backups(&dir, AUTO_BACKUPS_KEPT);
}

// Newest first. Names sort by date, so a name sort is enough.
pub fn list_auto_backups(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| {
                    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    name.starts_with("inmo-") && name.ends_with(".db")
                })
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    files.reverse();
    files
}

pub fn prune_auto_backups(dir: &Path, keep: usize) {
    for old in list_auto_backups(dir).into_iter().skip(keep) {
        let _ = std::fs::remove_file(old);
    }
}

#[cfg(test)]
pub fn test_conn() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    conn
}
