// The weekly review: one calendar week (Monday to Sunday) at a glance. Opens
// by itself the first time inmo is used each week, and from Analytics any time.
import { icon } from './icons.js';
import { showToast } from './notify.js';
import { state, activeCourses, courseById } from './state.js';
import { escapeHtml, formatCompact, localDateKey, parseDateKey, addDays, fmtDay, weekdayIndex, errorText } from './format.js';
import { swatch } from './colors.js';
import { daysUntil } from './exams.js';
import { dueLabel } from './tasks.js';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const SEEN_KEY = 'weekly_review_seen';

function mondayOf(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - weekdayIndex(d));
  return d;
}

// Totals for the week starting `monday`. A session counts on the day it
// ended, as everywhere else in inmo.
export function weekData(sessions, monday) {
  const keys = Array.from({ length: 7 }, (_, i) => localDateKey(addDays(monday, i)));
  const byDay = Array(7).fill(0);
  const byCourse = new Map();
  let count = 0;
  let longest = 0;
  sessions.forEach(s => {
    const day = keys.indexOf(localDateKey(new Date(s.ended_at * 1000)));
    if (day < 0) return;
    byDay[day] += s.duration;
    byCourse.set(s.course_id, (byCourse.get(s.course_id) || 0) + s.duration);
    count++;
    longest = Math.max(longest, s.duration);
  });
  const total = byDay.reduce((a, b) => a + b, 0);
  return { monday, keys, byDay, byCourse, count, longest, total };
}

// Opens last week's review once per week, if there's anything to look back on.
export async function maybeShowWeeklyReview() {
  try {
    if ((await window.api.getSetting('weekly_review')) === 'false') return;
    const thisMonday = localDateKey(mondayOf(new Date()));
    if ((await window.api.getSetting(SEEN_KEY)) === thisMonday) return;
    // Deciding whether to show it only needs last week; the modal loads the rest.
    const since = Math.floor(addDays(mondayOf(new Date()), -15).getTime() / 1000);
    const sessions = await window.api.getSessions(since);
    await window.api.setSetting(SEEN_KEY, thisMonday);
    const last = weekData(sessions, addDays(mondayOf(new Date()), -7));
    if (last.total > 0 && !document.querySelector('.modal-overlay.open')) openWeeklyReview(1);
  } catch (err) {
    console.error('Weekly review check failed:', err);
  }
}

function delta(now, before) {
  if (!before) return now ? 'Nothing the week before' : '';
  const diff = now - before;
  if (Math.abs(diff) < 60) return 'Same as the week before';
  return `${diff > 0 ? '+' : '−'}${formatCompact(Math.abs(diff))} vs the week before`;
}

function dayBars(week, isCurrent) {
  const goal = state.dailyGoalSecs;
  const top = Math.max(goal, ...week.byDay) || 1;
  const today = localDateKey(new Date());
  return `
    <div class="review-days" role="img" aria-label="Time each day">
      <div class="review-goal-line" style="--goal: ${goal / top};" title="Daily goal: ${formatCompact(goal)}"></div>
      ${week.byDay.map((secs, i) => {
        const future = isCurrent && week.keys[i] > today;
        return `
          <div class="review-day ${secs >= goal ? 'met' : ''} ${future ? 'future' : ''}" title="${WEEKDAYS[i]}: ${secs ? formatCompact(secs) : 'no study'}">
            <div class="review-day-bar"><div style="height: ${(secs / top) * 100}%;"></div></div>
            <div class="review-day-label">${WEEKDAYS[i]}</div>
            <div class="review-day-value">${secs ? formatCompact(secs) : '–'}</div>
          </div>`;
      }).join('')}
    </div>`;
}

