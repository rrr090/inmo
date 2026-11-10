import { icon, renderIcons } from './icons.js';
import { showToast, confirmDialog, desktopNotify } from './notify.js';

// ==========================================
// 1. СОСТОЯНИЕ ПРИЛОЖЕНИЯ
// ==========================================
let courses = [];
let activeCourseId = null;
let dailyStats = [];

// Daily study target, shared by the dashboard progress bar and the trend chart's goal line.
const DAILY_GOAL_SECONDS = 2 * 3600;

let timerInterval = null;
let startTime = null;
let secondsElapsed = 0;
let isStudying = false;
let timerMode = 'stopwatch';

let currentTimerInterval = null;

// How often a running session reports it's alive. A crash loses at most this much time.
const HEARTBEAT_INTERVAL_MS = 30 * 1000;


// ==========================================
// 2. ИНИЦИАЛИЗАЦИЯ И УПРАВЛЕНИЕ КУРСАМИ
// ==========================================
async function init() {
  try {
    injectCustomScrollbarStyles();
    renderIcons();

    await recoverCrashedSession();

    courses = await window.api.getCourses();
    dailyStats = await window.api.getDailyStats();
      
    if (courses.length > 0 && !activeCourseId) {
      activeCourseId = courses[0].id;
    }

    renderFirstRun();
    renderCourses();
    renderTimerCourseSelect();
    updateMetricsDashboard();
    loadTasks();
    initTimerButton();
    loadMiniWidgetSetting();
    listenForWidgetStopRequests();
    // A session can be saved while Analytics is open (e.g. stopped from the floating widget).
    if (isAnalyticsPageActive()) renderAnalyticsPage();
  } catch (err) {
    console.error('Initialization error:', err);
  }
}

let crashRecoveryChecked = false;
async function recoverCrashedSession() {
  // init() runs again after saving sessions, so only check on the first launch pass.
  if (crashRecoveryChecked) return;
  crashRecoveryChecked = true;

  if (!window.api || typeof window.api.recoverActiveSession !== 'function') return;

  try {
    const result = await window.api.recoverActiveSession();
    if (result && result.recovered) {
      showToast('Recovered an unfinished session', {
        message: `${formatDuration(result.duration)} restored to ${result.courseCode} — ${result.courseTitle}`,
        type: 'info',
        duration: 10000
      });
    }
  } catch (err) {
    console.error('Failed to recover crashed session:', err);
  }
}

async function loadMiniWidgetSetting() {
  const checkbox = document.getElementById('mini-widget-toggle');
  if (!checkbox || !window.api || typeof window.api.getSetting !== 'function') return;
  try {
    const value = await window.api.getSetting('mini_widget_on_minimize');
    checkbox.checked = value === 'true';
  } catch (err) {
    console.error('Failed to load mini widget setting:', err);
  }
}

async function toggleMiniWidgetSetting(checked) {
  if (!window.api || typeof window.api.setSetting !== 'function') return;
  try {
    await window.api.setSetting('mini_widget_on_minimize', checked ? 'true' : 'false');
  } catch (err) {
    console.error('Failed to save mini widget setting:', err);
  }
}

let widgetStopListenerAttached = false;
function listenForWidgetStopRequests() {
  if (widgetStopListenerAttached) return;
  if (!window.api || typeof window.api.onStopTimerRequest !== 'function') return;

  window.api.onStopTimerRequest(() => {
    // Reuse the exact same stop logic as clicking the main play/pause button
    const timerBtn = document.getElementById('timer-btn');
    if (timerBtn && isStudying) timerBtn.click();
  });
  widgetStopListenerAttached = true;
}

function injectCustomScrollbarStyles() {
  if (document.getElementById('custom-scrollbar-style')) return;
  const style = document.createElement('style');
  style.id = 'custom-scrollbar-style';
  style.innerHTML = `
    ::-webkit-scrollbar {
      width: 6px;
      height: 6px;
    }
    ::-webkit-scrollbar-track {
      background: var(--bg-main, #0f172a);
    }
    ::-webkit-scrollbar-thumb {
      background: var(--border-color, #334155);
      border-radius: 3px;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: var(--accent, #10b981);
    }

    /* Выразительное выделение активных элементов и вкладок */
    .course-item.active {
      background: rgba(16, 185, 129, 0.15) !important;
      border-left: 4px solid var(--accent, #10b981) !important;
      box-shadow: inset 0 0 10px rgba(16, 185, 129, 0.1), 0 0 10px rgba(16, 185, 129, 0.25);
      border-radius: 6px;
    }
    .course-item.active .title {
      color: #ffffff !important;
      font-weight: 700 !important;
    }
    .course-item.active .code {
      color: var(--accent, #10b981) !important;
      font-weight: 600 !important;
    }
    .nav-link.active {
      background: var(--accent, #10b981) !important;
      color: #000000 !important;
      font-weight: 700 !important;
      box-shadow: 0 0 12px rgba(16, 185, 129, 0.4) !important;
      border-radius: 6px;
    }
    .tab-button.active, .mode-tab.active {
      background: var(--accent, #10b981) !important;
      color: #000000 !important;
      font-weight: 700 !important;
      box-shadow: 0 0 10px rgba(16, 185, 129, 0.3) !important;
    }

    /* Плавающий мини-таймер, виден на других вкладках, пока идёт сессия */
    .mini-timer-widget {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 999;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 16px;
      background: var(--bg-card, #181820);
      border: 1px solid var(--accent, #10b981);
      border-radius: 999px;
      box-shadow: 0 4px 20px rgba(16, 185, 129, 0.25);
      cursor: pointer;
      color: var(--text-main, #f3f4f6);
      transition: transform 0.15s ease;
    }
    .mini-timer-widget:hover { transform: scale(1.05); }
    .mini-timer-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--accent, #10b981);
      box-shadow: 0 0 8px var(--accent, #10b981);
      animation: mini-timer-pulse 1.2s infinite ease-in-out;
      flex-shrink: 0;
    }
    @keyframes mini-timer-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.35; }
    }
    .mini-timer-time {
      font-family: 'JetBrains Mono', monospace;
      font-weight: 700;
      font-size: 14px;
      letter-spacing: -0.5px;
    }
    .mini-timer-course {
      font-size: 11px;
      color: var(--text-sub, #9ca3af);
      font-weight: 600;
      white-space: nowrap;
      max-width: 140px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  `;
  document.head.appendChild(style);
}

function getActiveCourse() {
  return courses.find(c => c.id === activeCourseId) || courses[0] || null;
}

function emptyState(iconName, title, text) {
  return `
    <div class="empty-state">
      ${icon(iconName, 22)}
      <div class="empty-state-title">${title}</div>
      <div class="empty-state-text">${text}</div>
    </div>
  `;
}

function renderFirstRun() {
  const noSubjects = courses.length === 0;
  document.getElementById('first-run').classList.toggle('is-hidden', !noSubjects);
  document.getElementById('focus-content').classList.toggle('is-hidden', noSubjects);
}

