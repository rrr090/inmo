// Keyboard shortcuts inside the window, and the "?" list of them. The global
// Ctrl+Alt+S lives in the backend (tray.rs).
import { state, getActiveCourse } from './state.js';
import { escapeHtml } from './format.js';
import { toggleTimer, togglePause, setMode } from './timer.js';
import { libraryOrder, selectCourse, openSubjectDialog } from './subjects.js';
import { openWeeklyReview } from './review.js';

const PAGES = ['timer-page', 'analytics-page', 'history-page', 'friends-page', 'settings-page'];

export const SHORTCUTS = [
  ['Timer', [
    [['Space'], 'Start or stop the timer'],
    [['P'], 'Pause or resume the timer'],
    [['M'], 'Switch between Stopwatch and Pomodoro'],
    [['N'], 'Type what you\'re working on'],
    [['Ctrl', 'Alt', 'S'], 'Start or stop from any app (turn it on in Settings)'],
  ]],
  ['Subjects and tasks', [
    [['Alt', '↑'], 'Previous subject'],
    [['Alt', '↓'], 'Next subject'],
    [['A'], 'Add a subject'],
    [['E'], 'Edit the selected subject'],
    [['T'], 'Add a task'],
    [['↑ ↓'], 'Move a task, with its handle focused'],
  ]],
  ['Pages', [
    [['Ctrl', '1'], 'Timer'],
    [['Ctrl', '2'], 'Analytics'],
    [['Ctrl', '3'], 'History'],
    [['Ctrl', '4'], 'Friends'],
    [['Ctrl', '5'], 'Settings'],
    [['/'], 'Search session history'],
    [['W'], 'Weekly review'],
    [['?'], 'This list'],
    [['Esc'], 'Close a dialog, or leave a text box'],
  ]],
];

// Text fields keep their keys. Checkboxes and buttons don't count: Space on
// them starts the timer, unless they were reached with Tab.
function isTextField(el) {
  if (!el) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  return el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'range', 'color'].includes(el.type);
}

function dialogOpen() {
  return Boolean(document.querySelector('.modal-overlay.open'));
}

async function goTo(pageIndex) {
  await window.switchPage(PAGES[pageIndex]);
}

function focusOnTimerPage(id) {
  window.switchPage('timer-page');
  const el = document.getElementById(id);
  if (el) {
    el.focus();
    if (el.select) el.select();
  }
}

function stepSubject(dir) {
  const order = libraryOrder();
  if (!order.length) return;
  const i = order.findIndex(c => c.id === state.activeCourseId);
  const next = order[i < 0 ? 0 : (i + dir + order.length) % order.length];
  if (next.id !== state.activeCourseId) selectCourse(next.id);
}

function onKeydown(e) {
  if (e.defaultPrevented || e.isComposing || dialogOpen()) return;
  const target = e.target;
  if (isTextField(target)) {
    if (e.key === 'Escape') target.blur();
    return;
  }
  const ctrl = e.ctrlKey || e.metaKey;

  if (ctrl && !e.altKey && !e.shiftKey && /^[1-5]$/.test(e.key)) {
    e.preventDefault();
    goTo(Number(e.key) - 1);
    return;
  }
  if (e.altKey && !ctrl && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    stepSubject(e.key === 'ArrowUp' ? -1 : 1);
    return;
  }
  if (ctrl || e.altKey || e.repeat) return;

  if (e.key === ' ') {
    // A control reached with Tab keeps Space for itself.
    if (target.matches?.('button, a, input, [role="button"], [tabindex]') && target.matches(':focus-visible')) return;
    e.preventDefault();
    window.switchPage('timer-page');
    toggleTimer();
    return;
  }

  const actions = {
    '?': openShortcutHelp,
    '/': () => {
      window.switchPage('history-page');
      document.getElementById('history-search')?.focus();
    },
    p: () => togglePause(),
    m: () => setMode(state.timerMode === 'pomodoro' ? 'stopwatch' : 'pomodoro'),
    n: () => focusOnTimerPage('session-note'),
    t: () => focusOnTimerPage('new-task-text'),
    a: () => openSubjectDialog(),
    e: () => {
      const course = getActiveCourse();
      if (course) openSubjectDialog(course.id);
    },
    w: () => openWeeklyReview(),
  };
  const action = actions[e.key.length === 1 ? e.key.toLowerCase() : e.key] || actions[e.key];
  if (action) {
    e.preventDefault();
    action();
  }
}

export function initShortcuts() {
  document.addEventListener('keydown', onKeydown);
}

function keysHtml(keys) {
  return keys.map(k => `<kbd>${escapeHtml(k)}</kbd>`).join('<span class="kbd-plus">+</span>');
}

export function openShortcutHelp() {
  if (dialogOpen()) return;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay open';
  overlay.innerHTML = `
    <div class="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="shortcut-title">
      <h2 id="shortcut-title">Keyboard shortcuts</h2>
      <div class="shortcut-groups">
        ${SHORTCUTS.map(([group, rows]) => `
          <div class="shortcut-group">
            <h3>${escapeHtml(group)}</h3>
            ${rows.map(([keys, what]) => `
              <div class="shortcut-row"><span>${escapeHtml(what)}</span><span class="shortcut-keys">${keysHtml(keys)}</span></div>`).join('')}
          </div>`).join('')}
      </div>
      <p class="form-hint">Letter shortcuts work when you're not typing in a box. Press Esc to leave one.</p>
      <div class="modal-actions">
        <button class="btn-primary" data-action="close">Got it</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
  };
  const onKey = (e) => {
    if (e.key === 'Escape' || e.key === '?') { e.stopPropagation(); e.preventDefault(); close(); }
  };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.dataset.action === 'close') close();
  });
  overlay.querySelector('[data-action="close"]').focus();
}
