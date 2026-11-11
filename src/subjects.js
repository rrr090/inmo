// The subject library in the sidebar, the subject menu, the add-subject dialog,
// and the dashboard metrics above the timer.
import { icon } from './icons.js';
import { showToast, confirmDialog } from './notify.js';
import { state, activeCourses, archivedCourses, getActiveCourse, setActiveCourse, reloadData, courseById } from './state.js';
import { escapeHtml, formatHM, emptyState, localDateKey, errorText } from './format.js';
import { stopIfRunning } from './timer.js';

const DAILY_GOAL_SECONDS = 2 * 3600;
export { DAILY_GOAL_SECONDS };

let editingCourseId = null;
let showArchived = false;

export function renderSubjects() {
  renderFirstRun();
  renderCourseList();
  renderTimerCourseBadge();
  updateMetricsDashboard();
}

function renderFirstRun() {
  const noSubjects = activeCourses().length === 0;
  document.getElementById('first-run').classList.toggle('is-hidden', !noSubjects);
  document.getElementById('focus-content').classList.toggle('is-hidden', noSubjects);
}

function courseRow(course) {
  const id = escapeHtml(course.id);
  if (editingCourseId === course.id) {
    return `
      <div class="course-item active course-edit" onclick="event.stopPropagation()">
        <input type="text" id="edit-title-${id}" value="${escapeHtml(course.title)}" placeholder="Subject title" aria-label="Subject title"
          onkeydown="if (event.key === 'Enter') window.saveCourseInfo('${id}'); if (event.key === 'Escape') window.cancelCourseEdit();">
        <div class="course-edit-row">
          <input type="text" id="edit-code-${id}" value="${escapeHtml(course.code)}" placeholder="Code" aria-label="Course code"
            onkeydown="if (event.key === 'Enter') window.saveCourseInfo('${id}'); if (event.key === 'Escape') window.cancelCourseEdit();">
          <button class="btn-primary" onclick="window.saveCourseInfo('${id}')">Save</button>
          <button class="btn-secondary" onclick="window.cancelCourseEdit()">Cancel</button>
        </div>
      </div>`;
  }
  return `
    <div class="course-item ${state.activeCourseId === course.id ? 'active' : ''}" id="course-row-${id}">
      <div class="course-info" onclick="window.selectCourse('${id}')">
        <div class="title">${escapeHtml(course.title)}</div>
        <div class="code">${escapeHtml(course.code)} • ${formatHM(course.total_seconds)}</div>
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
        <div class="title">${escapeHtml(course.title)}</div>
        <div class="code">${escapeHtml(course.code)} • ${formatHM(course.total_seconds)}</div>
      </div>
      <div class="course-actions">
        <button class="icon-btn" title="Restore subject" aria-label="Restore subject" onclick="window.handleRestoreCourse('${id}')">${icon('archive-restore', 14)}</button>
        <button class="icon-btn danger" title="Delete subject" aria-label="Delete subject" onclick="window.handleDeleteCourse('${id}')">${icon('trash-2', 14)}</button>
      </div>
    </div>`;
}

function renderCourseList() {
  const list = document.getElementById('course-list');
  if (!list) return;
  const active = activeCourses();
  const archived = archivedCourses();

  let html = active.length ? active.map(courseRow).join('') : emptyState('book-open', 'No subjects yet', 'Add one with the + button.');
  if (archived.length) {
    html += `
      <button class="archived-toggle" onclick="window.toggleArchivedList()" aria-expanded="${showArchived}">
        ${icon(showArchived ? 'chevron-down' : 'chevron-right', 14)} Archived (${archived.length})
      </button>`;
    if (showArchived) html += archived.map(archivedRow).join('');
  }
  list.innerHTML = html;

  if (editingCourseId) {
    const input = document.getElementById(`edit-title-${editingCourseId}`);
    if (input) {
      input.focus();
      input.select();
    }
  }
}

export function toggleArchivedList() {
  showArchived = !showArchived;
  renderCourseList();
}