function renderCourses() {
  const list = document.getElementById('course-list');
  if (!list) return;
  list.innerHTML = '';

  if (courses.length === 0) {
    list.innerHTML = emptyState('book-open', 'No subjects yet', 'Add one with the + button.');
    return;
  }

  courses.forEach(course => {
    const item = document.createElement('div');
    item.className = `course-item ${activeCourseId === course.id ? 'active' : ''}`;
    item.id = `course-row-${course.id}`;
    
    if (course.isEditing) {
      item.innerHTML = `
        <div style="display: flex; flex-direction: column; gap: 6px; width: 100%; padding: 4px;" onclick="event.stopPropagation()">
          <input type="text" id="edit-title-${course.id}" value="${course.title}" placeholder="Course Title" style="background: var(--bg-main); border: 1px solid var(--accent); color: white; padding: 4px 6px; border-radius: 4px; font-size: 13px; width: 100%;" />
          <div style="display: flex; gap: 6px; align-items: center;">
            <input type="text" id="edit-code-${course.id}" value="${course.code}" placeholder="Code" style="background: var(--bg-main); border: 1px solid var(--accent); color: white; padding: 3px 6px; border-radius: 4px; font-size: 12px; width: 80px;" />
            <button onclick="event.stopPropagation(); window.saveCourseInfo('${course.id}')" style="background: var(--accent); border: none; color: black; border-radius: 3px; padding: 3px 8px; cursor: pointer; font-weight: bold; font-size: 12px;">Save</button>
            <button onclick="event.stopPropagation(); window.cancelCourseEdit('${course.id}')" style="background: transparent; border: 1px solid var(--border-color); color: white; border-radius: 3px; padding: 3px 6px; cursor: pointer; font-size: 12px;">Cancel</button>
          </div>
        </div>
      `;
    } else {
      item.innerHTML = `
        <div class="course-info" onclick="window.selectCourse('${course.id}')" style="cursor: pointer; flex-grow: 1; overflow: hidden;">
          <div class="title" id="course-title-${course.id}" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${course.title}</div>
          <div class="code" id="code-container-${course.id}">
            <span id="code-text-${course.id}">${course.code}</span> 
            • ${formatHM(course.total_seconds)}
          </div>
        </div>
        <div class="course-actions">
          <button class="icon-btn" title="Edit Subject" aria-label="Edit Subject" onclick="event.stopPropagation(); window.enableCourseEdit('${course.id}')">${icon('pencil', 14)}</button>
          <button class="icon-btn danger" title="Delete Subject" aria-label="Delete Subject" onclick="event.stopPropagation(); window.handleDeleteCourse('${course.id}')">${icon('x', 14)}</button>
        </div>
      `;
    }
    list.appendChild(item);
  });
}

function enableCourseEdit(courseId) {
  courses.forEach(c => {
    c.isEditing = (c.id === courseId);
  });
  renderCourses();
  
  setTimeout(() => {
    const titleInput = document.getElementById(`edit-title-${courseId}`);
    if (titleInput) {
      titleInput.focus();
      titleInput.select();
    }
  }, 50);
}

function cancelCourseEdit(courseId) {
  const course = courses.find(c => c.id === courseId);
  if (course) course.isEditing = false;
  renderCourses();
}

async function saveCourseInfo(courseId) {
  const titleInput = document.getElementById(`edit-title-${courseId}`);
  const codeInput = document.getElementById(`edit-code-${courseId}`);
  if (!titleInput || !codeInput) return;

  const newTitle = titleInput.value.trim();
  const newCode = codeInput.value.trim();

  if (!newTitle || !newCode) {
    showToast('Title and code are both required', { type: 'error' });
    return;
  }

  try {
    if (typeof window.api.updateCourse !== 'function') {
      // Preload doesn't expose an update-course bridge yet - fail loudly instead of
      // silently reloading the old, unchanged data.
      console.error('saveCourseInfo: window.api.updateCourse is not available. Add it to preload.js and an "update-course" IPC handler in main.js.');
      showToast('Could not save changes', { message: 'The app is missing the update-course function.', type: 'error' });
      return;
    }

    await window.api.updateCourse({ courseId, title: newTitle, code: newCode });

    courses = await window.api.getCourses();

    const saved = courses.find(c => c.id === courseId);
    if (saved && (saved.title !== newTitle || saved.code !== newCode)) {
      // The API call resolved but the refetched data doesn't match what we tried to save.
      console.warn('saveCourseInfo: data after refetch does not match what was saved', { expected: { newTitle, newCode }, got: saved });
      showToast('The save may not have worked', { message: 'Please double-check this subject\'s details.', type: 'error' });
    }

    courses.forEach(c => c.isEditing = false);
    renderCourses();
    renderTimerCourseSelect();
    loadTasks();
  } catch (err) {
    console.error('Failed to update course info:', err);
    showToast('Could not save changes', { message: String(err.message || err), type: 'error' });
  }
}

function renderTimerCourseSelect() {
  const el = document.getElementById('global-timer-course-select');
  if (!el) return;

  const activeCourse = getActiveCourse();
  const displayText = activeCourse 
    ? `<span style="color: var(--accent, #10b981); font-weight: 800; font-size: 15px; text-shadow: 0 0 8px rgba(16, 185, 129, 0.3);">${activeCourse.code}</span> <span style="color: #64748b; font-weight: 400;">—</span> <span style="color: #f8fafc; font-weight: 600; font-size: 14px;">${activeCourse.title}</span>`
    : '<span style="color: #94a3b8; font-style: italic;">No course selected</span>';

  if (el.tagName === 'SELECT') {
    const badgeContainer = document.createElement('div');
    badgeContainer.id = 'global-timer-course-select';
    badgeContainer.style.cssText = 'padding: 6px 14px; background: rgba(16, 185, 129, 0.12); border: 1px solid rgba(16, 185, 129, 0.35); border-radius: 6px; display: inline-flex; align-items: center; gap: 8px; font-family: inherit; margin-top: 4px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);';
    badgeContainer.innerHTML = displayText;
    el.parentNode.replaceChild(badgeContainer, el);
  } else {
    el.style.cssText = 'padding: 6px 14px; background: rgba(16, 185, 129, 0.12); border: 1px solid rgba(16, 185, 129, 0.35); border-radius: 6px; display: inline-flex; align-items: center; gap: 8px; font-family: inherit; margin-top: 4px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);';
    el.innerHTML = displayText;
  }
}

function selectCourse(id) {
  stopActiveTimer();
  activeCourseId = id;
  renderCourses();
  renderTimerCourseSelect();
  loadTasks();
  switchToTimerPage();
}

async function stopActiveTimer() {
  if (isStudying) {
    isStudying = false;
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }

    const currentCourse = getActiveCourse();
    let durationToSave = timerMode === 'stopwatch' ? secondsElapsed : (25 * 60 - secondsElapsed);

    if (window.api.clearActiveSession) {
      await window.api.clearActiveSession().catch(err => console.error('Failed to clear active session:', err));
    }

    if (currentCourse && durationToSave > 30) {
      try {
        await window.api.saveSession(currentCourse.id, durationToSave);
        dailyStats = await window.api.getDailyStats();
        courses = await window.api.getCourses();
        renderCourses();
        updateMetricsDashboard();
        showSessionSaved(currentCourse, durationToSave);
      } catch (err) {
        console.error('Error saving session on timer stop:', err);
        showToast('Could not save your session', { message: String(err.message || err), type: 'error' });
      }
    } else {
      showSessionTooShort();
    }
  }

  if (currentTimerInterval) {
    clearInterval(currentTimerInterval);
    currentTimerInterval = null;
  }

  secondsElapsed = timerMode === 'stopwatch' ? 0 : 25 * 60;
  updateAllTimerDisplays();

  const timerBtn = document.getElementById('timer-btn');
  const playIcon = document.getElementById('play-icon');
  if (timerBtn && playIcon) {
    timerBtn.classList.remove('running');
    playIcon.innerHTML = '<path d="M8 5v14l11-7z"/>';
  }
}

