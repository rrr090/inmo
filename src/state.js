// Data shared by every part of the page, and the one place it's reloaded from
// the backend. Each page registers what to redraw with onDataChanged.

export const state = {
  courses: [],          // every subject, archived ones included (analytics still counts them)
  activeCourseId: null, // the subject the timer and to-do list are on
  dailyStats: [],
  timerMode: 'stopwatch',
  // The backend timer's last snapshot (see src-tauri/src/timer.rs).
  timer: { phase: 'idle', mode: 'stopwatch', isStudying: false, timeStr: '', courseId: null },
  focusMin: 25,
  dailyGoalSecs: 2 * 3600, // the "daily_goal_min" setting
};

const listeners = [];

export function onDataChanged(fn) {
  listeners.push(fn);
}

export async function reloadData() {
  const [courses, dailyStats] = await Promise.all([window.api.getCourses(), window.api.getDailyStats()]);
  state.courses = courses;
  state.dailyStats = dailyStats;
  const active = activeCourses();
  if (!active.some(c => c.id === state.activeCourseId)) {
    state.activeCourseId = active.length ? active[0].id : null;
  }
  for (const fn of listeners) {
    try {
      await fn();
    } catch (err) {
      console.error('Redraw failed:', err);
    }
  }
}

export function activeCourses() {
  return state.courses.filter(c => !c.archived);
}

export function archivedCourses() {
  return state.courses.filter(c => c.archived);
}

export function getActiveCourse() {
  return activeCourses().find(c => c.id === state.activeCourseId) || null;
}

// Remembered so the tray and the global shortcut start the timer on the same subject.
export function setActiveCourse(id) {
  state.activeCourseId = id;
  window.api.setSetting('active_course_id', id || '').catch(err => console.error('Failed to remember subject:', err));
}

export function courseById(id) {
  return state.courses.find(c => c.id === id) || null;
}
