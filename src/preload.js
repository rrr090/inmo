const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getCourses: () => ipcRenderer.invoke('get-courses'),
  addCourse: (title, code) => ipcRenderer.invoke('add-course', { title, code }),
  updateCourse: (data) => ipcRenderer.invoke('update-course', data),
  deleteCourse: (courseId) => ipcRenderer.invoke('delete-course', courseId),
  resetCourseTime: (courseId) => ipcRenderer.invoke('reset-course-time', courseId),
  saveSession: (courseId, duration) => ipcRenderer.invoke('save-session', { courseId, duration }),
  getTasks: (courseId) => ipcRenderer.invoke('get-tasks', courseId),
  addTask: (courseId, text) => ipcRenderer.invoke('add-task', { courseId, text }),
  toggleTask: (taskId) => ipcRenderer.invoke('toggle-task', taskId),
  deleteTask: (taskId) => ipcRenderer.invoke('delete-task', taskId),
  getHistory: () => ipcRenderer.invoke('get-history'),
  deleteSession: (sessionId) => ipcRenderer.invoke('delete-session', sessionId),
  getDailyStats: () => ipcRenderer.invoke('get-daily-stats'),
  getAnalyticsBreakdown: () => ipcRenderer.invoke('get-analytics-breakdown'),
  updateTaskCourse: (data) => ipcRenderer.invoke('update-task-course', data)
});