function switchTab(targetTabId) {
  stopActiveTimer(); 
  document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
  const targetTab = document.getElementById(targetTabId);
  if (targetTab) targetTab.classList.add('active');

  document.querySelectorAll('.tab-button').forEach(btn => btn.classList.remove('active'));
  const matchingButton = document.querySelector(`[onclick*="switchTab('${targetTabId}')"]`);
  if (matchingButton) matchingButton.classList.add('active');
}

function switchToTimerPage() {
  // The timer lives on 'timer-page' ("Focus Engine"), switched via the existing
  // switchPage() function and highlighted through its matching sidebar nav-link.
  const timerNavLink = document.querySelector(`.nav-link[onclick*="switchPage('timer-page'"]`);
  switchPage('timer-page', timerNavLink);
}

function onTimerCourseChange(id) {
  stopActiveTimer();
  activeCourseId = id;
  renderCourses();
  renderTimerCourseSelect();
  loadTasks();
}

function formatHM(totalSecs) {
  const hrs = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  return `${hrs}h ${mins}m`;
}

// For messages, where "0h 0m" would read as if nothing was saved.
function formatDuration(totalSecs) {
  if (totalSecs < 60) return `${totalSecs} sec`;
  if (totalSecs < 3600) return `${Math.floor(totalSecs / 60)} min`;
  return formatHM(totalSecs);
}

function showSessionSaved(course, seconds) {
  showToast('Session saved', { message: `${formatDuration(seconds)} added to ${course.code} — ${course.title}` });
}

function showSessionTooShort() {
  showToast('Session not saved', { message: 'Sessions of 30 seconds or less aren\'t logged.', type: 'info' });
}


// ==========================================
// 3. НАВИГАЦИЯ И ДЭШБОРД
// ==========================================
async function switchPage(pageId, element) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach(n => n.classList.remove('active'));
  
  const targetPage = document.getElementById(pageId);
  if (targetPage) targetPage.classList.add('active');
  if (element) element.classList.add('active');

  if (pageId === 'analytics-page') {
    await renderAnalyticsPage();
  }
  if (pageId === 'history-page') renderHistory();

  updateMiniTimerWidget();
}

