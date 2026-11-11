// Formatting and date helpers shared by every page.
import { icon } from './icons.js';

// Anything a person typed (subject names, task text) goes through this before
// it's put into HTML, including names that arrive in an imported CSV.
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

export function formatHM(totalSecs) {
  const hrs = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  return `${hrs}h ${mins}m`;
}

// For messages, where "0h 0m" would read as if nothing was saved.
export function formatDuration(totalSecs) {
  if (totalSecs < 60) return `${totalSecs} sec`;
  if (totalSecs < 3600) return `${Math.floor(totalSecs / 60)} min`;
  return formatHM(totalSecs);
}

// "2h 5m", "45m", "<1m" - compact enough for tiles and tooltips.
export function formatCompact(totalSecs) {
  const secs = Math.round(totalSecs);
  const hrs = Math.floor(secs / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  if (hrs > 0) return mins ? `${hrs}h ${mins}m` : `${hrs}h`;
  if (mins > 0) return `${mins}m`;
  return secs > 0 ? '<1m' : '0m';
}

export function formatClock(secs, withHours) {
  const s = Math.max(0, Math.floor(secs));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return withHours ? `${hh}:${mm}:${ss}` : `${String(Math.floor(s / 60)).padStart(2, '0')}:${ss}`;
}

// YYYY-MM-DD in the user's timezone, matching DATE(created_at, 'localtime') in the
// backend. toISOString() would give the UTC date, a day off for part of each day.
export function localDateKey(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function localTimeKey(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function parseDateKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

// `count` local days, oldest first, ending `offset` days before today.
export function daysBack(count, offset = 0) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = [];
  for (let i = count - 1 + offset; i >= offset; i--) days.push(addDays(today, -i));
  return days;
}

export function fmtDay(date, withWeekday = false) {
  return date.toLocaleDateString('en-US', withWeekday
    ? { weekday: 'short', month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric' });
}

export function weekdayIndex(date) {
  return (date.getDay() + 6) % 7; // Monday = 0
}

export function emptyState(iconName, title, text) {
  return `
    <div class="empty-state">
      ${icon(iconName, 22)}
      <div class="empty-state-title">${escapeHtml(title)}</div>
      <div class="empty-state-text">${escapeHtml(text)}</div>
    </div>
  `;
}

export function errorText(err) {
  return String((err && err.message) || err);
}
