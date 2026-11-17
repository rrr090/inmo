// The timer on the Timer page. The clock itself runs in the backend (timer.rs); this
// shows its state and sends start/stop. Every stop, from here, the tray, the
// global shortcut or the floating widget, arrives as a "stopped" timer-event.
import { showToast, confirmDialog } from './notify.js';
import { state, getActiveCourse, reloadData } from './state.js';
import { escapeHtml, formatClock, formatDuration, formatCompact, localDateKey, errorText } from './format.js';
import { renderWorkingOn } from './tasks.js';

const PLAY_ICON = '<path d="M8 5v14l11-7z"/>';
const STOP_ICON = '<path d="M6 6h12v12H6z"/>';
const PAUSE_ICON = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';

export async function initTimer() {
  window.api.onTimerState(applySnapshot);
  window.api.onTimerEvent(handleTimerEvent);
  const snap = await window.api.timerGet();
  applySnapshot(snap);
  // The window was reloaded mid-session: pick up the running subject.
  if (snap && snap.courseId && snap.isStudying) state.activeCourseId = snap.courseId;
  // The window was reopened while a "welcome back" question was waiting.
  if (snap && snap.awaySecs) askAboutIdleTime(snap.awaySecs, snap.courseLabel);
}

function idleClock() {
  return state.timerMode === 'pomodoro' ? formatClock(state.focusMin * 60, false) : '00:00:00';
}

function applySnapshot(snap) {
  if (!snap) return;
  state.timer = snap;
  const running = snap.isStudying;
  const onBreak = snap.phase === 'break';

  const display = document.getElementById('timer-display');
  if (display) display.innerText = running ? snap.timeStr : idleClock();

  const btn = document.getElementById('timer-btn');
  const playIcon = document.getElementById('play-icon');
  if (btn && playIcon) {
    btn.classList.toggle('running', running);
    playIcon.innerHTML = running ? STOP_ICON : PLAY_ICON;
    btn.title = onBreak ? 'Skip break' : running ? 'Stop and save' : 'Start';
  }
  document.querySelector('.timer-section')?.classList.toggle('on-break', onBreak);

  const paused = running && !!snap.paused;
  const pauseBtn = document.getElementById('pause-btn');
  const pauseIcon = document.getElementById('pause-icon');
  if (pauseBtn && pauseIcon) {
    pauseBtn.classList.toggle('is-hidden', !running);
    pauseBtn.classList.toggle('paused', paused);
    pauseIcon.innerHTML = paused ? PLAY_ICON : PAUSE_ICON;
    pauseBtn.title = paused ? 'Resume' : 'Pause';
    pauseBtn.setAttribute('aria-label', pauseBtn.title);
  }
  document.querySelector('.timer-section')?.classList.toggle('paused', paused);

  renderTimerRing();

  // Don't overwrite what's being typed, or a change not yet saved.
  const noteInput = document.getElementById('session-note');
  if (noteInput && !notePending && document.activeElement !== noteInput) {
    const note = snap.note || '';
    if (noteInput.value !== note) noteInput.value = note;
  }

  // Mode can't change mid-session.
  document.querySelectorAll('.mode-tab').forEach(tab => { tab.disabled = running && !onBreak; });

  renderWorkingOn();

  updateInPageWidget();
}

function todaySeconds() {
  const today = state.dailyStats.find(d => d.date === localDateKey(new Date()));
  return today ? today.total_seconds : 0;
}

// The ring around the clock fills up as a Pomodoro or break runs. Otherwise it
// shows today's study time, the running session included, against the daily goal.
// The line under it says what the ring doesn't.
export function renderTimerRing() {
  const snap = state.timer;
  const fill = document.getElementById('timer-ring-fill');
  const caption = document.getElementById('timer-ring-caption');
  const status = document.getElementById('timer-status');
  if (!fill || !caption || !status) return;

  const running = snap.isStudying;
  const onBreak = snap.phase === 'break';
  const goal = state.dailyGoalSecs;
  const today = todaySeconds() + (running && !onBreak ? snap.elapsedSecs || 0 : 0);
  const todayText = today >= goal
    ? `${formatCompact(today)} today · goal reached`
    : `${formatCompact(today)} of ${formatCompact(goal)} today`;

  let frac;
  let captionText;
  let statusText = '';
  if (running && (onBreak || snap.mode === 'pomodoro')) {
    const elapsed = snap.elapsedSecs || 0;
    const total = elapsed + (snap.shownSecs || 0);
    frac = total > 0 ? elapsed / total : 1;
    if (onBreak) {
      captionText = snap.longBreak ? 'Long break' : 'Short break';
      statusText = 'The button skips the rest of the break';
    } else {
      captionText = `Pomodoro ${snap.pomodorosDone + 1} of ${snap.longBreakEvery}`;
      statusText = todayText;
    }
  } else {
    frac = goal > 0 ? today / goal : 0;
    captionText = todayText;
    if (!running && snap.mode === 'pomodoro' && snap.pomodorosDone > 0) {
      statusText = `${snap.pomodorosDone} of ${snap.longBreakEvery} Pomodoros done · start the next one when you're ready`;
    }
  }
  if (running && snap.paused) statusText = 'Paused · the clock resumes where it left off';
  const pct = Math.min(100, Math.max(0, frac * 100));
  fill.style.strokeDasharray = `${pct} 100`;
  fill.style.opacity = pct > 0 ? '1' : '0'; // a round cap would draw a dot at 0
  document.getElementById('timer-ring')?.classList.toggle('full', !running && pct >= 100);
  if (caption.textContent !== captionText) caption.textContent = captionText;
  if (status.textContent !== statusText) status.textContent = statusText;
}