// YYYY-MM-DD in the user's timezone, matching DATE(created_at, 'localtime') in the
// main process. toISOString() would give the UTC date, a day off for part of each day.
function localDateKey(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function updateMetricsDashboard() {
  const todayStr = localDateKey(new Date());
  const todayRecord = dailyStats.find(d => d.date === todayStr);
  const todaySeconds = todayRecord ? todayRecord.total_seconds : 0;
  const progressPercent = Math.min(100, Math.round((todaySeconds / DAILY_GOAL_SECONDS) * 100));
  const todayMins = Math.floor(todaySeconds / 60);
  
  const progressText = document.getElementById('daily-progress-text');
  const progressFill = document.getElementById('daily-progress-fill');
  if (progressText) progressText.innerText = `${todayMins}m / ${DAILY_GOAL_SECONDS / 60}m`;
  if (progressFill) progressFill.style.width = `${progressPercent}%`;

  let streak = 0;
  let d = new Date();
  while (true) {
    const ds = localDateKey(d);
    const found = dailyStats.find(item => item.date === ds);
    if (found && found.total_seconds > 0) {
      streak++;
      d.setDate(d.getDate() - 1);
    } else {
      if (streak === 0 && ds === todayStr) {
        d.setDate(d.getDate() - 1);
        continue;
      }
      break;
    }
  }
  
  const streakVal = document.getElementById('current-streak-val');
  if (streakVal) {
    if (streak === 0) streakVal.innerText = 'No streak yet';
    else streakVal.innerText = `${streak} ${streak === 1 ? 'day' : 'days'} in a row`;
  }
}


// ==========================================
// 4. АНАЛИТИКА, ГРАФИКИ И ИСТОРИЯ
// ==========================================
// Subject colors, validated for colorblind separation on the dark card surface.
// Assigned by a subject's position in the library, so a subject keeps the same
// color in every chart. Past 8 subjects, the 8th slot becomes "Other".
const SUBJECT_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
const OTHER_COLOR = '#6b7280';
const CHART_SURFACE = '#181820';
const GRID_COLOR = 'rgba(255,255,255,0.04)';
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEKDAYS_FULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

let analyticsRange = 7;
let trendMode = 'total';
let analyticsSessions = [];
let analyticsDays = new Map();
let taskStatsByCourse = new Map();
let trendChartInstance = null;
let weekdayChartInstance = null;
let editingGoalCourseId = null;

if (window.Chart) {
  Chart.defaults.font.family = "'Plus Jakarta Sans', sans-serif";
  Chart.defaults.color = '#9ca3af';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// "2h 5m", "45m", "<1m" - compact enough for tiles and tooltips.
function formatCompact(totalSecs) {
  const secs = Math.round(totalSecs);
  const hrs = Math.floor(secs / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  if (hrs > 0) return mins ? `${hrs}h ${mins}m` : `${hrs}h`;
  if (mins > 0) return `${mins}m`;
  return secs > 0 ? '<1m' : '0m';
}

function parseDateKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

// `count` local days, oldest first, ending `offset` days before today.
function daysBack(count, offset = 0) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = [];
  for (let i = count - 1 + offset; i >= offset; i--) days.push(addDays(today, -i));
  return days;
}

function fmtDay(date, withWeekday = false) {
  return date.toLocaleDateString('en-US', withWeekday
    ? { weekday: 'short', month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric' });
}

function weekdayIndex(date) {
  return (date.getDay() + 6) % 7; // Monday = 0
}

function courseCode(courseId) {
  const course = courses.find(c => c.id === courseId);
  return course ? course.code : 'Deleted subject';
}

function subjectSeries() {
  const named = courses.length > SUBJECT_COLORS.length ? SUBJECT_COLORS.length - 1 : courses.length;
  const series = courses.slice(0, named).map((c, i) => ({
    key: c.id, label: c.code, title: c.title, color: SUBJECT_COLORS[i], courseIds: [c.id]
  }));
  if (courses.length > named) {
    const rest = courses.slice(named);
    series.push({ key: 'other', label: 'Other', title: `${rest.length} more subjects`, color: OTHER_COLOR, courseIds: rest.map(c => c.id) });
  }
  return series;
}

function seriesForCourse(courseId) {
  return subjectSeries().find(s => s.courseIds.includes(courseId));
}

// Day key -> { total, byCourse }. A session counts on the day it ended, matching
// DATE(created_at, 'localtime') used by the dashboard and history.
function buildDayMap(sessions) {
  const days = new Map();
  sessions.forEach(s => {
    const key = localDateKey(new Date(s.ended_at * 1000));
    if (!days.has(key)) days.set(key, { total: 0, byCourse: new Map() });
    const day = days.get(key);
    day.total += s.duration;
    day.byCourse.set(s.course_id, (day.byCourse.get(s.course_id) || 0) + s.duration);
  });
  return days;
}

function dayTotal(key) {
  const day = analyticsDays.get(key);
  return day ? day.total : 0;
}

function sumDays(dates) {
  return dates.reduce((sum, d) => sum + dayTotal(localDateKey(d)), 0);
}

async function renderAnalyticsPage() {
  try {
    const [sessions, taskStats] = await Promise.all([window.api.getSessions(), window.api.getTaskStats()]);
    analyticsSessions = sessions;
    analyticsDays = buildDayMap(sessions);
    taskStatsByCourse = new Map(taskStats.map(t => [t.course_id, t]));
  } catch (err) {
    console.error('Failed to load analytics:', err);
    showToast('Could not load analytics', { message: String(err.message || err), type: 'error' });
    return;
  }

  renderWeekComparison();
  renderSummaryTiles();
  renderTrendChart();
  renderHeatmap();
  renderSubjectShare();
  renderWeekdayChart();
  renderHourGrid();
  renderSubjectCards();
}

function isAnalyticsPageActive() {
  const page = document.getElementById('analytics-page');
  return Boolean(page && page.classList.contains('active'));
}

function renderWeekComparison() {
  // Whole local calendar days: the last 7 days vs the 7 before.
  const currWeek = sumDays(daysBack(7));
  const prevWeek = sumDays(daysBack(7, 7));

  let pctChange = 0;
  let pctDisplay = '0%';
  if (prevWeek > 0) {
    pctChange = Math.round(((currWeek - prevWeek) / prevWeek) * 100);
    pctDisplay = `${pctChange > 0 ? '+' : ''}${pctChange}%`;
  } else if (currWeek > 0) {
    // No previous-week data to compare against, so show it as new activity.
    pctChange = 100;
    pctDisplay = 'New';
  }

  const badgeColor = pctChange >= 0 ? 'var(--accent)' : 'var(--danger)';
  const compBadge = document.getElementById('weekly-comparison-badge');
  if (compBadge) {
    compBadge.innerHTML = `Week-over-Week: <span style="color: ${badgeColor};">${pctDisplay}</span>`;
  }
}

function computeLongestStreak() {
  const keys = [...analyticsDays.keys()].filter(k => analyticsDays.get(k).total > 0).sort();
  let longest = 0;
  let longestEnd = null;
  let run = 0;
  let prev = null;
  keys.forEach(key => {
    run = prev && localDateKey(addDays(parseDateKey(prev), 1)) === key ? run + 1 : 1;
    if (run > longest) {
      longest = run;
      longestEnd = key;
    }
    prev = key;
  });
  return { longest, longestEnd };
}

function renderSummaryTiles() {
  const el = document.getElementById('summary-tiles');
  if (!el) return;

  const sessions = analyticsSessions;
  const weekSecs = sumDays(daysBack(7));

  let bestDay = null;
  analyticsDays.forEach((day, key) => {
    if (!bestDay || day.total > bestDay.total) bestDay = { key, total: day.total };
  });

  let longestSession = null;
  sessions.forEach(s => {
    if (!longestSession || s.duration > longestSession.duration) longestSession = s;
  });

  const totalSecs = sessions.reduce((sum, s) => sum + s.duration, 0);
  const streak = computeLongestStreak();
  let streakRange = '';
  if (streak.longest) {
    const end = parseDateKey(streak.longestEnd);
    const start = addDays(end, -(streak.longest - 1));
    streakRange = streak.longest === 1 ? fmtDay(end) : `${fmtDay(start)} – ${fmtDay(end)}`;
  }

  const none = 'No sessions yet';
  const tiles = [
    {
      label: 'Last 7 days',
      value: formatCompact(weekSecs),
      sub: `${formatCompact(weekSecs / 7)} a day on average`
    },
    {
      label: 'Best day',
      value: bestDay ? formatCompact(bestDay.total) : '—',
      sub: bestDay ? fmtDay(parseDateKey(bestDay.key), true) : none
    },
    {
      label: 'Longest session',
      value: longestSession ? formatCompact(longestSession.duration) : '—',
      sub: longestSession ? `${courseCode(longestSession.course_id)} · ${fmtDay(new Date(longestSession.ended_at * 1000))}` : none
    },
    {
      label: 'Average session',
      value: sessions.length ? formatCompact(totalSecs / sessions.length) : '—',
      sub: sessions.length ? `${sessions.length} ${sessions.length === 1 ? 'session' : 'sessions'} total` : none
    },
    {
      label: 'Longest streak',
      value: streak.longest ? `${streak.longest} ${streak.longest === 1 ? 'day' : 'days'}` : '—',
      sub: streak.longest ? streakRange : none
    }
  ];

  el.innerHTML = tiles.map(t => `
    <div class="summary-tile">
      <div class="summary-tile-label">${t.label}</div>
      <div class="summary-tile-value">${t.value}</div>
      <div class="summary-tile-sub" title="${escapeHtml(t.sub)}">${escapeHtml(t.sub)}</div>
    </div>
  `).join('');
}

function setTrendRange(days) {
  analyticsRange = days;
  document.querySelectorAll('[data-range]').forEach(btn => {
    const active = Number(btn.dataset.range) === days;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
  renderTrendChart();
}

function setTrendMode(mode) {
  trendMode = mode;
  document.querySelectorAll('[data-trend-mode]').forEach(btn => {
    const active = btn.dataset.trendMode === mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
  renderTrendChart();
}

// A flat line across the chart (average, goal). Never covers the data: drawn
// behind it, with no points.
function referenceLine(label, secs, count, style) {
  return {
    label,
    data: Array(count).fill(secs / 3600),
    secs: Array(count).fill(secs),
    fill: false,
    pointRadius: 0,
    pointHoverRadius: 0,
    pointHitRadius: 6,
    pointStyle: 'line',
    ...style
  };
}

function renderTrendChart() {
  const canvas = document.getElementById('focusTrendChart');
  if (!canvas) return;

  const range = analyticsRange;
  const days = daysBack(range);
  const prevDays = daysBack(range, range);
  const totalSecs = days.map(d => dayTotal(localDateKey(d)));
  const prevSecs = prevDays.map(d => dayTotal(localDateKey(d)));
  const noStudy = totalSecs.every(s => s === 0);
  const bySubject = trendMode === 'subjects';

  document.getElementById('trend-empty').classList.toggle('is-hidden', !noStudy);
  const title = document.getElementById('trend-title');
  if (title) title.innerText = `Focus Trend: Last ${range} Days`;

  const labels = days.map(d => fmtDay(d, range === 7));
  const datasets = [];

  if (bySubject) {
    subjectSeries().forEach(series => {
      const secs = days.map(d => {
        const day = analyticsDays.get(localDateKey(d));
        return day ? series.courseIds.reduce((sum, id) => sum + (day.byCourse.get(id) || 0), 0) : 0;
      });
      if (secs.every(s => s === 0)) return;
      datasets.push({
        type: 'bar',
        label: series.label,
        data: secs.map(s => s / 3600),
        secs,
        backgroundColor: series.color,
        // A 2px surface-colored top edge separates stacked segments.
        borderColor: CHART_SURFACE,
        borderWidth: { top: 2 },
        borderSkipped: 'bottom',
        maxBarThickness: 32,
        pointStyle: 'rectRounded',
        stack: 'subjects',
        order: 0
      });
    });
  } else {
    datasets.push({
      label: 'Hours studied',
      data: totalSecs.map(s => s / 3600),
      secs: totalSecs,
      borderColor: '#10b981',
      backgroundColor: 'rgba(16, 185, 129, 0.1)',
      borderWidth: 3,
      fill: true,
      // Monotone never overshoots, so the curve can't imply more hours than any
      // day actually had (or dip under zero) around a big spike.
      cubicInterpolationMode: 'monotone',
      pointBackgroundColor: '#10b981',
      pointRadius: range === 7 ? 4 : range === 30 ? 2 : 0,
      pointHoverRadius: 5,
      stack: 'main',
      order: 0
    });
  }

  // Higher order is drawn first, so every reference line sits behind the data.
  if (prevSecs.some(s => s > 0)) {
    datasets.push({
      label: `Previous ${range} days`,
      data: prevSecs.map(s => s / 3600),
      secs: prevSecs,
      dates: prevDays,
      borderColor: 'rgba(156, 163, 175, 0.45)',
      borderWidth: 1.5,
      fill: false,
      cubicInterpolationMode: 'monotone',
      pointRadius: 0,
      pointHoverRadius: 0,
      pointHitRadius: 6,
      pointStyle: 'line',
      stack: 'prev',
      order: 3
    });
  }

  datasets.push(referenceLine(`Daily goal (${formatCompact(DAILY_GOAL_SECONDS)})`, DAILY_GOAL_SECONDS, range, {
    borderColor: 'rgba(243, 244, 246, 0.4)',
    borderWidth: 1.5,
    borderDash: [2, 4],
    stack: 'goal',
    order: 2
  }));

  if (!noStudy) {
    // Average over every day in the range; days without study count as 0h.
    const avgSecs = totalSecs.reduce((sum, s) => sum + s, 0) / range;
    datasets.push(referenceLine('Daily average', avgSecs, range, {
      borderColor: '#047857',
      borderWidth: 2,
      borderDash: [6, 6],
      stack: 'avg',
      order: 1
    }));
  }

  if (trendChartInstance) trendChartInstance.destroy();
  trendChartInstance = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          align: 'end',
          labels: { usePointStyle: true, boxWidth: 8, boxHeight: 8, padding: 14, font: { size: 11 } }
        },
        tooltip: {
          // Leave out subjects with no time that day.
          filter: item => !(item.dataset.stack === 'subjects' && item.dataset.secs[item.dataIndex] === 0),
          callbacks: {
            label: ctx => {
              const ds = ctx.dataset;
              const value = formatCompact(ds.secs[ctx.dataIndex]);
              if (ds.dates) return ` ${ds.label} (${fmtDay(ds.dates[ctx.dataIndex])}): ${value}`;
              return ` ${ds.label}: ${value}`;
            },
            footer: items => (bySubject && items.length ? `Total: ${formatCompact(totalSecs[items[0].dataIndex])}` : '')
          }
        }
      },
      scales: {
        x: {
          stacked: bySubject,
          offset: bySubject,
          grid: { color: GRID_COLOR },
          ticks: { font: { size: 11 }, maxRotation: 0, autoSkip: true, maxTicksLimit: range === 7 ? 7 : 10 }
        },
        y: {
          stacked: bySubject,
          beginAtZero: true,
          grid: { color: GRID_COLOR },
          ticks: { font: { size: 11 }, callback: v => `${v}h` }
        }
      }
    }
  });
}

function renderHeatmap() {
  const grid = document.getElementById('heatmap-grid');
  if (!grid) return;
  grid.innerHTML = '';

  daysBack(90).forEach(date => {
    const day = analyticsDays.get(localDateKey(date));
    const secs = day ? day.total : 0;

    const dayDiv = document.createElement('div');
    dayDiv.className = 'heatmap-day';

    const lines = [`${fmtDay(date, true)}: ${secs ? formatCompact(secs) : 'no study'}`];
    if (day) {
      [...day.byCourse.entries()]
        .sort((a, b) => b[1] - a[1])
        .forEach(([courseId, courseSecs]) => lines.push(`${courseCode(courseId)} · ${formatCompact(courseSecs)}`));
    }
    dayDiv.title = lines.join('\n');

    // Under 1h / 1-3h / 3-6h / 6h+, so long days stand out from a typical 2-5h day.
    if (secs > 0 && secs < 3600) dayDiv.classList.add('l1');
    else if (secs >= 3600 && secs < 10800) dayDiv.classList.add('l2');
    else if (secs >= 10800 && secs < 21600) dayDiv.classList.add('l3');
    else if (secs >= 21600) dayDiv.classList.add('l4');

    grid.appendChild(dayDiv);
  });
}

function renderSubjectShare() {
  const el = document.getElementById('subject-share');
  if (!el) return;

  const totalAll = courses.reduce((sum, c) => sum + (c.total_seconds || 0), 0);
  if (!totalAll) {
    el.innerHTML = emptyState('chart-column', 'Nothing to show yet', 'Each subject\'s share appears after your first session.');
    return;
  }

  const rows = subjectSeries()
    .map(series => ({
      ...series,
      secs: series.courseIds.reduce((sum, id) => sum + ((courses.find(c => c.id === id) || {}).total_seconds || 0), 0)
    }))
    .filter(row => row.secs > 0)
    .sort((a, b) => b.secs - a.secs);

  const pctText = secs => {
    const pct = (secs / totalAll) * 100;
    return pct > 0 && pct < 1 ? '<1%' : `${Math.round(pct)}%`;
  };

  el.innerHTML = `
    <div class="share-bar">
      ${rows.map(r => `<div style="flex: ${r.secs} 1 0; background: ${r.color};" title="${escapeHtml(r.label)}: ${pctText(r.secs)}"></div>`).join('')}
    </div>
    <div class="share-list">
      ${rows.map(r => `
        <div class="share-row">
          <span class="swatch" style="background: ${r.color};"></span>
          <div class="share-row-name" title="${escapeHtml(r.title)}"><b>${escapeHtml(r.label)}</b> <span>${escapeHtml(r.title)}</span></div>
          <span class="share-row-time">${formatCompact(r.secs)}</span>
          <span class="share-row-pct">${pctText(r.secs)}</span>
        </div>
      `).join('')}
    </div>
  `;
}

function renderWeekdayChart() {
  const canvas = document.getElementById('weekdayChart');
  if (!canvas) return;

  // Average over every occurrence of each weekday since the first session,
  // so a weekday you skipped still pulls its average down.
  const sums = Array(7).fill(0);
  const counts = Array(7).fill(0);
  const keys = [...analyticsDays.keys()].sort();
  if (keys.length) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let d = parseDateKey(keys[0]); d <= today; d = addDays(d, 1)) {
      const wd = weekdayIndex(d);
      counts[wd]++;
      sums[wd] += dayTotal(localDateKey(d));
    }
  }
  const avgSecs = sums.map((sum, i) => (counts[i] ? sum / counts[i] : 0));

  document.getElementById('weekday-empty').classList.toggle('is-hidden', keys.length > 0);

  if (weekdayChartInstance) weekdayChartInstance.destroy();
  weekdayChartInstance = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: WEEKDAYS,
      datasets: [{
        label: 'Average hours',
        data: avgSecs.map(s => s / 3600),
        backgroundColor: '#10b981',
        hoverBackgroundColor: '#34d399',
        borderRadius: { topLeft: 4, topRight: 4 },
        borderSkipped: 'bottom',
        maxBarThickness: 32
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: items => WEEKDAYS_FULL[items[0].dataIndex],
            label: ctx => ` ${formatCompact(avgSecs[ctx.dataIndex])} on average`,
            afterLabel: ctx => {
              const n = counts[ctx.dataIndex];
              return ` across ${n} ${n === 1 ? WEEKDAYS_FULL[ctx.dataIndex] : WEEKDAYS_FULL[ctx.dataIndex] + 's'}`;
            }
          }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 11 } } },
        y: { beginAtZero: true, grid: { color: GRID_COLOR }, ticks: { font: { size: 11 }, callback: v => `${v}h` } }
      }
    }
  });
}

