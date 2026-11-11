// Auto-updates from GitHub Releases. A new version downloads in the background
// and installs when inmo closes, so it never interrupts a session; the page can
// also offer "Restart now".

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::db::{err, CmdResult};

pub struct PendingUpdate(pub Mutex<Option<(Update, Vec<u8>)>>);

const FIRST_CHECK_DELAY: Duration = Duration::from_secs(15);
const CHECK_EVERY: Duration = Duration::from_secs(6 * 3600);

// Debug builds skip this unless INMO_UPDATE_ENDPOINT points at a test server.
fn enabled() -> bool {
    !cfg!(debug_assertions) || std::env::var("INMO_UPDATE_ENDPOINT").is_ok()
}

pub fn spawn_checker(app: AppHandle) {
    if !enabled() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_DELAY).await;
        loop {
            if let Err(e) = check_once(&app).await {
                eprintln!("Update check failed: {e}");
            }
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

// A check (and its download) in progress, so the background check and
// "Check now" never download the same update twice.
static CHECKING: AtomicBool = AtomicBool::new(false);

struct CheckingGuard;
impl Drop for CheckingGuard {
    fn drop(&mut self) {
        CHECKING.store(false, Ordering::SeqCst);
    }
}

fn pending_info(app: &AppHandle) -> Result<Option<Value>, String> {
    let pending = app.state::<PendingUpdate>();
    let guard = pending.0.lock().map_err(err)?;
    Ok(guard.as_ref().map(|(u, _)| json!({ "version": u.version, "notes": u.body })))
}

// Checks for a new version and downloads it. Returns the version that is ready
// to install, if any (including one downloaded earlier).
async fn check_once(app: &AppHandle) -> Result<Option<Value>, String> {
    if let Some(info) = pending_info(app)? {
        return Ok(Some(info));
    }
    if CHECKING.swap(true, Ordering::SeqCst) {
        return Err("inmo is already checking for updates. Try again in a minute.".into());
    }
    let _guard = CheckingGuard;
    let mut builder = app.updater_builder();
    if let Ok(url) = std::env::var("INMO_UPDATE_ENDPOINT") {
        builder = builder.endpoints(vec![url.parse().map_err(err)?]).map_err(err)?;
    }
    let Some(update) = builder.build().map_err(err)?.check().await.map_err(err)? else {
        return Ok(None);
    };
    let bytes = update.download(|_, _| {}, || {}).await.map_err(err)?;
    let info = json!({ "version": update.version, "notes": update.body });
    *app.state::<PendingUpdate>().0.lock().map_err(err)? = Some((update, bytes));
    let _ = app.emit("update-ready", info.clone());
    Ok(Some(info))
}

// "Check now" in Settings. Waits for the download too, so a "ready" answer
// means "Restart now" will work straight away.
#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> CmdResult<Value> {
    if !enabled() {
        return Err("Update checks are off in development builds.".into());
    }
    let ready = check_once(&app).await.map_err(|e| {
        if e.contains("already checking") {
            e
        } else {
            format!("Check your internet connection and try again. ({e})")
        }
    })?;
    Ok(match ready {
        Some(info) => json!({ "status": "ready", "version": info["version"] }),
        None => json!({ "status": "up-to-date" }),
    })
}

// Runs the downloaded installer, which closes inmo and opens the new version.
// Returns false if there's nothing to install.
pub fn install_pending(app: &AppHandle) -> bool {
    let Some(pending) = app.try_state::<PendingUpdate>() else { return false };
    let Some((update, bytes)) = pending.0.lock().ok().and_then(|mut p| p.take()) else { return false };
    match update.install(bytes) {
        Ok(()) => true,
        Err(e) => {
            eprintln!("Installing the update failed: {e}");
            false
        }
    }
}

#[tauri::command(async)]
pub fn get_update_status(app: AppHandle) -> CmdResult<Value> {
    Ok(pending_info(&app)?.unwrap_or(Value::Null))
}

// "Restart now": saves a running session, then installs.
#[tauri::command(async)]
pub fn install_update_now(app: AppHandle) -> CmdResult<()> {
    crate::stop_timer_for_exit(&app);
    if !install_pending(&app) {
        return Err("The update couldn't be installed. It will be tried again next time inmo starts.".into());
    }
    app.exit(0);
    Ok(())
}
