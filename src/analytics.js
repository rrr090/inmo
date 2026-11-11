// The Analytics page: summary tiles, trend and weekday charts, heatmap, the
// weekday × hour grid, subject share and per-subject cards with weekly goals.
import { showToast } from './notify.js';
import { state, activeCourses, reloadData } from './state.js';
import { escapeHtml, formatHM, formatCompact, localDateKey, parseDateKey, addDays, daysBack, fmtDay, weekdayIndex, emptyState, errorText } from './format.js';

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

function courseCode(courseId) {
  const course = state.courses.find(c => c.id === courseId);
  return course ? course.code : 'Deleted subject';
}

function subjectSeries() {
  const named = state.courses.length > SUBJECT_COLORS.length ? SUBJECT_COLORS.length - 1 : state.courses.length;
  const series = state.courses.slice(0, named).map((c, i) => ({
    key: c.id, label: c.code, title: c.title, color: SUBJECT_COLORS[i], courseIds: [c.id]
  }));
  if (state.courses.length > named) {
    const rest = state.courses.slice(named);
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

export async function renderAnalyticsPage() {
  try {
    const [sessions, taskStats] = await Promise.all([window.api.getSessions(), window.api.getTaskStats()]);
    analyticsSessions = sessions;
    analyticsDays = buildDayMap(sessions);
    taskStatsByCourse = new Map(taskStats.map(t => [t.course_id, t]));
  } catch (err) {
    console.error('Failed to load analytics:', err);
    showToast('Could not load analytics', { message: errorText(err), type: 'error' });
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

export function isAnalyticsPageActive() {
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

export function setTrendRange(days) {
  analyticsRange = days;
  document.querySelectorAll('[data-range]').forEach(btn => {
    const active = Number(btn.dataset.range) === days;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
  renderTrendChart();
}

export function setTrendMode(mode) {
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

  datasets.push(referenceLine(`Daily goal (${formatCompact(state.dailyGoalSecs)})`, state.dailyGoalSecs, range, {
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

  const totalAll = state.courses.reduce((sum, c) => sum + (c.total_seconds || 0), 0);
  if (!totalAll) {
    el.innerHTML = emptyState('chart-column', 'Nothing to show yet', 'Each subject\'s share appears after your first session.');
    return;
  }

  const rows = subjectSeries()
    .map(series => ({
      ...series,
      secs: series.courseIds.reduce((sum, id) => sum + ((state.courses.find(c => c.id === id) || {}).total_seconds || 0), 0)
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

  if (activeCourses().length === 0) {
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

  activeCourses().forEach(c => {
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

export function editCourseGoal(courseId) {
  editingGoalCourseId = courseId;
  renderSubjectCards();
}

export function cancelGoalEdit() {
  editingGoalCourseId = null;
  renderSubjectCards();
}

export async function saveCourseGoal(courseId) {
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
    editingGoalCourseId = null;
    await reloadData();
    renderSubjectCards();
  } catch (err) {
    console.error('Failed to save weekly goal:', err);
    showToast('Could not save the goal', { message: errorText(err), type: 'error' });
  }
}