function renderHourGrid() {
  const grid = document.getElementById('hour-grid');
  const caption = document.getElementById('hour-grid-caption');
  const legend = document.getElementById('hour-grid-legend');
  if (!grid) return;

  // Spread each session over the clock hours it actually covered
  // (it ran from ended_at - duration to ended_at).
  const cells = Array.from({ length: 7 }, () => Array(24).fill(0));
  analyticsSessions.forEach(s => {
    const end = s.ended_at * 1000;
    let t = end - s.duration * 1000;
    while (t < end) {
      const d = new Date(t);
      const nextHour = new Date(d);
      nextHour.setMinutes(60, 0, 0);
      const chunkEnd = Math.min(end, nextHour.getTime());
      cells[weekdayIndex(d)][d.getHours()] += (chunkEnd - t) / 1000;
      t = chunkEnd;
    }
  });

  let max = 0;
  let peak = null;
  cells.forEach((row, wd) => row.forEach((v, h) => {
    if (v > max) {
      max = v;
      peak = { wd, h };
    }
  }));

  if (!max) {
    grid.className = '';
    grid.innerHTML = emptyState('timer', 'Nothing to show yet', 'Your study hours show up here after your first session.');
    if (caption) caption.innerText = 'Total time by weekday and hour';
    if (legend) legend.classList.add('is-hidden');
    return;
  }

  const hourLabel = h => `${String(h % 24).padStart(2, '0')}:00`;
  const level = v => {
    if (v <= 0) return '';
    const ratio = v / max;
    if (ratio <= 0.25) return 'l1';
    if (ratio <= 0.5) return 'l2';
    if (ratio <= 0.75) return 'l3';
    return 'l4';
  };

  let html = '<div></div>';
  for (let h = 0; h < 24; h++) {
    html += `<div class="hour-grid-hour">${h % 3 === 0 ? String(h).padStart(2, '0') : ''}</div>`;
  }
  cells.forEach((row, wd) => {
    html += `<div class="hour-grid-label">${WEEKDAYS[wd]}</div>`;
    row.forEach((v, h) => {
      const tip = `${WEEKDAYS_FULL[wd]} ${hourLabel(h)}–${hourLabel(h + 1)}: ${v ? formatCompact(v) + ' total' : 'no study'}`;
      html += `<div class="hour-cell ${level(v)}" title="${tip}"></div>`;
    });
  });

  grid.className = 'hour-grid';
  grid.innerHTML = html;
  if (legend) legend.classList.remove('is-hidden');

  if (caption) {
    caption.innerText = `Total time by weekday and hour. You study most on ${WEEKDAYS_FULL[peak.wd]}s, ${hourLabel(peak.h)}–${hourLabel(peak.h + 1)}.`;
  }
}

