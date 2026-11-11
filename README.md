# inmo

A desktop study tracker for university courses. Time your study sessions per subject, keep a to-do list for each one, and see where your hours actually go. All your data stays on your machine.

[![Latest release](https://img.shields.io/github/v/release/rrr090/inmo?style=flat-square)](https://github.com/rrr090/inmo/releases/latest)
![Windows](https://img.shields.io/badge/Windows-0078d4?style=flat-square)
![Tauri](https://img.shields.io/badge/Tauri-24c8db?style=flat-square&logo=tauri&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-000000?style=flat-square&logo=rust&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-003b57?style=flat-square&logo=sqlite&logoColor=white)

![inmo analytics page showing summary stats, a 7-day focus trend with average, goal and previous-week lines, and an activity heatmap](docs/screenshot.png)

## Features

- **Focus timer:** stopwatch or 25-minute Pomodoro, logged against the subject you pick.
- **Subjects and tasks:** add, edit and remove courses, each with its own to-do list.
- **Analytics:** a 7/30/90-day focus trend (total or split by subject) with daily average, goal and previous-period lines, summary stats, week-over-week comparison, a 90-day activity heatmap, each subject's share of your time, weekday averages and a weekday × hour grid of when you study.
- **Goals and streaks:** a daily 2-hour target, optional weekly goals per subject, a running study streak and your longest streak ever.
- **Session history:** your 50 most recent sessions, with the option to delete any of them, and a CSV export of every session.
- **Floating timer:** an optional always-on-top widget that appears when you minimize the app, so you can see or stop the timer from anywhere.
- **Crash recovery:** a running session is saved as soon as it starts, so a crash or power cut doesn't lose your time.
- **One window:** opening inmo while it's already running brings the existing window forward instead of starting a second copy.

## Install

Download the latest `inmo_<version>_x64-setup.exe` from [Releases](https://github.com/rrr090/inmo/releases/latest) and run it. Windows is the only platform with a packaged build.

### Upgrading from 1.0.x

Versions up to 1.0.5 were built with Electron and won't update themselves to 1.1. To upgrade:

1. Close inmo.
2. Install `inmo_1.1.0_x64-setup.exe`.
3. Uninstall the old version from **Settings → Apps → Installed apps** (the entry named `inmo` with version 1.0.x).
4. If the `inmo` shortcut disappeared from the desktop or Start menu, run the 1.1 installer again to restore it. The old uninstaller removes shortcuts with that name.

Your subjects, sessions and tasks carry over automatically. 1.1 reads the same database file, and the first time it opens it, it saves a copy to `%APPDATA%\inmo\backups\academic_steam_spotify-before-tauri.db`. To go back, close inmo and copy that file over `%APPDATA%\inmo\academic_steam_spotify.db`.

## Why inmo moved from Electron to Tauri

Up to 1.0.5, inmo was an Electron app. Electron bundles a full copy of Chromium and Node.js with every app, which is a lot of weight for a study timer. In 1.1 the backend was rewritten in Rust on [Tauri](https://tauri.app), which renders the same interface with the WebView2 engine that already ships with Windows.

| | 1.0.5 (Electron) | 1.1.0 (Tauri) |
|---|---|---|
| Installer | 107 MB | 2.3 MB |
| Installed size | 378 MB | 5.4 MB |
| Backend | Node.js + `sqlite3` native module | Rust + `rusqlite` |

The interface and your data didn't change. The HTML, CSS and JavaScript are the same files, and the database is the same SQLite file in the same place.

What 1.1 doesn't have yet: **auto-updates**. Download new versions from Releases until the Tauri updater is wired in.

## Run from source

Requires [Node.js](https://nodejs.org) and [Rust](https://www.rust-lang.org/tools/install). WebView2 is already part of Windows 10 and 11.

```bash
git clone https://github.com/rrr090/inmo.git
cd inmo
npm install
npm start
```

To build the Windows installer into `src-tauri/target/release/bundle/nsis/`:

```bash
npm run build
```

## How it works

| Part | File | Role |
|---|---|---|
| Backend | `src-tauri/src/lib.rs` | Owns the SQLite database, windows and the commands the interface calls |
| API bridge | `src/tauri-api.js` | Exposes `window.api`, where each method invokes one Rust command |
| Interface | `src/index.html`, `src/stuff.js` | Timer, tasks, charts and history |
| Floating timer | `src/mini-widget.html`, `src/tauri-mini.js` | Always-on-top widget fed by the main window |
| Frontend build | `build-ui.js` | Copies `src/` and the libraries it loads from `node_modules` into `tauri-ui-dist/` for bundling |

The interface never touches the database directly. It reaches it only through the commands registered in `lib.rs`.

**Crash recovery:** when a session starts, its start time goes into a single-row `active_session` table, and the row is cleared when the session ends. A running session also records a heartbeat every 30 seconds. If a row is still there at the next launch, the app credits the time up to the last heartbeat to that subject, so time spent with the app closed doesn't count. Pomodoro sessions are capped at 25 minutes, and anything under 30 seconds or over 12 hours is discarded as unreliable.

**Single instance:** only one copy of inmo runs at a time. A second launch focuses the running window and exits before it opens the database, so two copies can never write the same session.

## Data and privacy

Your study data lives in `%APPDATA%\inmo\academic_steam_spotify.db`, a local SQLite file. There are no accounts, and the app makes no network requests.
