// The to-do list for the selected subject: due dates, drag (or arrow-key)
// reordering, time logged per task, "work on this" for the timer, and the
// "Due soon" box across all subjects.
import { icon } from './icons.js';
import { state, getActiveCourse, reloadData, courseById } from './state.js';
import { showToast, showUndoToast } from './notify.js';
import { escapeHtml, emptyState, formatCompact, localDateKey, addDays, parseDateKey, fmtDay, errorText } from './format.js';
import { daysUntil } from './exams.js';
import { swatch } from './colors.js';

const DUE_SOON_DAYS = 7;

let tasks = [];        // the selected subject's tasks, as shown
let tasksCourseId = null;

export function taskById(id) {
  return tasks.find(t => t.id === id) || null;
}

// "Overdue 2 days", "Due today", "Due Fri", "Due Dec 3".
export function dueLabel(dateKey) {
  const days = daysUntil(dateKey);
  const date = parseDateKey(dateKey);
  if (days < 0) return { text: `Overdue ${-days} ${days === -1 ? 'day' : 'days'}`, level: 'overdue' };
  if (days === 0) return { text: 'Due today', level: 'soon' };
  if (days === 1) return { text: 'Due tomorrow', level: 'soon' };
  if (days < 7) return { text: `Due ${date.toLocaleDateString('en-US', { weekday: 'short' })}`, level: 'soon' };
  return { text: `Due ${fmtDay(date)}`, level: '' };
}

function dueBadge(task) {
  if (!task.due_date || task.completed) return '';
  const due = dueLabel(task.due_date);
  return `<span class="due-badge ${due.level}" title="${escapeHtml(fmtDay(parseDateKey(task.due_date), true))}">${icon('calendar', 12)}${escapeHtml(due.text)}</span>`;
}

function taskRow(t) {
  const id = escapeHtml(t.id);
  const linked = state.timer.taskId === t.id;
  const logged = Number(t.logged_seconds) || 0;
  const meta = dueBadge(t) + (logged ? `<span class="task-time" title="Time logged on this task">${icon('timer', 12)}${formatCompact(logged)}</span>` : '');
  return `
    <div class="task-item ${t.completed ? 'completed' : ''} ${linked ? 'linked' : ''}" data-task-id="${id}">
      ${t.completed
        ? '<span class="drag-spacer"></span>'
        : `<button class="drag-handle" data-task-id="${id}" title="Drag to reorder (or focus and use ↑ ↓)" aria-label="Reorder ${escapeHtml(t.text)}. Use the up and down arrow keys.">${icon('grip-vertical', 14)}</button>`}
      <div class="task-item-left" onclick="window.handleToggleTask('${id}')">
        <input type="checkbox" ${t.completed ? 'checked' : ''} aria-label="Done" onclick="event.stopPropagation(); window.handleToggleTask('${id}')">
        <div class="task-body">
          <span class="task-text">${escapeHtml(t.text)}</span>
          ${meta ? `<div class="task-meta">${meta}</div>` : ''}
        </div>
      </div>
      <div class="task-actions">
        ${t.completed ? '' : `<button class="icon-btn task-focus" onclick="window.handleWorkOnTask('${id}')" title="${linked ? 'Stop working on this' : 'Work on this: sessions are logged against it'}" aria-pressed="${linked}" aria-label="Work on this task">${icon('target', 15)}</button>`}
        <button class="icon-btn" onclick="window.openTaskDialog('${id}')" title="Edit task" aria-label="Edit task">${icon('pencil', 15)}</button>
        <button class="icon-btn danger" onclick="window.handleDeleteTask('${id}')" title="Delete task" aria-label="Delete task">${icon('trash-2', 15)}</button>
      </div>
    </div>`;
}

export async function loadTasks() {
  const course = getActiveCourse();
  const headerTitle = document.getElementById('tasks-header-title');
  const container = document.getElementById('task-list');
  renderDueTasks();
  if (!container || !course) {
    if (headerTitle) headerTitle.innerText = 'Tasks';
    return;
  }

  tasks = await window.api.getTasks(course.id);
  tasksCourseId = course.id;
  const done = tasks.filter(t => t.completed).length;
  if (headerTitle) {
    headerTitle.innerHTML = `Tasks <span class="tasks-subject">${swatch(course)}${escapeHtml(course.code)}</span>${tasks.length ? `<span class="tasks-count">${done} of ${tasks.length} done</span>` : ''}`;
  }

  // A task picked for another subject while the timer was idle doesn't apply here.
  const picked = state.timer.taskId;
  if (picked && state.timer.phase !== 'focus' && !taskById(picked)) {
    window.api.timerSetTask(null, course.id).catch(() => {});
  }

  container.innerHTML = tasks.length === 0
    ? emptyState('list-todo', 'No tasks yet', 'Add your first one above. Give it a due date to see it under "Due soon".')
    : tasks.map(taskRow).join('');
  setUpReordering(container);
  renderWorkingOn();
}