function startOfWeekKey() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - weekdayIndex(d));
  return localDateKey(d);
}

function renderSubjectCards() {
  const container = document.getElementById('analytics-list');
  if (!container) return;
  container.innerHTML = '';

  if (courses.length === 0) {
    container.innerHTML = emptyState('chart-column', 'Nothing to show yet', 'Time per subject appears here once you add one.');
    return;
  }

  // Weekly goals run on the calendar week, Monday to Sunday.
  const weekStart = startOfWeekKey();
  const weekByCourse = new Map();
  analyticsDays.forEach((day, key) => {
    if (key < weekStart) return;
    day.byCourse.forEach((secs, id) => weekByCourse.set(id, (weekByCourse.get(id) || 0) + secs));
  });

  courses.forEach(c => {
    const series = seriesForCourse(c.id);
    const goal = c.weekly_goal_seconds || 0;
    const week = weekByCourse.get(c.id) || 0;
    const tasks = taskStatsByCourse.get(c.id) || {};
    const done = Number(tasks.done) || 0;
    const total = Number(tasks.total) || 0;

    let goalHtml;
    if (editingGoalCourseId === c.id) {
      goalHtml = `
        <div class="goal-edit">
          <input type="number" id="goal-input-${c.id}" min="0" max="168" step="0.5" value="${goal ? +(goal / 3600).toFixed(2) : ''}" placeholder="0"
            aria-label="Weekly goal in hours"
            onkeydown="if (event.key === 'Enter') window.saveCourseGoal('${c.id}'); if (event.key === 'Escape') window.cancelGoalEdit();">
          <span>h / week</span>
          <button class="btn-primary" onclick="window.saveCourseGoal('${c.id}')">Save</button>
          <button class="btn-secondary" onclick="window.cancelGoalEdit()">Cancel</button>
        </div>`;
    } else if (goal) {
      const pct = Math.min(100, Math.round((week / goal) * 100));
      goalHtml = `
        <div>
          <div class="meta-row">
            <span>This week <b>${formatCompact(week)}</b> / ${formatCompact(goal)}${week >= goal ? ' · goal met' : ''}</span>
            <button class="link-btn" onclick="window.editCourseGoal('${c.id}')">Edit goal</button>
          </div>
          <div class="goal-bar" role="progressbar" aria-label="Weekly goal progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">
            <div style="width: ${pct}%;"></div>
          </div>
        </div>`;
    } else {
      goalHtml = `
        <div class="meta-row">
          <span>This week <b>${formatCompact(week)}</b></span>
          <button class="link-btn" onclick="window.editCourseGoal('${c.id}')">Set weekly goal</button>
        </div>`;
    }

    // Tasks have no completion date, so this compares all-time totals.
    let tasksHtml = '<div class="meta-row"><span>No tasks yet</span></div>';
    if (total) {
      const perTask = done ? `${formatCompact(c.total_seconds / done)} per done task` : 'None done yet';
      tasksHtml = `<div class="meta-row"><span>Tasks <b>${done}/${total}</b> done</span><span>${perTask}</span></div>`;
    }

    const card = document.createElement('div');
    card.className = 'stat-card subject-card';
    card.innerHTML = `
      <div class="subject-card-head">
        <span class="swatch" style="background: ${series.color};"></span>
        <h3>${escapeHtml(c.code)}</h3>
      </div>
      <div class="card-title" title="${escapeHtml(c.title)}">${escapeHtml(c.title)}</div>
      <div class="value">${formatHM(c.total_seconds)}</div>
      <div class="subject-meta">
        ${goalHtml}
        ${tasksHtml}
      </div>
    `;
    container.appendChild(card);
  });

  if (editingGoalCourseId) {
    const input = document.getElementById(`goal-input-${editingGoalCourseId}`);
    if (input) {
      input.focus();
      input.select();
    }
  }
}

function editCourseGoal(courseId) {
  editingGoalCourseId = courseId;
  renderSubjectCards();
}

function cancelGoalEdit() {
  editingGoalCourseId = null;
  renderSubjectCards();
}