async function handleTimerEvent(ev) {
  switch (ev.kind) {
    case 'stopped':
      if (ev.saved) showToast('Session saved', { message: `${formatDuration(ev.duration)} added to ${ev.courseCode} — ${ev.courseTitle}${ev.taskText ? ` · ${ev.taskText}` : ''}` });
      else showToast('Session not saved', { message: 'Sessions of 30 seconds or less aren\'t logged.', type: 'info' });
      await reloadData();
      break;
    case 'pomodoro-complete': {
      const brk = ev.breakSecs
        ? ` Take a ${Math.round(ev.breakSecs / 60)}-minute ${ev.longBreak ? 'long ' : ''}break.`
        : ev.autoStarted ? ' The next one has started.' : '';
      showToast('Pomodoro complete', { message: `${formatDuration(ev.duration)} added to ${ev.courseCode}.${brk}`, duration: 8000 });
      await reloadData();
      break;
    }
    case 'break-over':
      showToast('Break\'s over', {
        message: ev.autoStarted ? `The next Pomodoro for ${ev.courseCode} has started.` : 'Start the next Pomodoro when you\'re ready.',
        type: 'info',
        duration: 8000,
      });
      break;
    case 'idle-return':
      askAboutIdleTime(ev.awaySecs, ev.courseCode);
      break;
    default:
      break;
  }
}

let idleQuestionOpen = false;
async function askAboutIdleTime(awaySecs, label) {
  if (idleQuestionOpen) return;
  idleQuestionOpen = true;
  const away = formatDuration(awaySecs);
  const remove = await confirmDialog({
    title: `You were away for ${away}`,
    message: `The timer kept running on ${label} while there was no keyboard or mouse activity. Keep that time, or remove it from this session?`,
    confirmLabel: `Remove ${away}`,
    cancelLabel: 'Keep it',
  });
  idleQuestionOpen = false;
  try {
    await window.api.timerResolveIdle(!remove);
    if (remove) showToast('Time removed', { message: `${away} taken off this session.`, type: 'info' });
  } catch (err) {
    showToast('Could not update the session', { message: errorText(err), type: 'error' });
  }
}

export async function toggleTimer() {
  try {
    if (state.timer.isStudying) {
      await window.api.timerStop();
      return;
    }
    const course = getActiveCourse();
    if (!course) {
      showToast('Add a subject first', { type: 'info' });
      return;
    }
    await window.api.timerStart(course.id, state.timerMode);
  } catch (err) {
    showToast('Timer error', { message: errorText(err), type: 'error' });
  }
}

export async function togglePause() {
  if (!state.timer.isStudying) return;
  try {
    if (state.timer.paused) await window.api.timerResume();
    else await window.api.timerPause();
  } catch (err) {
    showToast('Timer error', { message: errorText(err), type: 'error' });
  }
}

// Switching subject ends the current session, the way it always has.
export async function stopIfRunning() {
  if (state.timer.phase === 'focus') await window.api.timerStop().catch(err => console.error(err));
}

export function setMode(mode) {
  if (state.timer.phase === 'focus') return;
  state.timerMode = mode;
  window.api.setSetting('timer_mode', mode).catch(() => {});
  renderModeTabs();
  if (!state.timer.isStudying) applySnapshot(state.timer);
}

export function renderModeTabs() {
  document.querySelectorAll('.mode-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.mode === state.timerMode));
  const pomodoroTab = document.querySelector('.mode-tab[data-mode="pomodoro"]');
  if (pomodoroTab) pomodoroTab.innerText = `Pomodoro (${state.focusMin}m)`;
  if (!state.timer.isStudying) applySnapshot(state.timer);
}

// A small pill on the other pages while a session runs, linking back to the timer.
export function updateInPageWidget() {
  const onTimerPage = document.getElementById('timer-page')?.classList.contains('active');
  let widget = document.getElementById('mini-timer-widget');
  if (!state.timer.isStudying || onTimerPage) {
    if (widget) widget.remove();
    return;
  }
  if (!widget) {
    widget = document.createElement('div');
    widget.id = 'mini-timer-widget';
    widget.className = 'mini-timer-widget';
    widget.title = 'Back to the timer';
    widget.onclick = () => window.switchToTimerPage();
    document.body.appendChild(widget);
  }
  const label = state.timer.phase === 'break' ? state.timer.courseLabel : (state.timer.courseLabel || '').split(' — ')[0];
  widget.innerHTML = `
    <span class="mini-timer-dot"${state.timer.paused ? ' style="animation:none;opacity:.4"' : ''}></span>
    <span class="mini-timer-time">${escapeHtml(state.timer.timeStr)}</span>
    <span class="mini-timer-course">${escapeHtml(label)}</span>
  `;
}

// ---------- What you're working on ----------
// Saved with the session; kept through a Pomodoro cycle, cleared by Stop.

let noteTimer = null;
let notePending = false;

export function handleNoteInput(input) {
  notePending = true;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => saveNote(input), 500);
}

export function saveNote(input) {
  clearTimeout(noteTimer);
  if (!notePending) return;
  window.api.timerSetNote(input.value)
    .catch(err => console.error('Could not save the note:', err))
    .finally(() => { notePending = false; });
}