export function renderTimerCourseBadge() {
  const el = document.getElementById('timer-course-badge');
  if (!el) return;
  const course = getActiveCourse();
  el.innerHTML = course
    ? `<span class="badge-code">${escapeHtml(course.code)}</span> <span class="badge-sep">—</span> <span class="badge-title">${escapeHtml(course.title)}</span>`
    : '<span class="badge-none">No subject selected</span>';
}

export async function selectCourse(id) {
  if (id !== state.activeCourseId) await stopIfRunning();
  setActiveCourse(id);
  await reloadData();
  window.switchToTimerPage();
}

export function enableCourseEdit(courseId) {
  editingCourseId = courseId;
  renderCourseList();
}

export function cancelCourseEdit() {
  editingCourseId = null;
  renderCourseList();
}

export async function saveCourseInfo(courseId) {
  const title = document.getElementById(`edit-title-${courseId}`)?.value.trim();
  const code = document.getElementById(`edit-code-${courseId}`)?.value.trim();
  if (!title || !code) {
    showToast('Title and code are both required', { type: 'error' });
    return;
  }
  try {
    await window.api.updateCourse({ courseId, title, code });
    editingCourseId = null;
    await reloadData();
  } catch (err) {
    showToast('Could not save changes', { message: errorText(err), type: 'error' });
  }
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
    message: 'Its tasks and all of its logged sessions will be deleted too. This can\'t be undone. To keep its history, archive it instead.',
    confirmLabel: 'Delete Subject',
  });
  if (!confirmed) return;
  try {
    await window.api.deleteCourse(courseId);
    await reloadData();
    showToast('Subject deleted', { message: course.title });
  } catch (err) {
    showToast('Could not delete the subject', { message: errorText(err), type: 'error' });
  }
}

export async function handleResetActiveCourse() {
  const course = getActiveCourse();
  if (!course) return;
  const confirmed = await confirmDialog({
    title: `Reset time for ${course.title}?`,
    message: 'All of its logged sessions will be deleted and its total will go back to 0h 0m. This can\'t be undone.',
    confirmLabel: 'Reset Time',
  });
  if (!confirmed) return;
  await window.api.resetCourseTime(course.id);
  await reloadData();
  showToast('Time reset', { message: course.title });
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

// ---------- Add subject dialog ----------

export function openModal() {
  document.getElementById('modal').classList.add('open');
  document.getElementById('modal-title').focus();
}

export function closeModal() {
  document.getElementById('modal').classList.remove('open');
}

export async function handleAddCourse() {
  const titleInput = document.getElementById('modal-title');
  const codeInput = document.getElementById('modal-code');
  const title = titleInput.value.trim();
  const code = codeInput.value.trim();
  if (!title || !code) {
    showToast('Title and code are both required', { type: 'error' });
    return;
  }
  try {
    const created = await window.api.addCourse(title, code);
    closeModal();
    titleInput.value = '';
    codeInput.value = '';
    await stopIfRunning();
    setActiveCourse(created.id);
    await reloadData();
  } catch (err) {
    showToast('Could not add the subject', { message: errorText(err), type: 'error' });
  }
}

// ---------- Dashboard metrics ----------

function updateMetricsDashboard() {
  const todayStr = localDateKey(new Date());
  const todayRecord = state.dailyStats.find(d => d.date === todayStr);
  const todaySeconds = todayRecord ? todayRecord.total_seconds : 0;
  const progressPercent = Math.min(100, Math.round((todaySeconds / DAILY_GOAL_SECONDS) * 100));

  const progressText = document.getElementById('daily-progress-text');
  const progressFill = document.getElementById('daily-progress-fill');
  if (progressText) progressText.innerText = `${Math.floor(todaySeconds / 60)}m / ${DAILY_GOAL_SECONDS / 60}m`;
  if (progressFill) progressFill.style.width = `${progressPercent}%`;

  // Days in a row with study, counting back from today (or yesterday, if today has none yet).
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
  const streakVal = document.getElementById('current-streak-val');
  if (streakVal) streakVal.innerText = streak === 0 ? 'No streak yet' : `${streak} ${streak === 1 ? 'day' : 'days'} in a row`;
}
