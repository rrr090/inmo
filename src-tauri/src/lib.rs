// inmo's backend: owns the SQLite database, the timer, the windows, the tray and
// updates. The page reaches all of it through window.api (src/tauri-api.js).

mod commands;
mod data_io;
mod db;
mod idle;
mod timer;
mod trash;
mod tray;
mod updater;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use commands::Recovery;
use db::{now_ms, Db};
use timer::{Phase, Timer, TimerState, MAIN_LABEL, MINI_LABEL};
use updater::PendingUpdate;

const MINI_WIDGET_SETTING_KEY: &str = "mini_widget_on_minimize";
// The close button hides the window to the tray instead of quitting.
const CLOSE_TO_TRAY_KEY: &str = "close_to_tray";

fn setting_on(app: &AppHandle, key: &str) -> bool {
    // try_state: the main window exists slightly before setup manages the database.
    app.try_state::<Db>()
        .and_then(|db| db.0.lock().ok().map(|c| db::setting_bool(&c, key, false)))
        .unwrap_or(false)
}

// Shows the floating timer when the main window goes out of sight (minimized or
// hidden to the tray) during a session, if that's turned on.
fn widget_if_studying(app: &AppHandle) {
    let studying = app
        .try_state::<Timer>()
        .and_then(|t| t.0.lock().ok().map(|s| s.phase != Phase::Idle))
        .unwrap_or(false);
    if studying && setting_on(app, MINI_WIDGET_SETTING_KEY) {
        let app = app.clone();
        // Creating a window from inside the event loop's own callback can
        // deadlock on Windows, so hand it off.
        tauri::async_runtime::spawn(async move {
            show_mini_widget(&app);
            // Send the current time right away rather than on the next tick.
            let snap = timer::snapshot_now(&app);
            timer::broadcast(&app, &snap);
        });
    }
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
    // Bottom-right corner of the primary screen's work area.
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

pub fn destroy_mini_widget(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MINI_LABEL) {
        let _ = w.destroy();
    }
}

