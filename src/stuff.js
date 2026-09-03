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


// ==========================================
// 2. ИНИЦИАЛИЗАЦИЯ И УПРАВЛЕНИЕ КУРСАМИ
// ==========================================
async function init() {
  try {
    injectCustomScrollbarStyles();

    courses = await window.api.getCourses();
    dailyStats = await window.api.getDailyStats();
      
    if (courses.length > 0 && !activeCourseId) {
      activeCourseId = courses[0].id;
    }

    renderCourses();
    renderTimerCourseSelect();
    updateMetricsDashboard();
    loadTasks();
    initTimerButton();
  } catch (err) {
    console.error('Initialization error:', err);
  }
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
  `;
  document.head.appendChild(style);
}

function getActiveCourse() {
  return courses.find(c => c.id === activeCourseId) || courses[0] || null;
}

function renderCourses() {
  const list = document.getElementById('course-list');
  if (!list) return;
  list.innerHTML = '';
  
  courses.forEach(course => {
    const item = document.createElement('div');
    item.className = `course-item ${activeCourseId === course.id ? 'active' : ''}`;
    item.id = `course-row-${course.id}`;
    
    item.innerHTML = `
      <div class="course-info" onclick="window.selectCourse('${course.id}')" style="cursor: pointer; flex-grow: 1; overflow: hidden;">
        <div class="title" id="course-title-${course.id}" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${course.title}</div>
        <div class="code" id="code-container-${course.id}">
          <span id="code-text-${course.id}">${course.code}</span> 
          • ${formatHM(course.total_seconds)}
        </div>
      </div>
      <div style="display: flex; gap: 4px; align-items: center; flex-shrink: 0;">
        <button style="background: transparent; border: none; color: #94a3b8; padding: 2px 4px; border-radius: 4px; cursor: pointer; font-size: 11px; opacity: 0.5; transition: opacity 0.2s, color 0.2s;" onmouseover="this.style.opacity='1'; this.style.color='#ffffff'" onmouseout="this.style.opacity='0.5'; this.style.color='#94a3b8'" onclick="event.stopPropagation(); window.enableCourseEdit('${course.id}', '${course.title.replace(/'/g, "\\'")}', '${course.code}')" title="Edit Course">Edit</button>
        <button class="delete-course-btn" title="Delete Course" onclick="event.stopPropagation(); window.handleDeleteCourse('${course.id}')" style="background: transparent; border: none; color: #ef4444; cursor: pointer; font-size: 16px; padding: 0 4px; opacity: 0.7;" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.7'">×</button>
      </div>
    `;
    list.appendChild(item);
  });
}

function enableCourseEdit(courseId, currentTitle, currentCode) {
  const itemRow = document.getElementById(`course-row-${courseId}`);
  if (!itemRow) return;

  itemRow.innerHTML = `
    <div style="display: flex; flex-direction: column; gap: 6px; width: 100%; padding: 4px;" onclick="event.stopPropagation()">
      <input type="text" id="edit-title-${courseId}" value="${currentTitle}" placeholder="Course Title" style="background: var(--bg-main); border: 1px solid var(--accent); color: white; padding: 4px 6px; border-radius: 4px; font-size: 13px; width: 100%;" />
      <div style="display: flex; gap: 6px; align-items: center;">
        <input type="text" id="edit-code-${courseId}" value="${currentCode}" placeholder="Code" style="background: var(--bg-main); border: 1px solid var(--accent); color: white; padding: 3px 6px; border-radius: 4px; font-size: 12px; width: 80px;" />
        <button id="save-info-btn-${courseId}" style="background: var(--accent); border: none; color: black; border-radius: 3px; padding: 3px 8px; cursor: pointer; font-weight: bold; font-size: 12px;">Save</button>
        <button id="cancel-info-btn-${courseId}" style="background: transparent; border: 1px solid var(--border-color); color: white; border-radius: 3px; padding: 3px 6px; cursor: pointer; font-size: 12px;">Cancel</button>
      </div>
    </div>
  `;

  const titleInput = document.getElementById(`edit-title-${courseId}`);
  if (titleInput) {
    titleInput.focus();
    titleInput.select();
  }

  document.getElementById(`save-info-btn-${courseId}`).onclick = async (e) => {
    e.stopPropagation();
    await window.saveCourseInfo(courseId);
  };

  document.getElementById(`cancel-info-btn-${courseId}`).onclick = (e) => {
    e.stopPropagation();
    renderCourses();
  };
}

async function saveCourseInfo(courseId) {
  const titleInput = document.getElementById(`edit-title-${courseId}`);
  const codeInput = document.getElementById(`edit-code-${courseId}`);
  if (!titleInput || !codeInput) return;

  const newTitle = titleInput.value.trim();
  const newCode = codeInput.value.trim();

  if (!newTitle || !newCode) {
    alert('Title and Code cannot be empty!');
    return;
  }

  try {
    if (window.api.updateCourse) {
      await window.api.updateCourse({ courseId, title: newTitle, code: newCode });
    } else {
      await window.api.updateCourseCode({ courseId, newCode });
    }

    courses = await window.api.getCourses();
    renderCourses();
    renderTimerCourseSelect();
    loadTasks();
  } catch (err) {
    console.error('Failed to update course info:', err);
  }
}

function renderTimerCourseSelect() {
  const select = document.getElementById('global-timer-course-select');
  if (!select) return;
  select.innerHTML = '';
  courses.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.innerText = `${c.code} - ${c.title}`;
    if (c.id === activeCourseId) opt.selected = true;
    select.appendChild(opt);
  });
}

function selectCourse(id) {
  activeCourseId = id;
  renderCourses();
  renderTimerCourseSelect();
  loadTasks();
}

function onTimerCourseChange(id) {
  activeCourseId = id;
  renderCourses();
  loadTasks();
}

function formatHM(totalSecs) {
  const hrs = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  return `${hrs}h ${mins}m`;
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
}

function updateMetricsDashboard() {
  const todayStr = new Date().toISOString().split('T')[0];
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
    const ds = d.toISOString().split('T')[0];
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
  const streakBadge = document.getElementById('streak-days-badge');
  if (streakVal) streakVal.innerText = `${streak} Days in a row`;
  if (streakBadge) streakBadge.innerText = `${streak} day streak`;
}


// ==========================================
// 4. АНАЛИТИКА, ГРАФИКИ И ИСТОРИЯ
// ==========================================
async function renderTrendChart() {
  const analyticsData = await window.api.getAnalyticsBreakdown();
  const trend = analyticsData.trend;
  const comp = analyticsData.comparison;

  const prev = comp.previous_week || 1;
  const curr = comp.current_week || 0;
  const pctChange = Math.round(((curr - prev) / prev) * 100);
  const badgeColor = pctChange >= 0 ? 'var(--accent)' : 'var(--danger)';
  const sign = pctChange > 0 ? '+' : '';
  
  const compBadge = document.getElementById('weekly-comparison-badge');
  if (compBadge) {
    compBadge.innerHTML = `Week-over-Week: <span style="color: ${badgeColor};">${sign}${pctChange}%</span>`;
  }

  const labels = [];
  const dataPoints = [];
  for (let i = 6; i >= 0; i--) {
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() - i);
    const ds = targetDate.toISOString().split('T')[0];
    labels.push(targetDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }));
    
    const found = trend.find(t => t.date === ds);
    const hours = found ? (found.total_seconds / 3600).toFixed(1) : 0;
    dataPoints.push(hours);
  }

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
        tension: 0.35,
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
    const ds = targetDate.toISOString().split('T')[0];
    const record = dailyStats.find(item => item.date === ds);
    const secs = record ? record.total_seconds : 0;
    
    const dayDiv = document.createElement('div');
    dayDiv.className = 'heatmap-day';
    dayDiv.title = `${ds}: ${Math.round(secs / 60)} mins studied`;
    
    if (secs > 0 && secs < 1800) dayDiv.classList.add('l1');
    else if (secs >= 1800 && secs < 3600) dayDiv.classList.add('l2');
    else if (secs >= 3600 && secs < 7200) dayDiv.classList.add('l3');
    else if (secs >= 7200) dayDiv.classList.add('l4');
    
    grid.appendChild(dayDiv);
  }
}

function renderAnalytics() {
  const container = document.getElementById('analytics-list');
  if (!container) return;
  container.innerHTML = '';
  
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
  
  history.forEach(row => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${row.created_at}</td>
      <td><b>${row.code}</b> - ${row.title}</td>
      <td style="color: var(--accent); font-weight: 700;">${formatHM(row.duration)}</td>
      <td style="text-align: right;">
        <button class="delete-item-btn" onclick="window.handleDeleteSession(${row.id})" title="Delete log">🗑️</button>
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
  
  tasks.forEach(t => {
    const div = document.createElement('div');
    div.className = `task-item ${t.completed ? 'completed' : ''}`;
    div.innerHTML = `
      <div class="task-item-left" onclick="window.handleToggleTask('${t.id}')">
        <input type="checkbox" ${t.completed ? 'checked' : ''} onclick="event.stopPropagation(); window.handleToggleTask('${t.id}')">
        <span>${t.text}</span>
      </div>
      <button class="delete-item-btn" onclick="window.handleDeleteTask('${t.id}')">🗑️</button>
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
  if (confirm('Delete this course, its tasks, and history logs?')) {
    await window.api.deleteCourse(courseId);
    courses = await window.api.getCourses();
    if (activeCourseId === courseId) {
      activeCourseId = courses.length > 0 ? courses[0].id : null;
    }
    init();
  }
}

