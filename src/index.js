const { app, BrowserWindow, ipcMain, screen, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbPath = path.join(app.getPath('userData'), 'academic_steam_spotify.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS courses (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      code TEXT NOT NULL,
      total_seconds INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS study_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id TEXT,
      duration INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      course_id TEXT,
      text TEXT NOT NULL,
      completed INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // Holds the single in-progress session so it survives a crash/power loss.
  // id is fixed to 1 so there is never more than one row.
  db.run(`
    CREATE TABLE IF NOT EXISTS active_session (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      course_id TEXT,
      start_timestamp INTEGER,
      mode TEXT
    )
  `);

  // Added after 1.0.3, so existing databases need the column too.
  // "duplicate column" just means this database already has it.
  db.run('ALTER TABLE active_session ADD COLUMN last_heartbeat INTEGER', (err) => {
    if (err && !/duplicate column/i.test(err.message)) {
      log.error('Failed to add last_heartbeat column: ' + err);
    }
  });

  // Added in 1.0.5 for per-subject weekly goals. 0 means no goal set.
  db.run('ALTER TABLE courses ADD COLUMN weekly_goal_seconds INTEGER DEFAULT 0', (err) => {
    if (err && !/duplicate column/i.test(err.message)) {
      log.error('Failed to add weekly_goal_seconds column: ' + err);
    }
  });

});

// Windows only shows desktop notifications for an app with an ID. Matches build.appId.
app.setAppUserModelId('com.inmo');

autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';
// Installs when the app closes, so an update never interrupts a running session.
autoUpdater.autoInstallOnAppQuit = true;

function sendStatusToWindow(text) {
  if (mainWindow) {
    mainWindow.webContents.send('update-message', text);
  }
}

app.whenReady().then(() => {
  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify();
  }
  createWindow();
});

autoUpdater.on('checking-for-update', () => {
  log.info('Checking for updates...');
});

autoUpdater.on('update-available', (info) => {
  log.info('Update available.');
});

autoUpdater.on('update-not-available', (info) => {
  log.info('App is already up to date.');
});

autoUpdater.on('error', (err) => {
  log.error('Error during autoupdating: ' + err);
});

autoUpdater.on('download-progress', (progressObj) => {
  let log_message = "Downloaded: " + progressObj.percent + '%';
  log.info(log_message);
});

autoUpdater.on('update-downloaded', (info) => {
  log.info('Update downloaded, will install on quit.');
});

// Updates a course's title and code in the database
ipcMain.handle('update-course', async (event, { courseId, title, code }) => {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE courses SET title = ?, code = ? WHERE id = ?`,
      [title, code, courseId],
      function (err) {
        if (err) reject(err);
        else resolve({ success: true, changes: this.changes, id: courseId, title, code });
      }
    );
  });
});

let mainWindow;
let miniWidgetWindow = null;
const MINI_WIDGET_SETTING_KEY = 'mini_widget_on_minimize';

function getSettingValue(key) {
  return new Promise((resolve, reject) => {
    db.get('SELECT value FROM settings WHERE key = ?', [key], (err, row) => {
      if (err) reject(err);
      else resolve(row ? row.value : null);
    });
  });
}

function createMiniWidget() {
  if (miniWidgetWindow) return miniWidgetWindow;

  miniWidgetWindow = new BrowserWindow({
    width: 240,
    height: 84,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'mini-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false
    }
  });

  miniWidgetWindow.setAlwaysOnTop(true, 'screen-saver');

  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  miniWidgetWindow.setPosition(width - 260, height - 110);

  miniWidgetWindow.loadFile(path.join(__dirname, 'mini-widget.html'));

  miniWidgetWindow.on('closed', () => { miniWidgetWindow = null; });

  return miniWidgetWindow;
}

function destroyMiniWidget() {
  if (miniWidgetWindow) {
    miniWidgetWindow.close();
    miniWidgetWindow = null;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1300,
    height: 860,
    // Smallest size that keeps the timer header and history rows on one line.
    minWidth: 1000,
    minHeight: 680,
    backgroundColor: '#0a0a0c', // Фикс белой вспышки при открытии/сворачивании
    titleBarStyle: 'hiddenInset',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('minimize', async () => {
    try {
      const enabled = await getSettingValue(MINI_WIDGET_SETTING_KEY);
      if (enabled === 'true') {
        createMiniWidget().show();
      }
    } catch (err) {
      log.error('Failed to read mini widget setting: ' + err);
    }
  });

  mainWindow.on('restore', () => destroyMiniWidget());
  mainWindow.on('focus', () => destroyMiniWidget());
  mainWindow.on('closed', () => destroyMiniWidget());
}

ipcMain.handle('get-setting', (event, key) => {
  return getSettingValue(key);
});

// --- Crash-safe active session tracking ---

ipcMain.handle('start-active-session', (event, { courseId, startTimestamp, mode }) => {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO active_session (id, course_id, start_timestamp, mode, last_heartbeat) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET course_id = excluded.course_id,
                                     start_timestamp = excluded.start_timestamp,
                                     mode = excluded.mode,
                                     last_heartbeat = excluded.last_heartbeat`,
      [courseId, startTimestamp, mode, Date.now()],
      (err) => {
        if (err) reject(err);
        else resolve({ success: true });
      }
    );
  });
});

