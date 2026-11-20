// The Timer page's view of the day around the clock: a timeline of today's
// sessions and a card for the subject the timer is on. This week's sessions are loaded on each data
// change; the running session is added on every timer tick without a reload.
import { icon } from './icons.js';
import { state, getActiveCourse, courseById, reloadData } from './state.js';
import { escapeHtml, formatCompact, weekdayIndex, fmtDay, parseDateKey, errorText } from './format.js';
import { courseColor, swatch } from './colors.js';
import { daysUntil, examPace } from './exams.js';
import { showToast } from './notify.js';

let sessions = [];       // since this Monday, { id, course_id, duration, ended_at }
let editingGoal = false;

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function mondayOf(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - weekdayIndex(d));
  return d;
}

// The running focus session, if any, as a session-shaped object ending now.
function liveSession() {
  const t = state.timer;
  if (!t.isStudying || t.phase !== 'focus' || !t.courseId) return null;
  return { id: 'live', course_id: t.courseId, duration: t.elapsedSecs || 0, ended_at: Math.floor(Date.now() / 1000), live: true, paused: !!t.paused };
}

function sumSince(list, from, to = Infinity, courseId = null) {
  const a = from.getTime() / 1000;
  const b = to === Infinity ? Infinity : to.getTime() / 1000;
  return list.reduce((sum, s) => (s.ended_at >= a && s.ended_at < b && (!courseId || s.course_id === courseId) ? sum + s.duration : sum), 0);
}

export async function loadToday() {
  const monday = mondayOf(new Date());
  try {
    sessions = await window.api.getSessions(Math.floor(monday.getTime() / 1000));
  } catch (err) {
    console.error('Could not load this week\'s sessions:', err);
    sessions = [];
  }
  renderToday();
}

export function renderToday() {
  renderTimeline();
  renderSubjectCard();
}

// ---------- Today's timeline ----------

function hourLabel(h) {
  const hh = ((h + 11) % 12) + 1;
  return `${hh}${h < 12 || h === 24 ? 'a' : 'p'}`;
}

function clockText(date) {
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function renderTimeline() {
  const track = document.getElementById('today-track');
  const axis = document.getElementById('today-axis');
  const legend = document.getElementById('today-legend');
  const empty = document.getElementById('today-empty');
  if (!track || !axis || !legend || !empty) return;

  const day0 = startOfToday().getTime() / 1000;
  const live = liveSession();
  const list = sessions.filter(s => s.ended_at >= day0);
  if (live) list.push(live);

  // 8am to 10pm, widened to fit any session outside it and the current hour.
  const nowHour = (Date.now() / 1000 - day0) / 3600;
  let from = 8;
  let to = 22;
  list.forEach(s => {
    from = Math.min(from, Math.floor(Math.max(0, s.ended_at - s.duration - day0) / 3600));
    to = Math.max(to, Math.ceil((s.ended_at - day0) / 3600));
  });
  from = Math.min(from, Math.floor(nowHour));
  to = Math.min(24, Math.max(to, Math.ceil(nowHour)));
  const span = (to - from) * 3600;
  const pos = (secs) => ((secs - from * 3600) / span) * 100;

  const step = to - from > 14 ? 4 : 2;
  let ticks = '';
  for (let h = Math.ceil(from / step) * step; h <= to; h += step) {
    ticks += `<span style="left: ${pos(h * 3600)}%">${hourLabel(h)}</span>`;
  }
  axis.innerHTML = ticks;

  const blocks = list.map(s => {
    const end = s.ended_at - day0;
    const start = Math.max(0, end - s.duration);
    const left = pos(start);
    const width = Math.max(0.6, pos(end) - left);
    const course = courseById(s.course_id);
    const name = course ? `${course.code} — ${course.title}` : 'Deleted subject';
    const tip = `${name}\n${clockText(new Date((day0 + start) * 1000))} – ${s.live ? 'now' : clockText(new Date(s.ended_at * 1000))} · ${formatCompact(s.duration)}`;
    return `<div class="today-block${s.live ? ' live' : ''}${s.paused ? ' paused' : ''}" style="left: ${left}%; width: ${width}%; --c: ${courseColor(course)}" title="${escapeHtml(tip)}"></div>`;
  }).join('');
  const now = nowHour >= from && nowHour <= to ? `<div class="today-now" style="left: ${pos(nowHour * 3600)}%" title="Now"></div>` : '';
  const grid = Array.from({ length: to - from - 1 }, (_, i) => `<div class="today-grid" style="left: ${pos((from + i + 1) * 3600)}%"></div>`).join('');
  track.innerHTML = grid + blocks + now;

  empty.classList.toggle('is-hidden', list.length > 0);

  const byCourse = new Map();
  list.forEach(s => byCourse.set(s.course_id, (byCourse.get(s.course_id) || 0) + s.duration));
  legend.innerHTML = [...byCourse.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, secs]) => {
      const c = courseById(id);
      return `<span class="today-legend-item">${swatch(c)}${escapeHtml(c ? c.code : 'Deleted')} <b>${formatCompact(secs)}</b></span>`;
    }).join('');
}

// ---------- The subject the timer is on ----------