function subjectRows(week) {
  // Every subject in the library, plus archived ones that got time this week.
  const courses = state.courses.filter(c => !c.archived || week.byCourse.get(c.id));
  if (!courses.length) return '';
  const rows = courses
    .map(c => ({ c, secs: week.byCourse.get(c.id) || 0 }))
    .sort((a, b) => b.secs - a.secs);
  return `
    <h3 class="review-heading">By subject</h3>
    <div class="review-subjects">
      ${rows.map(({ c, secs }) => {
        const goal = c.weekly_goal_seconds || 0;
        let status = secs ? '' : '<span class="review-flag">Not studied</span>';
        let bar = '';
        if (goal) {
          const pct = Math.min(100, Math.round((secs / goal) * 100));
          status = secs >= goal
            ? '<span class="review-ok">Goal met</span>'
            : `<span class="review-flag">${formatCompact(goal - secs)} short of ${formatCompact(goal)}</span>`;
          bar = `<div class="goal-bar"><div style="width: ${pct}%;"></div></div>`;
        }
        return `
          <div class="review-subject">
            <div class="review-subject-row">
              <span class="review-subject-name">${swatch(c)}<b>${escapeHtml(c.code)}</b> <span>${escapeHtml(c.title)}</span></span>
              ${status}
              <span class="review-subject-time">${secs ? formatCompact(secs) : '0m'}</span>
            </div>
            ${bar}
          </div>`;
      }).join('')}
    </div>`;
}

function tasksDone(done) {
  if (!done.length) return '';
  const shown = done.slice(-6).reverse();
  return `
    <h3 class="review-heading">${done.length} ${done.length === 1 ? 'task' : 'tasks'} done</h3>
    <ul class="review-list">
      ${shown.map(t => `<li>${icon('circle-check', 13)}<span>${escapeHtml(t.text)}</span><span class="review-muted">${escapeHtml(courseById(t.course_id)?.code || '')}</span></li>`).join('')}
      ${done.length > shown.length ? `<li class="review-muted">and ${done.length - shown.length} more</li>` : ''}
    </ul>`;
}

// Exams in the next two weeks and tasks due in the next one, from today.
function comingUp(due) {
  const exams = activeCourses()
    .filter(c => c.exam_date && daysUntil(c.exam_date) >= 0 && daysUntil(c.exam_date) <= 14)
    .sort((a, b) => a.exam_date.localeCompare(b.exam_date));
  if (!exams.length && !due.length) return '';
  const examRows = exams.map(c => {
    const days = daysUntil(c.exam_date);
    const when = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
    return `<li>${icon('calendar', 13)}<span>${swatch(c)}<b>${escapeHtml(c.code)}</b> exam ${when}</span><span class="review-muted">${escapeHtml(fmtDay(parseDateKey(c.exam_date), true))}</span></li>`;
  });
  const taskRows = due.slice(0, 6).map(t => {
    const label = dueLabel(t.due_date);
    return `<li>${icon('list-todo', 13)}<span>${escapeHtml(t.text)} <span class="review-muted">${escapeHtml(t.code)}</span></span><span class="due-badge ${label.level}">${escapeHtml(label.text)}</span></li>`;
  });
  if (due.length > 6) taskRows.push(`<li class="review-muted">and ${due.length - 6} more tasks due</li>`);
  return `
    <h3 class="review-heading">Coming up</h3>
    <ul class="review-list">${examRows.join('')}${taskRows.join('')}</ul>`;
}

