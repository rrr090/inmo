const { app, BrowserWindow, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');

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

  db.get('SELECT COUNT(*) as count FROM courses', (err, row) => {
    if (!err && row && row.count === 0) {
      const stmt = db.prepare('INSERT INTO courses (id, title, code) VALUES (?, ?, ?)');
      stmt.run('1', 'Linear Algebra & Calculus', 'MATH1010');
      stmt.run('2', 'Data Structures & Algorithms', 'CS1020');
      stmt.run('3', 'Artificial Intelligence Systems', 'AI2001');
      stmt.finalize();
    }
  });
});

autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';

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
  log.info('Update downloaded.');
  autoUpdater.quitAndInstall();
});

// Исправленный метод для обновления кода курса в базе данных
ipcMain.handle('update-course-code', async (event, { courseId, newCode }) => {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE courses SET code = ? WHERE id = ?`,
      [newCode, courseId],
      function (err) {
        if (err) reject(err);
        else resolve({ success: true, changes: this.changes });
      }
    );
  });
});

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1300,
    height: 860,
    backgroundColor: '#0a0a0c', // Фикс белой вспышки при открытии/сворачивании
    titleBarStyle: 'hiddenInset',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

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
      SELECT s.id, c.title, c.code, s.duration, s.created_at 
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
      SELECT DATE(created_at) as date, SUM(duration) as total_seconds 
      FROM study_sessions 
      GROUP BY DATE(created_at) 
      ORDER BY date DESC
    `;
    db.all(query, [], (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
});

ipcMain.handle('get-analytics-breakdown', () => {
  return new Promise((resolve, reject) => {
    const trendQuery = `
      SELECT DATE(created_at) as date, SUM(duration) as total_seconds 
      FROM study_sessions 
      WHERE created_at >= datetime('now', '-7 days')
      GROUP BY DATE(created_at) 
      ORDER BY date ASC
    `;
    
    db.all(trendQuery, [], (err, trendRows) => {
      if (err) return reject(err);

      const comparisonQuery = `
        SELECT 
          SUM(CASE WHEN created_at >= datetime('now', '-7 days') THEN duration ELSE 0 END) as current_week,
          SUM(CASE WHEN created_at >= datetime('now', '-14 days') AND created_at < datetime('now', '-7 days') THEN duration ELSE 0 END) as previous_week
        FROM study_sessions
      `;

      db.get(comparisonQuery, [], (err2, compRow) => {
        if (err2) return reject(err2);
        resolve({
          trend: trendRows || [],
          comparison: compRow || { current_week: 0, previous_week: 0 }
        });
      });
    });
  });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });