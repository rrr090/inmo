// Tauri stand-in for src/preload.js: gives stuff.js the same window.api it has in Electron.
(function () {
  if (window.api || !window.__TAURI__) return;
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  window.api = {
    getCourses: () => invoke('get_courses'),
    addCourse: (title, code) => invoke('add_course', { title, code }),
    updateCourse: ({ courseId, title, code }) => invoke('update_course', { courseId, title, code }),
    deleteCourse: (courseId) => invoke('delete_course', { courseId }),
    resetCourseTime: (courseId) => invoke('reset_course_time', { courseId }),
    saveSession: (courseId, duration) => invoke('save_session', { courseId, duration }),
    getTasks: (courseId) => invoke('get_tasks', { courseId }),
    addTask: (courseId, text) => invoke('add_task', { courseId, text }),
    toggleTask: (taskId) => invoke('toggle_task', { taskId }),
    deleteTask: (taskId) => invoke('delete_task', { taskId }),
    getHistory: () => invoke('get_history'),
    deleteSession: (sessionId) => invoke('delete_session', { sessionId }),
    getDailyStats: () => invoke('get_daily_stats'),
    getSessions: () => invoke('get_sessions'),
    getTaskStats: () => invoke('get_task_stats'),
    setCourseGoal: (courseId, seconds) => invoke('set_course_goal', { courseId, seconds }),
    exportSessionsCsv: () => invoke('export_sessions_csv'),

    getSetting: (key) => invoke('get_setting', { key }),
    setSetting: (key, value) => invoke('set_setting', { key, value }),
    sendTimerState: (data) => { invoke('timer_state_update', { data }).catch(() => {}); },
    onStopTimerRequest: (callback) => { listen('stop-timer-request', () => callback()); },

    startActiveSession: ({ courseId, startTimestamp, mode }) =>
      invoke('start_active_session', { courseId, startTimestamp, mode }),
    heartbeatActiveSession: () => invoke('heartbeat_active_session'),
    clearActiveSession: () => invoke('clear_active_session'),
    recoverActiveSession: () => invoke('recover_active_session')
  };

  // notify.js uses the web Notification API; route it to native Windows notifications.
  window.Notification = class {
    constructor(title, options = {}) {
      invoke('plugin:notification|notify', { options: { title, body: options.body } }).catch(() => {});
    }
    static get permission() { return 'granted'; }
    static requestPermission() { return Promise.resolve('granted'); }
  };
})();
