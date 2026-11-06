import { icon, renderIcons } from './icons.js';
import { showToast, confirmDialog, desktopNotify } from './notify.js';

// ==========================================
// 1. СОСТОЯНИЕ ПРИЛОЖЕНИЯ
// ==========================================
let courses = [];
let activeCourseId = null;
let dailyStats = [];
let chartInstance = null;

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
    renderAnalytics();
    renderHeatmap();
    await renderTrendChart();
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
  const targetSeconds = 7200; 
  
  const progressPercent = Math.min(100, Math.round((todaySeconds / targetSeconds) * 100));
  const todayMins = Math.floor(todaySeconds / 60);
  
  const progressText = document.getElementById('daily-progress-text');
  const progressFill = document.getElementById('daily-progress-fill');
  if (progressText) progressText.innerText = `${todayMins}m / 120m`;
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
async function renderTrendChart() {
  const analyticsData = await window.api.getAnalyticsBreakdown();
  const trend = analyticsData.trend;
  const comp = analyticsData.comparison;

  const prevWeek = comp.previous_week || 0;
  const currWeek = comp.current_week || 0;

  let pctChange = 0;
  let pctDisplay = '0%';
  if (prevWeek > 0) {
    // Normal case: real previous-week data to compare against
    pctChange = Math.round(((currWeek - prevWeek) / prevWeek) * 100);
    pctDisplay = `${pctChange > 0 ? '+' : ''}${pctChange}%`;
  } else if (currWeek > 0) {
    // No previous-week data but studied this week: show as new activity instead of a bogus % (was dividing by a fake "1")
    pctChange = 100;
    pctDisplay = 'New';
  }

  const badgeColor = pctChange >= 0 ? 'var(--accent)' : 'var(--danger)';

  const compBadge = document.getElementById('weekly-comparison-badge');
  if (compBadge) {
    compBadge.innerHTML = `Week-over-Week: <span style="color: ${badgeColor};">${pctDisplay}</span>`;
  }

  const labels = [];
  const dataPoints = [];
  for (let i = 6; i >= 0; i--) {
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() - i);
    const ds = localDateKey(targetDate);
    labels.push(targetDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }));
    
    const found = trend.find(t => t.date === ds);
    const hours = found ? (found.total_seconds / 3600).toFixed(1) : 0;
    dataPoints.push(hours);
  }

  const noRecentStudy = dataPoints.every(hours => Number(hours) === 0);
  document.getElementById('trend-empty').classList.toggle('is-hidden', !noRecentStudy);

  const canvas = document.getElementById('focusTrendChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (chartInstance) chartInstance.destroy();

  chartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Hours Studied',
        data: dataPoints,
        borderColor: '#10b981',
        backgroundColor: 'rgba(16, 185, 129, 0.1)',
        borderWidth: 3,
        fill: true,
        // Monotone never overshoots, so the curve can't imply more hours than any
        // day actually had (or dip under zero) around a big spike.
        cubicInterpolationMode: 'monotone',
        pointBackgroundColor: '#10b981',
        pointRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#9ca3af', font: { size: 11 } } },
        y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#9ca3af', font: { size: 11 } }, beginAtZero: true }
      }
    }
  });
}

function renderHeatmap() {
  const grid = document.getElementById('heatmap-grid');
  if (!grid) return;
  grid.innerHTML = '';
  
  for (let i = 89; i >= 0; i--) {
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() - i);
    const ds = localDateKey(targetDate);
    const record = dailyStats.find(item => item.date === ds);
    const secs = record ? record.total_seconds : 0;
    
    const dayDiv = document.createElement('div');
    dayDiv.className = 'heatmap-day';
    dayDiv.title = `${ds}: ${Math.round(secs / 60)} mins studied`;
    
    // Under 1h / 1-3h / 3-6h / 6h+, so long days stand out from a typical 2-5h day.
    if (secs > 0 && secs < 3600) dayDiv.classList.add('l1');
    else if (secs >= 3600 && secs < 10800) dayDiv.classList.add('l2');
    else if (secs >= 10800 && secs < 21600) dayDiv.classList.add('l3');
    else if (secs >= 21600) dayDiv.classList.add('l4');
    
    grid.appendChild(dayDiv);
  }
}

function renderAnalytics() {
  const container = document.getElementById('analytics-list');
  if (!container) return;
  container.innerHTML = '';

  if (courses.length === 0) {
    container.innerHTML = emptyState('chart-column', 'Nothing to show yet', 'Time per subject appears here once you add one.');
    return;
  }

  courses.forEach(c => {
    const card = document.createElement('div');
    card.className = 'stat-card';
    card.innerHTML = `
      <h3>${c.code}</h3>
      <div style="font-weight: 700; margin-bottom: 4px; font-size: 14px;">${c.title}</div>
      <div class="value">${formatHM(c.total_seconds)}</div>
    `;
    container.appendChild(card);
  });
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


// ==========================================
// 9. АВТОМАТИЧЕСКИЙ ЗАПУСК
// ==========================================
init();