// The subject library in the sidebar (grouped by term), the subject menu, the
// add/edit subject dialog, and the dashboard metrics above the timer.
import { icon } from './icons.js';
import { showToast, confirmDialog, showUndoToast } from './notify.js';
import { state, activeCourses, archivedCourses, getActiveCourse, setActiveCourse, reloadData, courseById } from './state.js';
import { escapeHtml, formatHM, formatCompact, emptyState, localDateKey, errorText } from './format.js';
import { SUBJECT_COLORS, COLOR_NAMES, courseColor, swatch, allTerms } from './colors.js';
import { stopIfRunning } from './timer.js';
import { renderExams, examTag } from './exams.js';

let showArchived = false;

// Terms folded away in the library. Remembered per computer; losing it is harmless.
const COLLAPSED_KEY = 'inmo.collapsedTerms';
const collapsedTerms = new Set(readCollapsed());

function readCollapsed() {
  try {
    const list = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveCollapsed() {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsedTerms]));
  } catch {
    // Storage unavailable: the library just opens every term next time.
  }
}

export function renderSubjects() {
  renderFirstRun();
  renderCourseList();
  renderTimerCourseBadge();
  updateMetricsDashboard();
  renderExams();
}

function renderFirstRun() {
  const noSubjects = activeCourses().length === 0;
  document.getElementById('first-run').classList.toggle('is-hidden', !noSubjects);
  document.getElementById('focus-content').classList.toggle('is-hidden', noSubjects);
}

function courseRow(course) {
  const id = escapeHtml(course.id);
  return `
    <div class="course-item ${state.activeCourseId === course.id ? 'active' : ''}" id="course-row-${id}" style="--subject-color: ${courseColor(course)};">
      <div class="course-info" onclick="window.selectCourse('${id}')">
        <div class="title">${swatch(course)}<span>${escapeHtml(course.title)}</span></div>
        <div class="code">${escapeHtml(course.code)} • ${formatHM(course.total_seconds)}${examTag(course) ? ` • <span class="exam-tag">${examTag(course)}</span>` : ''}</div>
      </div>
      <div class="course-actions">
        <button class="icon-btn" title="Edit subject" aria-label="Edit subject" onclick="event.stopPropagation(); window.enableCourseEdit('${id}')">${icon('pencil', 14)}</button>
        <button class="icon-btn" title="Archive subject" aria-label="Archive subject" onclick="event.stopPropagation(); window.handleArchiveCourse('${id}')">${icon('archive', 14)}</button>
      </div>
    </div>`;
}

function archivedRow(course) {
  const id = escapeHtml(course.id);
  return `
    <div class="course-item archived">
      <div class="course-info">
        <div class="title">${swatch(course)}<span>${escapeHtml(course.title)}</span></div>
        <div class="code">${escapeHtml(course.code)} • ${formatHM(course.total_seconds)}${course.term ? ` • ${escapeHtml(course.term)}` : ''}</div>
      </div>
      <div class="course-actions">
        <button class="icon-btn" title="Restore subject" aria-label="Restore subject" onclick="window.handleRestoreCourse('${id}')">${icon('archive-restore', 14)}</button>
        <button class="icon-btn danger" title="Delete subject" aria-label="Delete subject" onclick="window.handleDeleteCourse('${id}')">${icon('trash-2', 14)}</button>
      </div>
    </div>`;
}

// Library groups: one per term, the newest first, then subjects with no term.
// Without any terms there's a single unnamed group.
function libraryGroups() {
  const active = activeCourses();
  const terms = allTerms(active);
  if (terms.length === 0) return [{ term: null, courses: active }];
  const groups = terms.map(term => ({ term, courses: active.filter(c => c.term === term) }));
  const loose = active.filter(c => !c.term);
  if (loose.length) groups.push({ term: '', courses: loose });
  return groups;
}

// The subjects in the order the library shows them, folded terms left out.
// Alt+Up/Down steps through this.
export function libraryOrder() {
  return libraryGroups()
    .filter(g => g.term === null || !collapsedTerms.has(g.term))
    .flatMap(g => g.courses);
}