// Sent periodically while the timer runs, so recovery knows when the app was last alive.
ipcMain.handle('heartbeat-active-session', () => {
  return new Promise((resolve, reject) => {
    db.run('UPDATE active_session SET last_heartbeat = ? WHERE id = 1', [Date.now()], (err) => {
      if (err) reject(err);
      else resolve({ success: true });
    });
  });
});

ipcMain.handle('clear-active-session', () => {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM active_session WHERE id = 1', (err) => {
      if (err) reject(err);
      else resolve({ success: true });
    });
  });
});

// Called on startup: if a session was left open by a crash, close it out at its
// last heartbeat, so time spent with the app closed isn't credited, and write it
// to study_sessions.
ipcMain.handle('recover-active-session', () => {
  return new Promise((resolve, reject) => {
    db.get('SELECT course_id, start_timestamp, mode, last_heartbeat FROM active_session WHERE id = 1', [], (err, row) => {
      if (err) return reject(err);
      if (!row || !row.course_id || !row.start_timestamp) {
        return resolve({ recovered: false });
      }

      // Sessions started before heartbeats existed have none to go on.
      const endTimestamp = row.last_heartbeat || Date.now();
      let duration = Math.floor((endTimestamp - row.start_timestamp) / 1000);

      // A pomodoro can never legitimately exceed 25 minutes of credited time.
      if (row.mode === 'pomodoro') {
        duration = Math.min(duration, 25 * 60);
      }

      // Guard against nonsense values (clock changes, absurdly long gaps).
      const MAX_REASONABLE = 12 * 60 * 60; // 12 hours
      if (duration < 30 || duration > MAX_REASONABLE) {
        db.run('DELETE FROM active_session WHERE id = 1', () => {
          resolve({ recovered: false, discarded: true, duration });
        });
        return;
      }

      db.get('SELECT title, code FROM courses WHERE id = ?', [row.course_id], (courseErr, course) => {
        if (courseErr) return reject(courseErr);
        if (!course) {
          // Course was deleted while the session was open - drop the orphan.
          db.run('DELETE FROM active_session WHERE id = 1', () => {
            resolve({ recovered: false, discarded: true });
          });
          return;
        }

        db.run('INSERT INTO study_sessions (course_id, duration) VALUES (?, ?)', [row.course_id, duration], (insErr) => {
          if (insErr) return reject(insErr);
          db.run('UPDATE courses SET total_seconds = total_seconds + ? WHERE id = ?', [duration, row.course_id], (updErr) => {
            if (updErr) return reject(updErr);
            db.run('DELETE FROM active_session WHERE id = 1', (delErr) => {
              if (delErr) return reject(delErr);
              resolve({
                recovered: true,
                duration,
                courseTitle: course.title,
                courseCode: course.code
              });
            });
          });
        });
      });
    });
  });
});