async function handleDeleteActiveCourse() {
  const currentCourse = getActiveCourse();
  if (currentCourse) handleDeleteCourse(currentCourse.id);
}

async function handleResetActiveCourse() {
  const currentCourse = getActiveCourse();
  if (!currentCourse) return;
  if (confirm(`Reset all accumulated time for ${currentCourse.title}?`)) {
    await window.api.resetCourseTime(currentCourse.id);
    courses = await window.api.getCourses();
    dailyStats = await window.api.getDailyStats();
    init();
  }
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
      alert('Please select or create a subject first!');
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

      timerInterval = setInterval(() => {
        const now = Date.now();
        const diffSeconds = Math.floor((now - startTime) / 1000);

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
            window.api.saveSession(currentCourse.id, 25 * 60).then(() => {
              init();
              alert('Pomodoro session completed and saved!');
            });
            return;
          }
        }
        updateTimerDisplay();
      }, 500);

    } else {
      isStudying = false;
      clearInterval(timerInterval);
      timerBtn.classList.remove('running');
      playIcon.innerHTML = '<path d="M8 5v14l11-7z"/>';

      let durationToSave = timerMode === 'stopwatch' ? secondsElapsed : (25 * 60 - secondsElapsed);
      
      if (durationToSave > 30) {
        await window.api.saveSession(currentCourse.id, durationToSave);
        init();
      }
      
      secondsElapsed = timerMode === 'stopwatch' ? 0 : 25 * 60;
      updateTimerDisplay();
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

function openModal() { 
  const modal = document.getElementById('modal');
  if (modal) modal.classList.add('open'); 
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
  
  if (title && code) {
    const newC = await window.api.addCourse(title, code);
    closeModal();
    titleInput.value = '';
    codeInput.value = '';
    activeCourseId = newC.id;
    init();
  }
}


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


// ==========================================
// 9. АВТОМАТИЧЕСКИЙ ЗАПУСК
// ==========================================
init();