export async function handleAddTask() {
  const input = document.getElementById('new-task-text');
  const dueInput = document.getElementById('new-task-due');
  const text = input?.value.trim();
  const course = getActiveCourse();
  if (!text || !course) return;
  try {
    await window.api.addTask(course.id, text, dueInput?.value || null);
    input.value = '';
    if (dueInput) dueInput.value = '';
    await loadTasks();
  } catch (err) {
    showToast('Could not add the task', { message: errorText(err), type: 'error' });
  }
}

export async function handleToggleTask(taskId) {
  await window.api.toggleTask(taskId);
  // The analytics page counts done tasks too.
  await reloadData();
}

export async function handleDeleteTask(taskId) {
  const text = taskById(taskId)?.text || '';
  const course = getActiveCourse();
  if (state.timer.taskId === taskId && course) await window.api.timerSetTask(null, course.id).catch(() => {});
  const r = await window.api.deleteTask(taskId);
  await reloadData();
  showUndoToast('Task deleted', text, r.undoId, reloadData);
}

// ---------- Working on a task ----------

// Links the timer to a task (or unlinks it, if it's the linked one). Sessions
// are then logged against it until the timer is stopped.
export async function handleWorkOnTask(taskId) {
  const course = getActiveCourse();
  if (!course) return;
  const next = state.timer.taskId === taskId ? null : taskId;
  try {
    await window.api.timerSetTask(next, course.id);
  } catch (err) {
    showToast('Could not pick that task', { message: errorText(err), type: 'error' });
  }
}

export function clearWorkingOn() {
  const course = getActiveCourse();
  if (course) handleWorkOnTask(state.timer.taskId);
}

// The "Working on" line under the timer, and the highlighted task. Called on
// every timer update, so it only touches the DOM.
export function renderWorkingOn() {
  const id = state.timer.taskId;
  const task = id && tasksCourseId === state.activeCourseId ? taskById(id) : null;
  const box = document.getElementById('working-on');
  if (box) {
    box.classList.toggle('is-hidden', !task);
    const text = document.getElementById('working-on-text');
    if (text && task && text.textContent !== task.text) text.textContent = task.text;
  }
  document.querySelectorAll('.task-item[data-task-id]').forEach(el => {
    const linked = el.dataset.taskId === id;
    if (el.classList.contains('linked') === linked) return;
    el.classList.toggle('linked', linked);
    const btn = el.querySelector('.task-focus');
    if (btn) {
      btn.setAttribute('aria-pressed', String(linked));
      btn.title = linked ? 'Stop working on this' : 'Work on this: sessions are logged against it';
    }
  });
}

// ---------- Reordering ----------

function openItems(container) {
  return [...container.querySelectorAll('.task-item:not(.completed)')];
}

async function saveOrder(container) {
  const course = getActiveCourse();
  if (!course) return;
  const ids = openItems(container).map(el => el.dataset.taskId);
  const before = tasks.filter(t => !t.completed).map(t => t.id);
  if (ids.join('\n') === before.join('\n')) return;
  try {
    await window.api.reorderTasks(course.id, ids);
  } catch (err) {
    showToast('Could not save the order', { message: errorText(err), type: 'error' });
  }
  await loadTasks();
}

let reorderReady = false;

