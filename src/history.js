// The Session History page: the log, adding and editing sessions by hand, and
// CSV export / import.
import { icon } from './icons.js';
import { showToast, showUndoToast } from './notify.js';
import { state, activeCourses, courseById, reloadData } from './state.js';
import { escapeHtml, formatHM, formatDuration, localDateKey, localTimeKey, emptyState, errorText } from './format.js';

const PAGE = 50;
let shown = PAGE;
let rowsById = new Map();
let search = '';
let searchTimer = null;

export function isHistoryPageActive() {
  return Boolean(document.getElementById('history-page')?.classList.contains('active'));
}

export async function renderHistory() {
  const tbody = document.getElementById('history-table-body');
  if (!tbody) return;
  const { rows, total } = await window.api.getHistory(shown, search);
  rowsById = new Map(rows.map(r => [r.id, r]));

  const more = document.getElementById('history-more');
  if (more) {
    more.classList.toggle('is-hidden', rows.length >= total);
    more.innerText = `Show more (${total - rows.length} older)`;
  }

  if (rows.length === 0) {
    tbody.innerHTML = search
      ? `<tr class="empty-row"><td colspan="4">${emptyState('history', 'No matching sessions', `Nothing in notes or subject names matches "${search}".`)}</td></tr>`
      : `<tr class="empty-row"><td colspan="4">${emptyState('history', 'No sessions yet', 'Finished study sessions are listed here. Studied without the timer? Add the session by hand.')}</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(row => `
    <tr>
      <td>${escapeHtml(row.created_at)}</td>
      <td><b>${escapeHtml(row.code)}</b> - ${escapeHtml(row.title)}${row.note ? `<div class="history-note">${escapeHtml(row.note)}</div>` : ''}</td>
      <td class="history-duration">${formatHM(row.duration)}</td>
      <td class="history-actions">
        <button class="delete-item-btn" onclick="window.openSessionDialog(${row.id})" title="Edit session" aria-label="Edit session">${icon('pencil', 15)}</button>
        <button class="delete-item-btn" onclick="window.handleDeleteSession(${row.id})" title="Delete session" aria-label="Delete session">${icon('trash-2', 15)}</button>
      </td>
    </tr>
  `).join('');
}

// Filters by note or subject as you type.
export function handleHistorySearch(input) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    search = input.value.trim();
    shown = PAGE;
    renderHistory();
  }, 250);
}

export function showMoreHistory() {
  shown += PAGE;
  renderHistory();
}

export async function handleDeleteSession(sessionId) {
  const row = rowsById.get(sessionId);
  const r = await window.api.deleteSession(sessionId);
  await reloadData();
  showUndoToast('Session deleted', row ? `${formatDuration(row.duration)} · ${row.code}` : '', r.undoId, reloadData);
}

// ---------- Add / edit a session ----------

// sessionId: edit that session; omitted: add a new one ending now.
export function openSessionDialog(sessionId) {
  const editing = sessionId ? rowsById.get(sessionId) : null;
  const durationMin = editing ? Math.round(editing.duration / 60) : 60;
  const start = editing
    ? new Date((editing.ended_at - editing.duration) * 1000)
    : new Date(Date.now() - durationMin * 60000);
  const courseId = editing ? editing.course_id : state.activeCourseId;

  // Active subjects, plus this session's own subject if it has been archived.
  const options = activeCourses().slice();
  if (editing && !options.some(c => c.id === courseId)) {
    const own = courseById(courseId);
    if (own) options.push(own);
  }
  if (options.length === 0) {
    showToast('Add a subject first', { type: 'info' });
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay open';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="session-dialog-title">
      <h2 id="session-dialog-title">${editing ? 'Edit session' : 'Add a session'}</h2>
      <div class="form-group">
        <label for="session-course">Subject</label>
        <select id="session-course">
          ${options.map(c => `<option value="${escapeHtml(c.id)}" ${c.id === courseId ? 'selected' : ''}>${escapeHtml(c.code)} — ${escapeHtml(c.title)}${c.archived ? ' (archived)' : ''}</option>`).join('')}
        </select>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label for="session-date">Date</label>
          <input type="date" id="session-date" value="${localDateKey(start)}" max="${localDateKey(new Date())}">
        </div>
        <div class="form-group">
          <label for="session-start">Started at</label>
          <input type="time" id="session-start" value="${localTimeKey(start)}">
        </div>
        <div class="form-group">
          <label for="session-minutes">Minutes</label>
          <input type="number" id="session-minutes" min="1" max="720" step="1" value="${durationMin}">
        </div>
      </div>
      <div class="form-group">
        <label for="session-note-field">What you worked on (optional)</label>
        <input type="text" id="session-note-field" maxlength="500" value="${escapeHtml(editing?.note || '')}" placeholder="e.g. Chapter 4 exercises">
      </div>
      <p class="modal-text" id="session-summary"></p>
      <div class="modal-actions">
        <button class="btn-secondary" data-action="cancel">Cancel</button>
        <button class="btn-primary" data-action="save">${editing ? 'Save' : 'Add session'}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const $ = sel => overlay.querySelector(sel);
  const read = () => {
    const [y, m, d] = ($('#session-date').value || '').split('-').map(Number);
    const [hh, mm] = ($('#session-start').value || '').split(':').map(Number);
    const minutes = Number($('#session-minutes').value);
    if (!y || Number.isNaN(hh) || Number.isNaN(mm)) return { error: 'Pick a date and a start time.' };
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 720) return { error: 'Minutes must be a whole number from 1 to 720 (12 hours).' };
    const startAt = new Date(y, m - 1, d, hh, mm);
    const endAt = new Date(startAt.getTime() + minutes * 60000);
    if (endAt.getTime() > Date.now() + 60000) return { error: 'The session would end in the future.' };
    return { courseId: $('#session-course').value, endedAt: Math.floor(endAt.getTime() / 1000), duration: minutes * 60, endAt, note: $('#session-note-field').value };
  };
  const refreshSummary = () => {
    const r = read();
    const summary = $('#session-summary');
    summary.classList.toggle('form-error', Boolean(r.error));
    summary.innerText = r.error || `Ends at ${localTimeKey(r.endAt)}${localDateKey(r.endAt) !== $('#session-date').value ? ' the next day' : ''} · ${formatDuration(r.duration)}`;
  };
  overlay.addEventListener('input', refreshSummary);
  refreshSummary();

  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
  };
  const save = async () => {
    const r = read();
    if (r.error) return refreshSummary();
    try {
      if (editing) await window.api.updateSession(editing.id, r.courseId, r.endedAt, r.duration, r.note);
      else await window.api.addSession(r.courseId, r.endedAt, r.duration, r.note);
      close();
      await reloadData();
      showToast(editing ? 'Session updated' : 'Session added', { message: `${formatDuration(r.duration)} · ${courseById(r.courseId)?.code || ''}` });
    } catch (err) {
      const summary = $('#session-summary');
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
    if (e.target === overlay || e.target.dataset.action === 'cancel') close();
    if (e.target.dataset.action === 'save') save();
  });
  $('#session-minutes').focus();
}

// ---------- CSV ----------

export async function handleExportCsv() {
  try {
    const result = await window.api.exportSessionsCsv();
    if (!result || result.canceled) return;
    showToast('Sessions exported', { message: `${result.count} ${result.count === 1 ? 'session' : 'sessions'} saved to ${result.filePath}` });
  } catch (err) {
    showToast('Could not export sessions', { message: errorText(err), type: 'error' });
  }
}

export async function handleImportCsv() {
  try {
    const r = await window.api.importSessionsCsv();
    if (!r || r.canceled) return;
    await reloadData();
    const parts = [`${r.imported} imported`];
    if (r.duplicates) parts.push(`${r.duplicates} already here`);
    if (r.invalid) parts.push(`${r.invalid} unreadable`);
    if (r.newSubjects.length) parts.push(`new subjects: ${r.newSubjects.join(', ')}`);
    showToast(r.imported ? 'Sessions imported' : 'Nothing new to import', {
      message: `${parts.join(' · ')}. A backup of your data from before the import is in the backups folder.`,
      type: r.imported ? 'success' : 'info',
      duration: 9000,
    });
  } catch (err) {
    showToast('Could not import sessions', { message: errorText(err), type: 'error', duration: 10000 });
  }
}
