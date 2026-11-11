// The tray icon, the global start/stop shortcut, and launching with Windows.

use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State, Wry};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::db::{self, err, CmdResult, Db};

const TRAY_ID: &str = "main";
pub const SHORTCUT_SETTING: &str = "global_shortcut_enabled";
pub const SHORTCUT_LABEL: &str = "Ctrl+Alt+S";
// Passed by the autostart entry, so inmo starts out of the way.
pub const MINIMIZED_ARG: &str = "--minimized";

fn shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyS)
}

struct TrayState {
    toggle: MenuItem<Wry>,
    last: Mutex<(String, String)>, // (menu text, tooltip) last shown
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "toggle", "Start timer", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Show inmo", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit inmo", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle, &show, &PredefinedMenuItem::separator(app)?, &quit])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("inmo")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => toggle_with_feedback(app),
            "show" => crate::focus_main_window(app),
            "quit" => crate::quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                crate::focus_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    app.manage(TrayState { toggle, last: Mutex::new((String::new(), String::new())) });
    Ok(())
}

// Keeps the menu's Start/Stop item and the hover text in step with the timer.
pub fn update(app: &AppHandle, snap: &Value) {
    let Some(tray_state) = app.try_state::<TrayState>() else { return };
    let studying = snap["isStudying"] == Value::Bool(true);
    let text = match snap["phase"].as_str() {
        Some("break") => "Skip break",
        _ if studying => "Stop timer",
        _ => "Start timer",
    }
    .to_string();
    let tooltip = if studying {
        format!("inmo · {} · {}", snap["timeStr"].as_str().unwrap_or(""), snap["courseLabel"].as_str().unwrap_or(""))
    } else {
        "inmo".to_string()
    };
    let Ok(mut last) = tray_state.last.lock() else { return };
    if last.0 != text {
        let _ = tray_state.toggle.set_text(&text);
    }
    if last.1 != tooltip {
        if let Some(tray) = app.tray_by_id(TRAY_ID) {
            let _ = tray.set_tooltip(Some(&tooltip));
        }
    }
    *last = (text, tooltip);
}

fn toggle_with_feedback(app: &AppHandle) {
    if let Err(message) = crate::timer::toggle(app) {
        use tauri_plugin_notification::NotificationExt;
        let _ = app.notification().builder().title("inmo").body(&message).show();
    }
}

// ---------- Global shortcut ----------

pub fn shortcut_plugin() -> tauri::plugin::TauriPlugin<Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                toggle_with_feedback(app);
            }
        })
        .build()
}

fn apply_shortcut(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let gs = app.global_shortcut();
    let registered = gs.is_registered(shortcut());
    if enabled && !registered {
        gs.register(shortcut())
            .map_err(|e| format!("{SHORTCUT_LABEL} couldn't be registered. Another app may be using it. ({e})"))?;
    } else if !enabled && registered {
        gs.unregister(shortcut()).map_err(err)?;
    }
    Ok(())
}

pub fn setup_shortcut(app: &AppHandle) {
    let enabled = app.try_state::<Db>().and_then(|db| db.0.lock().ok().map(|c| db::setting_bool(&c, SHORTCUT_SETTING, true)));
    if let Err(e) = apply_shortcut(app, enabled.unwrap_or(true)) {
        eprintln!("{e}");
    }
}

#[tauri::command(async)]
pub fn get_shortcut(app: AppHandle) -> CmdResult<Value> {
    Ok(json!({
        "label": SHORTCUT_LABEL,
        "enabled": app.global_shortcut().is_registered(shortcut()),
    }))
}

#[tauri::command(async)]
pub fn set_shortcut_enabled(app: AppHandle, db: State<'_, Db>, enabled: bool) -> CmdResult<Value> {
    apply_shortcut(&app, enabled)?;
    {
        let conn = db.0.lock().map_err(err)?;
        db::set_setting_value(&conn, SHORTCUT_SETTING, if enabled { "true" } else { "false" }).map_err(err)?;
    }
    get_shortcut(app)
}

// ---------- Start with Windows ----------

#[tauri::command(async)]
pub fn get_autostart(app: AppHandle) -> CmdResult<bool> {
    app.autolaunch().is_enabled().map_err(err)
}

#[tauri::command(async)]
pub fn set_autostart(app: AppHandle, enabled: bool) -> CmdResult<bool> {
    let al = app.autolaunch();
    if enabled { al.enable() } else { al.disable() }.map_err(err)?;
    al.is_enabled().map_err(err)
}