// Drag a task by its handle, or focus the handle and press ↑ / ↓. Pointer
// events rather than HTML drag and drop, which the window's file drop takes over.
function setUpReordering(container) {
  if (reorderReady) return;
  reorderReady = true;

  container.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.drag-handle');
    if (!handle || e.button !== 0) return;
    e.preventDefault();
    const item = handle.closest('.task-item');
    item.classList.add('dragging');
    container.classList.add('reordering');

    const move = (ev) => {
      const others = openItems(container).filter(el => el !== item);
      const after = others.find(el => {
        const box = el.getBoundingClientRect();
        return ev.clientY < box.top + box.height / 2;
      });
      if (after) {
        if (item.nextElementSibling !== after) container.insertBefore(item, after);
      } else if (others.length) {
        const last = others[others.length - 1];
        if (last.nextElementSibling !== item) last.after(item);
      }
      // Keep the list scrolling while dragging near its edges.
      const box = container.getBoundingClientRect();
      if (ev.clientY < box.top + 16) container.scrollTop -= 8;
      else if (ev.clientY > box.bottom - 16) container.scrollTop += 8;
    };
    // On the window, not the handle: moving the row in the page would drop a
    // pointer capture, and the release would never arrive.
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      item.classList.remove('dragging');
      container.classList.remove('reordering');
      saveOrder(container);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  });

  container.addEventListener('keydown', async (e) => {
    const handle = e.target.closest('.drag-handle');
    if (!handle || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    e.stopPropagation();
    const item = handle.closest('.task-item');
    const items = openItems(container);
    const i = items.indexOf(item);
    const j = e.key === 'ArrowUp' ? i - 1 : i + 1;
    if (j < 0 || j >= items.length) return;
    if (j < i) items[j].before(item);
    else items[j].after(item);
    const id = item.dataset.taskId;
    await saveOrder(container);
    container.querySelector(`.drag-handle[data-task-id="${CSS.escape(id)}"]`)?.focus();
  });
}

// ---------- Edit dialog ----------

export function openTaskDialog(taskId) {
  const task = taskById(taskId);
  if (!task) return;
  const logged = Number(task.logged_seconds) || 0;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay open';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="task-dialog-title">
      <h2 id="task-dialog-title">Edit task</h2>
      <div class="form-group">
        <label for="task-text-field">Task</label>
        <input type="text" id="task-text-field" maxlength="300" value="${escapeHtml(task.text)}">
      </div>
      <div class="form-group">
        <label for="task-due-field">Due date (optional)</label>
        <input type="date" id="task-due-field" value="${escapeHtml(task.due_date || '')}">
      </div>
      <p class="modal-text" id="task-summary">${logged ? `${formatCompact(logged)} logged on this task so far.` : 'No time logged on this task yet. Pick it with the target button to log sessions against it.'}</p>
      <div class="modal-actions">
        ${task.due_date ? '<button class="btn-secondary" data-action="clear-due" style="margin-right: auto;">Remove due date</button>' : ''}
        <button class="btn-secondary" data-action="cancel">Cancel</button>
        <button class="btn-primary" data-action="save">Save</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const $ = sel => overlay.querySelector(sel);
  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
  };
  const save = async (dueOverride) => {
    const text = $('#task-text-field').value.trim();
    const due = dueOverride !== undefined ? dueOverride : $('#task-due-field').value || null;
    if (!text) {
      const summary = $('#task-summary');
      summary.classList.add('form-error');
      summary.innerText = 'A task needs some text.';
      return;
    }
    try {
      await window.api.updateTask(task.id, text, due);
      close();
      await loadTasks();
    } catch (err) {
      const summary = $('#task-summary');
      summary.classList.add('form-error');
      summary.innerText = errorText(err);
    }
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
    if (action === 'clear-due') save(null);
  });
  const input = $('#task-text-field');
  input.focus();
  input.select();
}

// ---------- Due soon, across subjects ----------

async function renderDueTasks() {
  const box = document.getElementById('due-box');
  const list = document.getElementById('due-list');
  if (!box || !list) return;
  let due = [];
  try {
    due = await window.api.getDueTasks(localDateKey(addDays(new Date(), DUE_SOON_DAYS)));
  } catch (err) {
    console.error('Could not load due tasks:', err);
  }
  box.classList.toggle('is-hidden', due.length === 0);
  list.innerHTML = due.map(t => {
    const label = dueLabel(t.due_date);
    const course = courseById(t.course_id);
    return `
      <button class="due-item" onclick="window.selectCourse('${escapeHtml(t.course_id)}')" title="Open ${escapeHtml(t.code)}">
        <span class="due-badge ${label.level}">${escapeHtml(label.text)}</span>
        <span class="due-text">${escapeHtml(t.text)}</span>
        <span class="due-subject">${swatch(course)}${escapeHtml(t.code)}</span>
      </button>`;
  }).join('');
}
