// The to-do list for the selected subject.
import { icon } from './icons.js';
import { getActiveCourse, reloadData } from './state.js';
import { showUndoToast } from './notify.js';
import { escapeHtml, emptyState } from './format.js';

export async function loadTasks() {
  const course = getActiveCourse();
  const headerTitle = document.getElementById('tasks-header-title');
  if (headerTitle) headerTitle.innerText = course ? `${course.code} To-Do List` : 'To-Do List';
  const container = document.getElementById('task-list');
  if (!container || !course) return;

  const tasks = await window.api.getTasks(course.id);
  if (tasks.length === 0) {
    container.innerHTML = emptyState('list-todo', 'No tasks yet', 'Add your first one above.');
    return;
  }
  container.innerHTML = tasks.map(t => {
    const id = escapeHtml(t.id);
    return `
      <div class="task-item ${t.completed ? 'completed' : ''}" data-task-id="${id}">
        <div class="task-item-left" onclick="window.handleToggleTask('${id}')">
          <input type="checkbox" ${t.completed ? 'checked' : ''} aria-label="Done" onclick="event.stopPropagation(); window.handleToggleTask('${id}')">
          <span class="task-text">${escapeHtml(t.text)}</span>
        </div>
        <button class="delete-item-btn" onclick="window.handleDeleteTask('${id}')" title="Delete task" aria-label="Delete task">${icon('trash-2', 15)}</button>
      </div>`;
  }).join('');
}

export async function handleAddTask() {
  const input = document.getElementById('new-task-text');
  const text = input?.value.trim();
  const course = getActiveCourse();
  if (!text || !course) return;
  await window.api.addTask(course.id, text);
  input.value = '';
  loadTasks();
}

export async function handleToggleTask(taskId) {
  await window.api.toggleTask(taskId);
  loadTasks();
}

export async function handleDeleteTask(taskId) {
  const text = document.querySelector(`[data-task-id="${CSS.escape(taskId)}"] .task-text`)?.innerText || '';
  const r = await window.api.deleteTask(taskId);
  await reloadData();
  showUndoToast('Task deleted', text, r.undoId, reloadData);
}
