// Exam dates: the countdown on the Timer page, the "Exam date…" dialog, and the
// pace needed to reach a subject's hours target before its exam.
import { icon } from './icons.js';
import { showToast } from './notify.js';
import { activeCourses, courseById, reloadData } from './state.js';
import { escapeHtml, formatCompact, localDateKey, parseDateKey, fmtDay, errorText } from './format.js';

const DAY_MS = 86400000;

// Whole days from today to a YYYY-MM-DD date (0 = today, negative = past).
export function daysUntil(dateKey) {
  const today = parseDateKey(localDateKey(new Date()));
  return Math.round((parseDateKey(dateKey) - today) / DAY_MS);
}

function whenText(days) {
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return `In ${days} days`;
}

// A short tag for the subject library, for exams in the next 30 days.
export function examTag(course) {
  if (!course.exam_date) return '';
  const days = daysUntil(course.exam_date);
  if (days < 0 || days > 30) return '';
  return days === 0 ? 'exam today' : days === 1 ? 'exam tomorrow' : `exam in ${days}d`;
}

// How much is left of a subject's hours target, and how fast it has to go.
// Today counts as a study day.
export function examPace(course) {
  const target = course.exam_target_seconds || 0;
  if (!target || !course.exam_date) return null;
  const days = Math.max(1, daysUntil(course.exam_date));
  const left = Math.max(0, target - (course.total_seconds || 0));
  return { target, left, days, perDay: left / days, perWeek: (left / days) * 7 };
}

function upcomingExams() {
  return activeCourses()
    .filter(c => c.exam_date && daysUntil(c.exam_date) >= 0)
    .sort((a, b) => a.exam_date.localeCompare(b.exam_date));
}

export function renderExams() {
  const box = document.getElementById('exams-box');
  const list = document.getElementById('exams-list');
  if (!box || !list) return;
  const exams = upcomingExams();
  box.classList.toggle('is-hidden', exams.length === 0);
  list.innerHTML = exams.map(c => {
    const id = escapeHtml(c.id);
    const days = daysUntil(c.exam_date);
    const pace = examPace(c);
    let paceHtml = '';
    if (pace) {
      const pct = Math.min(100, Math.round(((c.total_seconds || 0) / pace.target) * 100));
      const how = pace.left === 0
        ? 'Target reached'
        : days >= 7
          ? `about ${formatCompact(pace.perWeek)} a week to go`
          : `about ${formatCompact(pace.perDay)} a day to go`;
      paceHtml = `
        <div class="progress-bar-bg exam-bar"><div class="progress-bar-fill" style="width: ${pct}%"></div></div>
        <div class="exam-pace">${formatCompact(c.total_seconds || 0)} of ${formatCompact(pace.target)} · ${how}
          ${pace.left > 0 && days >= 7 ? `<button class="link-btn" onclick="window.useExamPaceAsGoal('${id}')">Use as weekly goal</button>` : ''}
        </div>`;
    }
    return `
      <div class="exam-item ${days <= 7 ? 'soon' : ''}">
        <div class="exam-when">
          <span class="exam-days">${whenText(days)}</span>
          <span class="exam-date">${escapeHtml(fmtDay(parseDateKey(c.exam_date), true))}</span>
        </div>
        <div class="exam-body">
          <div class="exam-title"><b>${escapeHtml(c.code)}</b> — ${escapeHtml(c.title)}</div>
          ${paceHtml}
        </div>
        <button class="icon-btn" title="Edit exam" aria-label="Edit exam" onclick="window.openExamDialog('${id}')">${icon('pencil', 14)}</button>
      </div>`;
  }).join('');
}

// Sets the subject's weekly goal to the pace its exam target needs, rounded up
// to the next half hour.
export async function useExamPaceAsGoal(courseId) {
  const course = courseById(courseId);
  const pace = course && examPace(course);
  if (!pace) return;
  const secs = Math.ceil(pace.perWeek / 1800) * 1800;
  try {
    await window.api.setCourseGoal(courseId, secs);
    await reloadData();
    showToast('Weekly goal set', { message: `${formatCompact(secs)} a week for ${course.code}` });
  } catch (err) {
    showToast('Could not set the goal', { message: errorText(err), type: 'error' });
  }
}

export function openExamDialog(courseId) {
  const course = courseById(courseId);
  if (!course) return;
  const hasExam = Boolean(course.exam_date);
  const targetHours = course.exam_target_seconds ? +(course.exam_target_seconds / 3600).toFixed(1) : '';

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay open';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="exam-dialog-title">
      <h2 id="exam-dialog-title">Exam for ${escapeHtml(course.code)}</h2>
      <p class="modal-text">${escapeHtml(course.title)}. The Timer page counts down to it, and with a target it shows how much to study each week to get there.</p>
      <div class="form-row">
        <div class="form-group">
          <label for="exam-date">Exam date</label>
          <input type="date" id="exam-date" value="${escapeHtml(course.exam_date || '')}" min="${localDateKey(new Date())}">
        </div>
        <div class="form-group">
          <label for="exam-target">Hours to study in total (optional)</label>
          <input type="number" id="exam-target" min="0" max="2000" step="0.5" value="${targetHours}" placeholder="e.g. 40">
        </div>
      </div>
      <p class="modal-text" id="exam-summary">So far: ${formatCompact(course.total_seconds || 0)} on this subject.</p>
      <div class="modal-actions">
        ${hasExam ? '<button class="btn-secondary danger-text" data-action="remove">Remove exam</button>' : ''}
        <button class="btn-secondary" data-action="cancel">Cancel</button>
        <button class="btn-primary" data-action="save">Save</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const $ = sel => overlay.querySelector(sel);
  const fail = (text) => {
    const summary = $('#exam-summary');
    summary.classList.add('form-error');
    summary.innerText = text;
  };
  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
  };
  const submit = async (date, hours) => {
    try {
      await window.api.setCourseExam(courseId, date, hours);
      close();
      await reloadData();
      showToast(date ? 'Exam saved' : 'Exam removed', {
        message: date ? `${course.code}: ${whenText(daysUntil(date)).toLowerCase()}` : course.code,
      });
    } catch (err) {
      fail(errorText(err));
    }
  };
  const save = () => {
    const date = $('#exam-date').value;
    const hours = $('#exam-target').value === '' ? 0 : Number($('#exam-target').value);
    if (!date) return fail('Pick the exam date.');
    if (daysUntil(date) < 0) return fail('That date has passed.');
    if (!Number.isFinite(hours) || hours < 0 || hours > 2000) return fail('Hours must be a number from 0 to 2000.');
    submit(date, hours);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); save(); }
  };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('click', (e) => {
    const action = e.target.dataset.action;
    if (e.target === overlay || action === 'cancel') close();
    if (action === 'save') save();
    if (action === 'remove') submit(null, 0);
  });
  $('#exam-date').focus();
}