async function reviewHtml(weeksBack, sessions) {
  const monday = addDays(mondayOf(new Date()), -7 * weeksBack);
  const week = weekData(sessions, monday);
  const before = weekData(sessions, addDays(monday, -7));
  const isCurrent = weeksBack === 0;
  const from = Math.floor(monday.getTime() / 1000);
  const to = Math.floor(addDays(monday, 7).getTime() / 1000);
  const [done, due] = await Promise.all([
    window.api.getCompletedTasks(from, to),
    weeksBack <= 1 ? window.api.getDueTasks(localDateKey(addDays(new Date(), 7))) : Promise.resolve([]),
  ]);

  const goal = state.dailyGoalSecs;
  const elapsedDays = isCurrent ? weekdayIndex(new Date()) + 1 : 7;
  const daysStudied = week.byDay.filter(s => s > 0).length;
  const goalDays = week.byDay.filter(s => s >= goal).length;
  const best = week.byDay.indexOf(Math.max(...week.byDay));
  const title = isCurrent ? 'This week so far' : weeksBack === 1 ? 'Last week' : `${weeksBack} weeks ago`;
  const range = `${fmtDay(monday, true)} – ${fmtDay(addDays(monday, 6), true)}`;

  const tiles = [
    { label: 'Studied', value: formatCompact(week.total), sub: isCurrent ? `${formatCompact(week.total / elapsedDays)} a day so far` : delta(week.total, before.total) },
    { label: 'Days studied', value: `${daysStudied} of ${elapsedDays}`, sub: week.total ? `Best: ${WEEKDAYS[best]}, ${formatCompact(week.byDay[best])}` : 'No study' },
    { label: 'Daily goal met', value: `${goalDays} ${goalDays === 1 ? 'day' : 'days'}`, sub: `Goal: ${formatCompact(goal)} a day` },
    { label: 'Sessions', value: String(week.count), sub: week.count ? `Longest ${formatCompact(week.longest)}` : '—' },
  ];

  return `
    <div class="review-head">
      <div>
        <h2 id="review-title">${title}</h2>
        <div class="review-range">${range}</div>
      </div>
      <div class="review-nav">
        <button class="icon-btn" data-nav="older" title="Week before (←)" aria-label="Week before">${icon('chevron-left', 16)}</button>
        <button class="icon-btn" data-nav="newer" title="Week after (→)" aria-label="Week after" ${isCurrent ? 'disabled' : ''}>${icon('chevron-right', 16)}</button>
      </div>
    </div>
    <div class="review-tiles">
      ${tiles.map(t => `
        <div class="summary-tile">
          <div class="summary-tile-label">${t.label}</div>
          <div class="summary-tile-value">${t.value}</div>
          <div class="summary-tile-sub" title="${escapeHtml(t.sub)}">${escapeHtml(t.sub)}</div>
        </div>`).join('')}
    </div>
    ${dayBars(week, isCurrent)}
    <div class="review-columns">
      <div>${subjectRows(week)}</div>
      <div>${tasksDone(done)}${comingUp(due)}${!done.length && !due.length ? '<p class="review-muted review-empty">No tasks ticked off this week. Tasks you finish show up here.</p>' : ''}</div>
    </div>
    <p class="form-hint">Weekly goals are compared as they're set now.</p>`;
}

// weeksBack: 0 is this week, 1 last week, and so on.
export async function openWeeklyReview(weeksBack = 1, preloadedSessions) {
  if (typeof weeksBack !== 'number') weeksBack = 1;
  let sessions = preloadedSessions;
  try {
    sessions = sessions || (await window.api.getSessions());
  } catch (err) {
    showToast('Could not load the review', { message: errorText(err), type: 'error' });
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay open';
  overlay.innerHTML = `
    <div class="modal modal-wide review" role="dialog" aria-modal="true" aria-labelledby="review-title">
      <div class="review-body"></div>
      <div class="modal-actions">
        <button class="btn-primary" data-action="close">Done</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const body = overlay.querySelector('.review-body');

  const show = async (n) => {
    weeksBack = Math.max(0, n);
    try {
      body.innerHTML = await reviewHtml(weeksBack, sessions);
    } catch (err) {
      body.innerHTML = `<p class="modal-text form-error">${escapeHtml(errorText(err))}</p>`;
    }
  };
  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); show(weeksBack + 1); }
    if (e.key === 'ArrowRight' && weeksBack > 0) { e.preventDefault(); show(weeksBack - 1); }
  };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('click', (e) => {
    const nav = e.target.closest('[data-nav]')?.dataset.nav;
    if (nav === 'older') show(weeksBack + 1);
    if (nav === 'newer') show(weeksBack - 1);
    if (e.target === overlay || e.target.dataset.action === 'close') close();
  });
  await show(weeksBack);
  overlay.querySelector('[data-action="close"]').focus();
}