async function saveCourseGoal(courseId) {
  const input = document.getElementById(`goal-input-${courseId}`);
  if (!input) return;

  // An empty box clears the goal.
  const hours = input.value.trim() === '' ? 0 : Number(input.value);
  if (!Number.isFinite(hours) || hours < 0 || hours > 168) {
    showToast('Enter a goal between 0 and 168 hours', { type: 'error' });
    return;
  }

  try {
    await window.api.setCourseGoal(courseId, hours * 3600);
    courses = await window.api.getCourses();
    editingGoalCourseId = null;
    renderSubjectCards();
  } catch (err) {
    console.error('Failed to save weekly goal:', err);
    showToast('Could not save the goal', { message: String(err.message || err), type: 'error' });
  }
}


async function renderHistory() {
  const history = await window.api.getHistory();
  const tbody = document.getElementById('history-table-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (history.length === 0) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="4">${emptyState('history', 'No sessions yet', 'Finished study sessions are listed here.')}</td></tr>`;
    return;
  }

  history.forEach(row => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${row.created_at}</td>
      <td><b>${row.code}</b> - ${row.title}</td>
      <td style="color: var(--accent); font-weight: 700;">${formatHM(row.duration)}</td>
      <td style="text-align: right;">
        <button class="delete-item-btn" onclick="window.handleDeleteSession(${row.id})" title="Delete log" aria-label="Delete log">${icon('trash-2', 15)}</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function handleDeleteSession(sessionId) {
  await window.api.deleteSession(sessionId);
  courses = await window.api.getCourses();
  dailyStats = await window.api.getDailyStats();
  renderHistory();
  renderCourses();
  updateMetricsDashboard();
}

async function handleExportCsv() {
  try {
    const result = await window.api.exportSessionsCsv();
    if (!result || result.canceled) return;
    showToast('Sessions exported', {
      message: `${result.count} ${result.count === 1 ? 'session' : 'sessions'} saved to ${result.filePath}`
    });
  } catch (err) {
    console.error('Failed to export sessions:', err);
    showToast('Could not export sessions', { message: String(err.message || err), type: 'error' });
  }
}


// ==========================================
// 5. ЗАДАЧИ (TASKS)
// ==========================================
async function loadTasks() {
  const currentCourse = getActiveCourse();
  const headerTitle = document.getElementById('tasks-header-title');
  if (currentCourse && headerTitle) {
    headerTitle.innerText = `${currentCourse.code} To-Do List`;
  }
  
  if (!currentCourse) return;
  const tasks = await window.api.getTasks(currentCourse.id);
  const container = document.getElementById('task-list');
  if (!container) return;
  container.innerHTML = '';

  if (tasks.length === 0) {
    container.innerHTML = emptyState('list-todo', 'No tasks yet', 'Add your first one above.');
    return;
  }

  tasks.forEach(t => {
    const div = document.createElement('div');
    div.className = `task-item ${t.completed ? 'completed' : ''}`;
    div.innerHTML = `
      <div class="task-item-left" onclick="window.handleToggleTask('${t.id}')">
        <input type="checkbox" ${t.completed ? 'checked' : ''} onclick="event.stopPropagation(); window.handleToggleTask('${t.id}')">
        <span>${t.text}</span>
      </div>
      <button class="delete-item-btn" onclick="window.handleDeleteTask('${t.id}')" title="Delete task" aria-label="Delete task">${icon('trash-2', 15)}</button>
    `;
    container.appendChild(div);
  });
}

async function handleAddTask() {
  const input = document.getElementById('new-task-text');
  if (!input) return;
  const text = input.value.trim();
  const currentCourse = getActiveCourse();
  if (text && currentCourse) {
    await window.api.addTask(currentCourse.id, text);
    input.value = '';
    loadTasks();
  }
}

async function handleToggleTask(taskId) {
  await window.api.toggleTask(taskId);
  loadTasks();
}

async function handleDeleteTask(taskId) {
  await window.api.deleteTask(taskId);
  loadTasks();
}


// ==========================================
// 6. УПРАВЛЕНИЕ КУРСАМИ (УДАЛЕНИЕ / СБРОС)
// ==========================================
async function handleDeleteCourse(courseId) {
  const course = courses.find(c => c.id === courseId);
  const confirmed = await confirmDialog({
    title: `Delete ${course.title}?`,
    message: 'Its tasks and all of its logged sessions will be deleted too. This can\'t be undone.',
    confirmLabel: 'Delete Subject'
  });
  if (confirmed) {
    await window.api.deleteCourse(courseId);
    courses = await window.api.getCourses();
    if (activeCourseId === courseId) {
      activeCourseId = courses.length > 0 ? courses[0].id : null;
    }
    init();
    showToast('Subject deleted', { message: course.title });
  }
}

async function handleDeleteActiveCourse() {
  const currentCourse = getActiveCourse();
  if (currentCourse) handleDeleteCourse(currentCourse.id);
}

async function handleResetActiveCourse() {
  const currentCourse = getActiveCourse();
  if (!currentCourse) return;
  const confirmed = await confirmDialog({
    title: `Reset time for ${currentCourse.title}?`,
    message: 'All of its logged sessions will be deleted and its total will go back to 0h 0m. This can\'t be undone.',
    confirmLabel: 'Reset Time'
  });
  if (confirmed) {
    await window.api.resetCourseTime(currentCourse.id);
    courses = await window.api.getCourses();
    dailyStats = await window.api.getDailyStats();
    init();
    showToast('Time reset', { message: currentCourse.title });
  }
}

function closeSubjectMenu() {
  document.getElementById('subject-menu').classList.add('is-hidden');
  document.getElementById('subject-menu-btn').setAttribute('aria-expanded', 'false');
}

function toggleSubjectMenu(event) {
  event.stopPropagation();
  const isOpen = document.getElementById('subject-menu').classList.toggle('is-hidden') === false;
  document.getElementById('subject-menu-btn').setAttribute('aria-expanded', String(isOpen));
}


// ==========================================
// 7. ТАЙМЕР И МОДАЛЬНЫЕ ОКНА
// ==========================================
function setMode(mode, btn) {
  if (isStudying) return;
  timerMode = mode;
  document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
  if (btn) btn.classList.add('active');
  if (mode === 'pomodoro') secondsElapsed = 25 * 60;
  else secondsElapsed = 0;
  updateTimerDisplay();
}

function initTimerButton() {
  const timerBtn = document.getElementById('timer-btn');
  const playIcon = document.getElementById('play-icon');

  if (!timerBtn || !playIcon) return;

  timerBtn.onclick = null;
  timerBtn.onclick = async () => {
    const currentCourse = getActiveCourse();
    if (!currentCourse) {
      showToast('Add a subject first', { type: 'info' });
      return;
    }

    if (!isStudying) {
      isStudying = true;
      
      if (timerMode === 'pomodoro') {
        startTime = Date.now() - ((25 * 60 - secondsElapsed) * 1000);
      } else {
        startTime = Date.now() - (secondsElapsed * 1000);
      }

      timerBtn.classList.add('running');
      playIcon.innerHTML = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';
      updateAllTimerDisplays();

      // Record the in-progress session immediately so a crash/power loss can't lose it.
      if (window.api.startActiveSession) {
        window.api.startActiveSession({
          courseId: currentCourse.id,
          startTimestamp: startTime,
          mode: timerMode
        }).catch(err => console.error('Failed to persist active session:', err));
      }

      let lastHeartbeat = Date.now();

      timerInterval = setInterval(() => {
        const now = Date.now();
        const diffSeconds = Math.floor((now - startTime) / 1000);

        if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
          lastHeartbeat = now;
          window.api.heartbeatActiveSession().catch(err => console.error('Failed to record heartbeat:', err));
        }

        if (timerMode === 'stopwatch') {
          secondsElapsed = diffSeconds;
        } else {
          const totalPomodoroTime = 25 * 60;
          secondsElapsed = Math.max(0, totalPomodoroTime - diffSeconds);

          if (secondsElapsed === 0) {
            clearInterval(timerInterval);
            isStudying = false;
            timerBtn.classList.remove('running');
            playIcon.innerHTML = '<path d="M8 5v14l11-7z"/>';
            updateAllTimerDisplays();
            if (window.api.clearActiveSession) window.api.clearActiveSession();
            window.api.saveSession(currentCourse.id, 25 * 60).then(() => {
              init();
              showToast('Pomodoro complete', { message: `25 min added to ${currentCourse.code} — ${currentCourse.title}` });
              desktopNotify('Pomodoro complete', `25 min added to ${currentCourse.code}`);
            });
            return;
          }
        }
        updateAllTimerDisplays();
      }, 500);

    } else {
      isStudying = false;
      clearInterval(timerInterval);
      timerBtn.classList.remove('running');
      playIcon.innerHTML = '<path d="M8 5v14l11-7z"/>';

      let durationToSave = timerMode === 'stopwatch' ? secondsElapsed : (25 * 60 - secondsElapsed);
      
      if (window.api.clearActiveSession) {
        await window.api.clearActiveSession().catch(err => console.error('Failed to clear active session:', err));
      }

      if (durationToSave > 30) {
        await window.api.saveSession(currentCourse.id, durationToSave);
        init();
        showSessionSaved(currentCourse, durationToSave);
      } else {
        showSessionTooShort();
      }
      
      secondsElapsed = timerMode === 'stopwatch' ? 0 : 25 * 60;
      updateAllTimerDisplays();
    }
  };
}

function updateTimerDisplay() {
  const display = document.getElementById('timer-display');
  if (!display) return;
  
  const hrs = Math.floor(secondsElapsed / 3600).toString().padStart(2, '0');
  const mins = Math.floor((secondsElapsed % 3600) / 60).toString().padStart(2, '0');
  const secs = (secondsElapsed % 60).toString().padStart(2, '0');
  
  display.innerText = timerMode === 'stopwatch' 
    ? `${hrs}:${mins}:${secs}` 
    : `${mins}:${secs}`;
}

function updateMiniTimerWidget() {
  const timerPage = document.getElementById('timer-page');
  const onTimerPage = timerPage && timerPage.classList.contains('active');
  let widget = document.getElementById('mini-timer-widget');

  // Hide the mini widget on the Focus Engine page itself (the full timer is already visible there)
  // or whenever no session is running.
  if (!isStudying || onTimerPage) {
    if (widget) widget.remove();
    return;
  }

  const course = getActiveCourse();
  const hrs = Math.floor(secondsElapsed / 3600).toString().padStart(2, '0');
  const mins = Math.floor((secondsElapsed % 3600) / 60).toString().padStart(2, '0');
  const secs = (secondsElapsed % 60).toString().padStart(2, '0');
  const timeStr = timerMode === 'stopwatch' ? `${hrs}:${mins}:${secs}` : `${mins}:${secs}`;

  if (!widget) {
    widget = document.createElement('div');
    widget.id = 'mini-timer-widget';
    widget.className = 'mini-timer-widget';
    widget.title = 'Click to return to the Focus Engine';
    widget.onclick = () => window.switchToTimerPage();
    document.body.appendChild(widget);
  }

  widget.innerHTML = `
    <span class="mini-timer-dot"></span>
    <span class="mini-timer-time">${timeStr}</span>
    <span class="mini-timer-course">${course ? course.code : ''}</span>
  `;
}

function updateAllTimerDisplays() {
  updateTimerDisplay();
  updateMiniTimerWidget();
  sendTimerStateToMain();
}

function sendTimerStateToMain() {
  if (!window.api || typeof window.api.sendTimerState !== 'function') return;

  const course = getActiveCourse();
  const hrs = Math.floor(secondsElapsed / 3600).toString().padStart(2, '0');
  const mins = Math.floor((secondsElapsed % 3600) / 60).toString().padStart(2, '0');
  const secs = (secondsElapsed % 60).toString().padStart(2, '0');
  const timeStr = timerMode === 'stopwatch' ? `${hrs}:${mins}:${secs}` : `${mins}:${secs}`;

  window.api.sendTimerState({
    isStudying,
    timeStr,
    courseLabel: course ? `${course.code} — ${course.title}` : 'No active subject'
  });
}

function openModal() { 
  const modal = document.getElementById('modal');
  if (modal) modal.classList.add('open');
  document.getElementById('modal-title').focus();
}

function closeModal() { 
  const modal = document.getElementById('modal');
  if (modal) modal.classList.remove('open'); 
}

async function handleAddCourse() {
  const titleInput = document.getElementById('modal-title');
  const codeInput = document.getElementById('modal-code');
  if (!titleInput || !codeInput) return;

  const title = titleInput.value.trim();
  const code = codeInput.value.trim();

  if (!title || !code) {
    showToast('Title and code are both required', { type: 'error' });
    return;
  }

  const newC = await window.api.addCourse(title, code);
  closeModal();
  titleInput.value = '';
  codeInput.value = '';
  activeCourseId = newC.id;
  init();
}

document.addEventListener('click', closeSubjectMenu);

document.addEventListener('keydown', (event) => {
  const addSubjectOpen = document.getElementById('modal').classList.contains('open');
  if (event.key === 'Escape') {
    closeSubjectMenu();
    if (addSubjectOpen) closeModal();
  }
  if (event.key === 'Enter' && addSubjectOpen && event.target.tagName === 'INPUT') {
    handleAddCourse();
  }
});


// ==========================================
// 8. ЭКСПОРТ В ГЛОБАЛЬНУЮ ОБЛАСТЬ ВИДИМОСТИ (WINDOW)
// ==========================================
window.selectCourse = selectCourse;
window.onTimerCourseChange = onTimerCourseChange;
window.handleDeleteSession = handleDeleteSession;
window.handleToggleTask = handleToggleTask;
window.handleDeleteTask = handleDeleteTask;
window.handleAddTask = handleAddTask;
window.handleDeleteCourse = handleDeleteCourse;
window.handleDeleteActiveCourse = handleDeleteActiveCourse;
window.handleResetActiveCourse = handleResetActiveCourse;
window.setMode = setMode;
window.openModal = openModal;
window.closeModal = closeModal;
window.handleAddCourse = handleAddCourse;
window.enableCourseEdit = enableCourseEdit;
window.saveCourseInfo = saveCourseInfo;
window.switchPage = switchPage;
window.cancelCourseEdit = cancelCourseEdit;
window.switchTab = switchTab;
window.switchToTimerPage = switchToTimerPage;
window.toggleMiniWidgetSetting = toggleMiniWidgetSetting;
window.toggleSubjectMenu = toggleSubjectMenu;
window.setTrendRange = setTrendRange;
window.setTrendMode = setTrendMode;
window.editCourseGoal = editCourseGoal;
window.cancelGoalEdit = cancelGoalEdit;
window.saveCourseGoal = saveCourseGoal;
window.handleExportCsv = handleExportCsv;


// ==========================================
// 9. АВТОМАТИЧЕСКИЙ ЗАПУСК
// ==========================================
init();