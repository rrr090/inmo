// window.api for the page: each call invokes a command in src-tauri/src/.
(function () {
  if (window.api || !window.__TAURI__) return;
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  window.api = {
    // Subjects
    getCourses: () => invoke('get_courses'),
    addCourse: (title, code) => invoke('add_course', { title, code }),
    updateCourse: ({ courseId, title, code }) => invoke('update_course', { courseId, title, code }),
    deleteCourse: (courseId) => invoke('delete_course', { courseId }),
    setCourseArchived: (courseId, archived) => invoke('set_course_archived', { courseId, archived }),
    resetCourseTime: (courseId) => invoke('reset_course_time', { courseId }),
    setCourseGoal: (courseId, seconds) => invoke('set_course_goal', { courseId, seconds }),

    // Sessions
    getHistory: (limit) => invoke('get_history', { limit }),
    addSession: (courseId, endedAt, duration) => invoke('add_session', { courseId, endedAt, duration }),
    updateSession: (sessionId, courseId, endedAt, duration) => invoke('update_session', { sessionId, courseId, endedAt, duration }),
    deleteSession: (sessionId) => invoke('delete_session', { sessionId }),
    getDailyStats: () => invoke('get_daily_stats'),
    getSessions: () => invoke('get_sessions'),

    // Tasks
    getTasks: (courseId) => invoke('get_tasks', { courseId }),
    addTask: (courseId, text) => invoke('add_task', { courseId, text }),
    toggleTask: (taskId) => invoke('toggle_task', { taskId }),
    deleteTask: (taskId) => invoke('delete_task', { taskId }),
    getTaskStats: () => invoke('get_task_stats'),

    // Settings
    getSetting: (key) => invoke('get_setting', { key }),
    setSetting: (key, value) => invoke('set_setting', { key, value }),
    getShortcut: () => invoke('get_shortcut'),
    setShortcutEnabled: (enabled) => invoke('set_shortcut_enabled', { enabled }),
    getAutostart: () => invoke('get_autostart'),
    setAutostart: (enabled) => invoke('set_autostart', { enabled }),

    // Timer (runs in the backend; see timer.rs)
    timerGet: () => invoke('timer_get'),
    timerStart: (courseId, mode) => invoke('timer_start', { courseId, mode }),
    timerStop: () => invoke('timer_stop'),
    timerResolveIdle: (keep) => invoke('timer_resolve_idle', { keep }),
    onTimerState: (callback) => listen('timer-state', (event) => callback(event.payload)),
    onTimerEvent: (callback) => listen('timer-event', (event) => callback(event.payload)),
    takeRecoveryResult: () => invoke('take_recovery_result'),

    // Data
    exportSessionsCsv: () => invoke('export_sessions_csv'),
    importSessionsCsv: () => invoke('import_sessions_csv'),
    getBackupInfo: () => invoke('get_backup_info'),
    backupNow: () => invoke('backup_now'),
    openBackupsFolder: () => invoke('open_backups_folder'),
    restoreBackup: () => invoke('restore_backup'),

    // Updates
    getUpdateStatus: () => invoke('get_update_status'),
    checkForUpdates: () => invoke('check_for_updates'),
    installUpdateNow: () => invoke('install_update_now'),
    onUpdateReady: (callback) => listen('update-ready', (event) => callback(event.payload)),
  };
})();
