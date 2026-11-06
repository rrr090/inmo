# inmo

A desktop study tracker for university courses. Time your study sessions per subject, keep a to-do list for each one, and see where your hours actually go. All your data stays on your machine.

[![Latest release](https://img.shields.io/github/v/release/rrr090/inmo?style=flat-square)](https://github.com/rrr090/inmo/releases/latest)
![Windows](https://img.shields.io/badge/Windows-0078d4?style=flat-square)
![Electron](https://img.shields.io/badge/Electron-2b2e3a?style=flat-square&logo=electron&logoColor=9feaf9)
![SQLite](https://img.shields.io/badge/SQLite-003b57?style=flat-square&logo=sqlite&logoColor=white)

![inmo analytics page showing a 7-day focus trend, activity heatmap and time per subject](docs/screenshot.png)

## Features

- **Focus timer:** stopwatch or 25-minute Pomodoro, logged against the subject you pick.
- **Subjects and tasks:** add, edit and remove courses, each with its own to-do list.
- **Analytics:** 7-day focus trend, week-over-week comparison, a 90-day activity heatmap and total time per subject.
- **Goals and streaks:** a daily 2-hour target and a running study streak.
- **Session history:** your 50 most recent sessions, with the option to delete any of them.
- **Floating timer:** an optional always-on-top widget that appears when you minimize the app, so you can see or stop the timer from anywhere.
- **Crash recovery:** a running session is saved as soon as it starts, so a crash or power cut doesn't lose your time.
- **Auto-updates:** new versions download from GitHub Releases and install when you close the app.

## Install

Download the latest `inmo.Setup.<version>.exe` from [Releases](https://github.com/rrr090/inmo/releases/latest) and run it. Windows is the only platform with a packaged build.

## Run from source

Requires [Node.js](https://nodejs.org).

```bash
git clone https://github.com/rrr090/inmo.git
cd inmo
npm install
npm start
```

To build the Windows installer into `dist/`:

```bash
npm run build
```

## How it works

| Part | File | Role |
|---|---|---|
| Main process | `src/index.js` | Owns the SQLite database, windows and auto-updates |
| Preload bridge | `src/preload.js` | Exposes a limited `window.api` over IPC |
| Interface | `src/index.html`, `src/stuff.js` | Timer, tasks, charts and history |
| Floating timer | `src/mini-widget.html` | Always-on-top widget fed by the main window |

The interface runs with `contextIsolation` on and `nodeIntegration` off, so it only reaches the database through the preload bridge.

**Crash recovery:** when a session starts, its start time goes into a single-row `active_session` table, and the row is cleared when the session ends. A running session also records a heartbeat every 30 seconds. If a row is still there at the next launch, the app credits the time up to the last heartbeat to that subject, so time spent with the app closed doesn't count. Pomodoro sessions are capped at 25 minutes, and anything under 30 seconds or over 12 hours is discarded as unreliable.

## Data and privacy

Your study data lives in a local SQLite file in the app's user data folder. There are no accounts, and your data is never uploaded. The app only uses the network to check for updates, and everything else works offline.