function renderSubjectCard() {
  const box = document.getElementById('subject-box');
  if (!box) return;
  const course = getActiveCourse();
  box.classList.toggle('is-hidden', !course);
  if (!course) return;

  const live = liveSession();
  const all = live ? [...sessions, live] : sessions;
  const id = escapeHtml(course.id);
  const week = sumSince(all, mondayOf(new Date()), Infinity, course.id);
  const today = sumSince(all, startOfToday(), Infinity, course.id);
  const goal = course.weekly_goal_seconds || 0;
  const liveTotal = (course.total_seconds || 0) + (live && live.course_id === course.id ? live.duration : 0);

  let goalHtml;
  if (editingGoal) {
    goalHtml = `
      <div class="goal-edit">
        <input type="number" id="today-goal-input" min="0" max="168" step="0.5" value="${goal ? +(goal / 3600).toFixed(2) : ''}" placeholder="0"
          aria-label="Weekly goal in hours"
          onkeydown="if (event.key === 'Enter') window.saveTodayGoal(); if (event.key === 'Escape') window.editTodayGoal(false);">
        <span>h / week</span>
        <button class="btn-primary" onclick="window.saveTodayGoal()">Save</button>
        <button class="btn-secondary" onclick="window.editTodayGoal(false)">Cancel</button>
      </div>`;
  } else if (goal) {
    const pct = Math.min(100, Math.round((week / goal) * 100));
    const left = goal - week;
    const daysLeft = 7 - weekdayIndex(new Date());
    const pace = left > 0 ? `${formatCompact(left)} to go · about ${formatCompact(left / daysLeft)} a day` : 'Goal met this week';
    goalHtml = `
      <div class="meta-row">
        <span>This week <b>${formatCompact(week)}</b> / ${formatCompact(goal)}</span>
        <button class="link-btn" onclick="window.editTodayGoal(true)">Edit goal</button>
      </div>
      <div class="goal-bar" role="progressbar" aria-label="Weekly goal progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">
        <div style="width: ${pct}%;"></div>
      </div>
      <div class="subject-box-note">${pace}</div>`;
  } else {
    goalHtml = `
      <div class="meta-row">
        <span>This week <b>${formatCompact(week)}</b></span>
        <button class="link-btn" onclick="window.editTodayGoal(true)">Set weekly goal</button>
      </div>`;
  }

  let examHtml = '';
  if (course.exam_date && daysUntil(course.exam_date) >= 0) {
    const days = daysUntil(course.exam_date);
    const when = days === 0 ? 'Exam today' : days === 1 ? 'Exam tomorrow' : `Exam in ${days} days`;
    const pace = examPace(course);
    const paceText = pace ? (pace.left ? ` · ${formatCompact(pace.left)} left of ${formatCompact(pace.target)}` : ' · hours target reached') : '';
    examHtml = `
      <button class="subject-exam${days <= 7 ? ' soon' : ''}" onclick="window.openExamDialog('${id}')" title="Edit exam">
        ${icon('calendar', 14)}<b>${when}</b><span>${escapeHtml(fmtDay(parseDateKey(course.exam_date), true))}${paceText}</span>
      </button>`;
  }

  box.style.setProperty('--subject-color', courseColor(course));
  box.innerHTML = `
    <div class="subject-box-head">
      ${swatch(course)}
      <div class="subject-box-name">
        <b>${escapeHtml(course.code)}</b>
        <span title="${escapeHtml(course.title)}">${escapeHtml(course.title)}</span>
      </div>
      ${course.term ? `<span class="tasks-subject">${escapeHtml(course.term)}</span>` : ''}
    </div>
    <div class="subject-box-stats">
      <div><span>Today</span><b>${formatCompact(today)}</b></div>
      <div><span>This week</span><b>${formatCompact(week)}</b></div>
      <div><span>All time</span><b>${formatCompact(liveTotal)}</b></div>
    </div>
    <div class="subject-box-goal">${goalHtml}</div>
    ${examHtml}`;

  if (editingGoal) {
    const input = document.getElementById('today-goal-input');
    input?.focus();
    input?.select();
  }
}

export function editTodayGoal(on) {
  editingGoal = on;
  renderSubjectCard();
}

export async function saveTodayGoal() {
  const course = getActiveCourse();
  const input = document.getElementById('today-goal-input');
  if (!course || !input) return;
  const hours = input.value.trim() === '' ? 0 : Number(input.value);
  if (!Number.isFinite(hours) || hours < 0 || hours > 168) {
    showToast('Enter a goal between 0 and 168 hours', { type: 'error' });
    return;
  }
  try {
    await window.api.setCourseGoal(course.id, hours * 3600);
    editingGoal = false;
    await reloadData();
  } catch (err) {
    showToast('Could not save the goal', { message: errorText(err), type: 'error' });
  }
}

// Called on each timer tick: only what the running session changes, at most
// once every few seconds, since the numbers move by the minute.
let lastLive = 0;
export function renderTodayLive() {
  const now = Date.now();
  const running = state.timer.isStudying && state.timer.phase === 'focus';
  if (running && now - lastLive < 5000) return;
  lastLive = now;
  renderTimeline();
  if (!editingGoal) renderSubjectCard();
}

// Keep the "now" line and the day boundary current while nothing is running.
setInterval(() => { if (!document.hidden && !state.timer.isStudying) renderTimeline(); }, 60000);