pub fn focus_main_window(app: &AppHandle) {
    if let Some(main) = app.get_webview_window(MAIN_LABEL) {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
}

#[tauri::command(async)]
fn restore_main_window(app: AppHandle) {
    focus_main_window(&app);
    destroy_mini_widget(&app);
}

// The widget's Stop button. The page hears about it through the usual timer-event.
#[tauri::command(async)]
fn stop_timer_from_widget(app: AppHandle) -> Result<(), String> {
    timer::with_timer(&app, |state, conn, now| {
        let ev = timer::stop(state, conn, now)?;
        Ok(((), vec![ev]))
    })?;
    focus_main_window(&app);
    Ok(())
}

// ---------- Quitting ----------

// Closing inmo saves a running session instead of leaving it to crash recovery.
pub fn stop_timer_for_exit(app: &AppHandle) {
    let (Some(timer), Some(db)) = (app.try_state::<Timer>(), app.try_state::<Db>()) else { return };
    let (Ok(mut state), Ok(mut conn)) = (timer.0.lock(), db.0.lock()) else { return };
    if state.phase != Phase::Idle {
        if let Err(e) = timer::stop(&mut state, &mut conn, now_ms()) {
            eprintln!("Failed to save the running session on exit: {e}");
        }
    }
}

// Installs a downloaded update on the way out, like the Electron build did.
// The About links in Settings. Only these fixed addresses can be opened.
#[tauri::command(async)]
fn open_link(app: AppHandle, which: String) -> db::CmdResult<()> {
    use tauri_plugin_opener::OpenerExt;
    const REPO: &str = "https://github.com/rrr090/inmo";
    let url = match which.as_str() {
        "repo" => REPO.to_string(),
        "releases" => format!("{REPO}/releases"),
        "issues" => format!("{REPO}/issues/new"),
        "author" => "https://github.com/rrr090".to_string(),
        _ => return Err("Unknown link".into()),
    };
    app.opener().open_url(url, None::<&str>).map_err(db::err)
}

pub fn quit(app: &AppHandle) {
    stop_timer_for_exit(app);
    destroy_mini_widget(app);
    updater::install_pending(app);
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Only one inmo at a time: a second copy would share the database and the
        // running session with the first. Registered first so a second launch
        // exits (after focusing the running window) before anything else runs.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| focus_main_window(app)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![tray::MINIMIZED_ARG]),
        ))
        .plugin(tray::shortcut_plugin())
        // Used from Rust only (open_link); the page has no permission to open anything itself.
        .plugin(tauri_plugin_opener::init())
        // Opened in setup, after the single-instance check, so a second copy never touches it.
        .setup(|app| {
            let mut conn = db::open_db()?;
            let recovery = timer::recover(&mut conn, now_ms()).unwrap_or_else(|e| {
                eprintln!("Crash recovery failed: {e}");
                serde_json::json!({ "recovered": false })
            });
            app.manage(Db(Mutex::new(conn)));
            app.manage(Timer(Mutex::new(TimerState::default())));
            app.manage(Recovery(Mutex::new(Some(recovery))));
            app.manage(PendingUpdate(Mutex::new(None)));
            app.manage(trash::Trash::default());

            let handle = app.handle().clone();
            tray::setup(&handle)?;
            tray::setup_shortcut(&handle);
            timer::spawn_ticker(handle.clone());
            updater::spawn_checker(handle.clone());

            if std::env::args().any(|a| a == tray::MINIMIZED_ARG) {
                if let Some(main) = app.get_webview_window(MAIN_LABEL) {
                    if setting_on(&handle, CLOSE_TO_TRAY_KEY) {
                        let _ = main.hide();
                    } else {
                        let _ = main.minimize();
                    }
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != MAIN_LABEL {
                return;
            }
            let app = window.app_handle().clone();
            match event {
                // Tauri has no minimize event; a resize that leaves the window minimized is one.
                WindowEvent::Resized(_) => {
                    if window.is_minimized().unwrap_or(false) {
                        widget_if_studying(&app);
                    }
                }
                WindowEvent::CloseRequested { api, .. } if setting_on(&app, CLOSE_TO_TRAY_KEY) => {
                    api.prevent_close();
                    let _ = window.hide();
                    widget_if_studying(&app);
                    // Say where inmo went, the first time per launch.
                    static TOLD: AtomicBool = AtomicBool::new(false);
                    if !TOLD.swap(true, Ordering::SeqCst) {
                        use tauri_plugin_notification::NotificationExt;
                        let _ = app
                            .notification()
                            .builder()
                            .title("inmo is still running")
                            .body("It's in the tray. Right-click the tray icon to quit.")
                            .show();
                    }
                }
                WindowEvent::Focused(true) => destroy_mini_widget(&app),
                WindowEvent::Destroyed => quit(&app),
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_courses,
            commands::add_course,
            commands::update_course,
            commands::delete_course,
            commands::set_course_archived,
            commands::reset_course_time,
            commands::set_course_goal,
            commands::get_history,
            commands::add_session,
            commands::update_session,
            commands::delete_session,
            commands::get_daily_stats,
            commands::get_sessions,
            commands::get_tasks,
            commands::add_task,
            commands::toggle_task,
            commands::delete_task,
            commands::undo_delete,
            commands::set_course_exam,
            commands::timer_set_note,
            open_link,
            commands::get_task_stats,
            commands::get_setting,
            commands::set_setting,
            commands::timer_get,
            commands::timer_start,
            commands::timer_stop,
            commands::timer_resolve_idle,
            commands::take_recovery_result,
            data_io::export_sessions_csv,
            data_io::import_sessions_csv,
            data_io::get_backup_info,
            data_io::backup_now,
            data_io::open_backups_folder,
            data_io::restore_backup,
            tray::get_shortcut,
            tray::set_shortcut_enabled,
            tray::get_autostart,
            tray::set_autostart,
            updater::get_update_status,
            updater::check_for_updates,
            updater::install_update_now,
            restore_main_window,
            stop_timer_from_widget,
        ])
        .run(tauri::generate_context!())
        .expect("error while running inmo");
}