function groupHtml(group) {
  if (group.term === null) return group.courses.map(courseRow).join('');
  const name = group.term || 'No term';
  const open = !collapsedTerms.has(group.term);
  const total = group.courses.reduce((sum, c) => sum + (c.total_seconds || 0), 0);
  return `
    <button class="term-header" onclick="window.toggleTermGroup(this.dataset.term)" data-term="${escapeHtml(group.term)}" aria-expanded="${open}">
      ${icon(open ? 'chevron-down' : 'chevron-right', 14)}
      <span class="term-name">${escapeHtml(name)}</span>
      <span class="term-meta">${group.courses.length} · ${formatCompact(total)}</span>
    </button>
    ${open ? group.courses.map(courseRow).join('') : ''}`;
}

function renderCourseList() {
  const list = document.getElementById('course-list');
  if (!list) return;
  const active = activeCourses();
  const archived = archivedCourses();

  let html = active.length
    ? libraryGroups().map(groupHtml).join('')
    : emptyState('book-open', 'No subjects yet', 'Add one with the + button.');
  if (archived.length) {
    html += `
      <button class="archived-toggle" onclick="window.toggleArchivedList()" aria-expanded="${showArchived}">
        ${icon(showArchived ? 'chevron-down' : 'chevron-right', 14)} Archived (${archived.length})
      </button>`;
    if (showArchived) html += archived.map(archivedRow).join('');
  }
  list.innerHTML = html;
}

export function toggleArchivedList() {
  showArchived = !showArchived;
  renderCourseList();
}

export function toggleTermGroup(term) {
  if (collapsedTerms.has(term)) collapsedTerms.delete(term);
  else collapsedTerms.add(term);
  saveCollapsed();
  renderCourseList();
}

export function renderTimerCourseBadge() {
  const el = document.getElementById('timer-course-badge');
  if (!el) return;
  const course = getActiveCourse();
  el.style.setProperty('--subject-color', courseColor(course));
  el.innerHTML = course
    ? `${swatch(course)}<span class="badge-code">${escapeHtml(course.code)}</span> <span class="badge-sep">—</span> <span class="badge-title">${escapeHtml(course.title)}</span>`
    : '<span class="badge-none">No subject selected</span>';
}

export async function selectCourse(id) {
  if (id !== state.activeCourseId) await stopIfRunning();
  setActiveCourse(id);
  await reloadData();
  window.switchToTimerPage();
}

export async function handleArchiveCourse(courseId) {
  const course = courseById(courseId);
  if (!course) return;
  const running = state.timer.phase === 'focus' && state.timer.courseId === courseId;
  const confirmed = await confirmDialog({
    title: `Archive ${course.title}?`,
    message: `It leaves the library and the timer, but its sessions stay in your history and analytics. You can restore it from "Archived" at the bottom of the library.${running ? ' The running session will be saved first.' : ''}`,
    confirmLabel: 'Archive',
    danger: false,
  });
  if (!confirmed) return;
  try {
    await window.api.setCourseArchived(courseId, true);
    await reloadData();
    showToast('Subject archived', { message: course.title });
  } catch (err) {
    showToast('Could not archive the subject', { message: errorText(err), type: 'error' });
  }
}

export async function handleRestoreCourse(courseId) {
  try {
    await window.api.setCourseArchived(courseId, false);
    await reloadData();
  } catch (err) {
    showToast('Could not restore the subject', { message: errorText(err), type: 'error' });
  }
}

export async function handleDeleteCourse(courseId) {
  const course = courseById(courseId);
  if (!course) return;
  const confirmed = await confirmDialog({
    title: `Delete ${course.title}?`,
    message: 'Its tasks and all of its logged sessions will be deleted too. To keep its history, archive it instead.',
    confirmLabel: 'Delete Subject',
  });
  if (!confirmed) return;
  try {
    const r = await window.api.deleteCourse(courseId);
    await reloadData();
    showUndoToast('Subject deleted', course.title, r.undoId, reloadData);
  } catch (err) {
    showToast('Could not delete the subject', { message: errorText(err), type: 'error' });
  }
}