ipcMain.handle('set-setting', (event, { key, value }) => {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
      (err) => {
        if (err) reject(err);
        else resolve({ success: true });
      }
    );
  });
});

// Relays live timer state from the main window to the floating mini widget.
// If the timer has stopped, close the widget rather than leaving a stale one on screen.
ipcMain.on('timer-state-update', (event, data) => {
  if (!data || data.isStudying === false) {
    destroyMiniWidget();
    return;
  }
  if (miniWidgetWindow) {
    miniWidgetWindow.webContents.send('timer-state', data);
  }
});

// The mini widget's own controls: click to restore, Stop to end the session.
ipcMain.on('restore-main-window', () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.restore();
    mainWindow.focus();
  }
  destroyMiniWidget();
});

ipcMain.on('stop-timer-from-widget', () => {
  if (mainWindow) {
    mainWindow.webContents.send('stop-timer-request');
    mainWindow.show();
    mainWindow.restore();
    mainWindow.focus();
  }
});

ipcMain.handle('get-courses', () => {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM courses', [], (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
});

ipcMain.handle('add-course', (event, { title, code }) => {
  return new Promise((resolve, reject) => {
    const id = Date.now().toString();
    db.run('INSERT INTO courses (id, title, code, total_seconds) VALUES (?, ?, ?, 0)', [id, title, code], (err) => {
      if (err) return reject(err);
      resolve({ id, title, code, total_seconds: 0 });
    });
  });
});

ipcMain.handle('delete-course', (event, courseId) => {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      db.run('DELETE FROM courses WHERE id = ?', [courseId]);
      db.run('DELETE FROM tasks WHERE course_id = ?', [courseId]);
      db.run('DELETE FROM study_sessions WHERE course_id = ?', [courseId], (err) => {
        if (err) {
          db.run('ROLLBACK');
          return reject(err);
        }
        db.run('COMMIT', (commitErr) => {
          if (commitErr) return reject(commitErr);
          resolve({ success: true });
        });
      });
    });
  });
});

ipcMain.handle('reset-course-time', (event, courseId) => {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('UPDATE courses SET total_seconds = 0 WHERE id = ?', [courseId]);
      db.run('DELETE FROM study_sessions WHERE course_id = ?', [courseId], (err) => {
        if (err) return reject(err);
        resolve({ success: true });
      });
    });
  });
});

ipcMain.handle('save-session', (event, { courseId, duration }) => {
  return new Promise((resolve, reject) => {
    db.run('INSERT INTO study_sessions (course_id, duration) VALUES (?, ?)', [courseId, duration], (err) => {
      if (err) return reject(err);
      db.run('UPDATE courses SET total_seconds = total_seconds + ? WHERE id = ?', [duration, courseId], (err2) => {
        if (err2) reject(err2);
        else resolve({ success: true });
      });
    });
  });
});

ipcMain.handle('get-tasks', (event, courseId) => {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM tasks WHERE course_id = ?', [courseId], (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
});

ipcMain.handle('add-task', (event, { courseId, text }) => {
  return new Promise((resolve, reject) => {
    const id = Date.now().toString();
    db.run('INSERT INTO tasks (id, course_id, text, completed) VALUES (?, ?, ?, 0)', [id, courseId, text], (err) => {
      if (err) reject(err);
      else resolve({ id, courseId, text, completed: 0 });
    });
  });
});

ipcMain.handle('toggle-task', (event, taskId) => {
  return new Promise((resolve, reject) => {
    db.run('UPDATE tasks SET completed = NOT completed WHERE id = ?', [taskId], (err) => {
      if (err) reject(err);
      else resolve({ success: true });
    });
  });
});

ipcMain.handle('delete-task', (event, taskId) => {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM tasks WHERE id = ?', [taskId], (err) => {
      if (err) reject(err);
      else resolve({ success: true });
    });
  });
});