export async function handleResetActiveCourse() {
  const course = getActiveCourse();
  if (!course) return;
  const confirmed = await confirmDialog({
    title: `Reset time for ${course.title}?`,
    message: 'All of its logged sessions will be deleted and its total will go back to 0h 0m.',
    confirmLabel: 'Reset Time',
  });
  if (!confirmed) return;
  const r = await window.api.resetCourseTime(course.id);
  await reloadData();
  showUndoToast('Time reset', course.title, r.undoId, reloadData);
}

// ---------- Subject menu (⋯ on the to-do list) ----------

export function closeSubjectMenu() {
  document.getElementById('subject-menu')?.classList.add('is-hidden');
  document.getElementById('subject-menu-btn')?.setAttribute('aria-expanded', 'false');
}

export function toggleSubjectMenu(event) {
  event.stopPropagation();
  const isOpen = document.getElementById('subject-menu').classList.toggle('is-hidden') === false;
  document.getElementById('subject-menu-btn').setAttribute('aria-expanded', String(isOpen));
}

// ---------- Add / edit subject dialog ----------

function colorOption(value, color, label, checked) {
  return `
    <label class="color-option" title="${escapeHtml(label)}">
      <input type="radio" name="subject-color" value="${value}" ${checked ? 'checked' : ''} aria-label="${escapeHtml(label)}">
      <span style="background: ${color};"></span>
    </label>`;
}

// courseId: edit that subject; omitted: add a new one.
export function openSubjectDialog(courseId) {
  const editing = courseId ? courseById(courseId) : null;
  if (courseId && !editing) return;
  const current = editing?.color || '';
  const isPreset = !current || SUBJECT_COLORS.includes(current);
  // What "Automatic" gives: by place in the library, so a new subject goes last.
  const autoColor = editing && !editing.color
    ? courseColor(editing)
    : SUBJECT_COLORS[(editing ? state.courses.findIndex(c => c.id === editing.id) : state.courses.length) % SUBJECT_COLORS.length];
  // The newest term is the likely one for a new subject.
  const terms = allTerms();
  const term = editing ? editing.term || '' : terms[0] || '';

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay open';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="subject-dialog-title">
      <h2 id="subject-dialog-title">${editing ? 'Edit subject' : 'Add New Subject'}</h2>
      <div class="form-group">
        <label for="subject-title">Subject Title</label>
        <input type="text" id="subject-title" maxlength="120" placeholder="e.g. Database Systems" value="${escapeHtml(editing?.title || '')}">
      </div>
      <div class="form-row form-row-2">
        <div class="form-group">
          <label for="subject-code">Course Code</label>
          <input type="text" id="subject-code" maxlength="40" placeholder="e.g. CS2050" value="${escapeHtml(editing?.code || '')}">
        </div>
        <div class="form-group">
          <label for="subject-term">Term (optional)</label>
          <input type="text" id="subject-term" maxlength="40" placeholder="e.g. Fall 2026" value="${escapeHtml(term)}" list="subject-terms" autocomplete="off">
          <datalist id="subject-terms">${terms.map(t => `<option value="${escapeHtml(t)}">`).join('')}</datalist>
        </div>
      </div>
      <div class="form-group">
        <span class="form-label">Color</span>
        <div class="color-picker" role="radiogroup" aria-label="Color">
          <label class="color-option color-auto" title="Automatic">
            <input type="radio" name="subject-color" value="" ${current ? '' : 'checked'} aria-label="Automatic">
            <span style="background: ${autoColor};">A</span>
          </label>
          ${SUBJECT_COLORS.map((c, i) => colorOption(c, c, COLOR_NAMES[i], current === c)).join('')}
          <label class="color-option color-custom" title="Custom color">
            <input type="radio" name="subject-color" value="custom" ${isPreset ? '' : 'checked'} aria-label="Custom color">
            <span style="background: ${isPreset ? 'conic-gradient(#e66767, #c98500, #199e70, #3987e5, #9085e9, #e66767)' : current};"></span>
            <input type="color" id="subject-color-custom" value="${isPreset ? '#3987e5' : current}" tabindex="-1" aria-hidden="true">
          </label>
        </div>
        <p class="form-hint">Used for this subject in the library, the timer, history and every chart. Terms group the library, and Analytics can show one term at a time.</p>
      </div>
      <p class="modal-text form-error is-hidden" id="subject-error"></p>
      <div class="modal-actions">
        <button class="btn-secondary" data-action="cancel">Cancel</button>
        <button class="btn-primary" data-action="save">${editing ? 'Save' : 'Add Subject'}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const $ = sel => overlay.querySelector(sel);
  const picker = $('#subject-color-custom');
  const customRadio = overlay.querySelector('input[name="subject-color"][value="custom"]');
  // Clicking the custom swatch opens the system color picker. (On the swatch,
  // not the radio, so stepping through the colors with arrow keys doesn't.)
  customRadio.nextElementSibling.addEventListener('click', () => picker.click());
  picker.addEventListener('input', () => {
    customRadio.checked = true;
    customRadio.nextElementSibling.style.background = picker.value;
  });

  const fail = (text) => {
    const el = $('#subject-error');
    el.innerText = text;
    el.classList.remove('is-hidden');
  };
  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
  };
  const save = async () => {
    const title = $('#subject-title').value.trim();
    const code = $('#subject-code').value.trim();
    const termValue = $('#subject-term').value.trim() || null;
    const choice = overlay.querySelector('input[name="subject-color"]:checked')?.value || '';
    const color = choice === 'custom' ? picker.value : choice || null;
    if (!title || !code) return fail('Title and code are both required.');
    try {
      if (editing) {
        await window.api.updateCourse({ courseId: editing.id, title, code, term: termValue, color });
        close();
        await reloadData();
      } else {
        const created = await window.api.addCourse(title, code, termValue, color);
        close();
        await stopIfRunning();
        setActiveCourse(created.id);
        // A subject added to a folded term should be visible.
        if (termValue && collapsedTerms.delete(termValue)) saveCollapsed();
        await reloadData();
      }
    } catch (err) {
      fail(errorText(err));
    }
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'radio') { e.preventDefault(); save(); }
  };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.dataset.action === 'cancel') close();
    if (e.target.dataset.action === 'save') save();
  });
  const first = $('#subject-title');
  first.focus();
  if (editing) first.select();
}

// ---------- Dashboard metrics ----------

function updateMetricsDashboard() {
  const todayStr = localDateKey(new Date());
  const todayRecord = state.dailyStats.find(d => d.date === todayStr);
  const todaySeconds = todayRecord ? todayRecord.total_seconds : 0;
  const goal = state.dailyGoalSecs;
  const progressPercent = Math.min(100, Math.round((todaySeconds / goal) * 100));

  const progressText = document.getElementById('daily-progress-text');
  const progressFill = document.getElementById('daily-progress-fill');
  if (progressText) progressText.innerText = `${Math.floor(todaySeconds / 60)}m / ${goal / 60}m`;
  const goalLabel = document.getElementById('daily-goal-label');
  if (goalLabel) goalLabel.innerText = `DAILY GOAL (${formatCompact(goal).toUpperCase()} TARGET)`;
  if (progressFill) progressFill.style.width = `${progressPercent}%`;

  const streak = currentStreak();
  const streakVal = document.getElementById('current-streak-val');
  if (streakVal) streakVal.innerText = streak === 0 ? 'No streak yet' : `${streak} ${streak === 1 ? 'day' : 'days'} in a row`;
}

// Days in a row with study, counting back from today (or yesterday, if today has none yet).
export function currentStreak() {
  const todayStr = localDateKey(new Date());
  let streak = 0;
  const d = new Date();
  for (;;) {
    const ds = localDateKey(d);
    const found = state.dailyStats.find(item => item.date === ds);
    if (found && found.total_seconds > 0) {
      streak++;
      d.setDate(d.getDate() - 1);
    } else if (streak === 0 && ds === todayStr) {
      d.setDate(d.getDate() - 1);
    } else {
      break;
    }
  }
  return streak;
}