ipcMain.handle('get-history', () => {
  return new Promise((resolve, reject) => {
    const query = `
      SELECT s.id, c.title, c.code, s.duration, strftime('%d.%m.%Y, %H:%M', s.created_at, 'localtime') AS created_at
      FROM study_sessions s 
      JOIN courses c ON s.course_id = c.id 
      ORDER BY s.created_at DESC LIMIT 50
    `;
    db.all(query, [], (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
});

ipcMain.handle('delete-session', (event, sessionId) => {
  return new Promise((resolve, reject) => {
    db.get('SELECT course_id, duration FROM study_sessions WHERE id = ?', [sessionId], (err, row) => {
      if (err) return reject(err);
      if (row) {
        db.run('UPDATE courses SET total_seconds = MAX(0, total_seconds - ?) WHERE id = ?', [row.duration, row.course_id]);
      }
      db.run('DELETE FROM study_sessions WHERE id = ?', [sessionId], (err2) => {
        if (err2) reject(err2);
        else resolve({ success: true });
      });
    });
  });
});

ipcMain.handle('get-daily-stats', () => {
  return new Promise((resolve, reject) => {
    const query = `
      SELECT DATE(created_at, 'localtime') as date, SUM(duration) as total_seconds
      FROM study_sessions
      GROUP BY DATE(created_at, 'localtime')
      ORDER BY date DESC
    `;
    db.all(query, [], (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
});

// Every session as raw rows; the Analytics tab does its grouping in the renderer.
// ended_at is Unix seconds (created_at is written when a session is saved, i.e. at its end),
// so the renderer can turn it into local dates and hours with the user's timezone.
ipcMain.handle('get-sessions', () => {
  return new Promise((resolve, reject) => {
    const query = `
      SELECT id, course_id, duration, CAST(strftime('%s', created_at) AS INTEGER) AS ended_at
      FROM study_sessions
      ORDER BY created_at ASC
    `;
    db.all(query, [], (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
});

ipcMain.handle('get-task-stats', () => {
  return new Promise((resolve, reject) => {
    const query = `
      SELECT course_id, COUNT(*) AS total, SUM(CASE WHEN completed THEN 1 ELSE 0 END) AS done
      FROM tasks
      GROUP BY course_id
    `;
    db.all(query, [], (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
});

ipcMain.handle('set-course-goal', (event, { courseId, seconds }) => {
  return new Promise((resolve, reject) => {
    const value = Math.max(0, Math.round(Number(seconds) || 0));
    db.run('UPDATE courses SET weekly_goal_seconds = ? WHERE id = ?', [value, courseId], (err) => {
      if (err) reject(err);
      else resolve({ success: true });
    });
  });
});

function csvField(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// Asks where to save, then writes every session as CSV. Resolves { canceled: true }
// if the user closes the dialog.
ipcMain.handle('export-sessions-csv', async () => {
  const today = new Date();
  const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export sessions',
    defaultPath: path.join(app.getPath('documents'), `inmo-sessions-${stamp}.csv`),
    filters: [{ name: 'CSV', extensions: ['csv'] }]
  });
  if (canceled || !filePath) return { canceled: true };

  const rows = await new Promise((resolve, reject) => {
    const query = `
      SELECT
        strftime('%Y-%m-%d', s.created_at, 'localtime') AS date,
        strftime('%H:%M', s.created_at, '-' || s.duration || ' seconds', 'localtime') AS start,
        strftime('%H:%M', s.created_at, 'localtime') AS end,
        c.code, c.title, s.duration
      FROM study_sessions s
      LEFT JOIN courses c ON s.course_id = c.id
      ORDER BY s.created_at ASC
    `;
    db.all(query, [], (err, result) => (err ? reject(err) : resolve(result || [])));
  });

  const header = ['Date', 'Start', 'End', 'Subject Code', 'Subject Title', 'Duration (min)', 'Duration (sec)'];
  const lines = [header.join(',')];
  rows.forEach((r) => {
    lines.push([r.date, r.start, r.end, r.code, r.title, (r.duration / 60).toFixed(1), r.duration].map(csvField).join(','));
  });

  // The BOM makes Excel read the file as UTF-8, so non-Latin subject names survive.
  await fs.promises.writeFile(filePath, '﻿' + lines.join('\r\n') + '\r\n', 'utf8');
  return { canceled: false, filePath, count: rows.length };
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });