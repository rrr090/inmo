// Sync with the signed-in account: uploads what changed here, then downloads
// what other devices changed. The local side (which rows changed, applying
// remote ones, newer-wins) is in src-tauri/src/sync.rs; the tables on the
// server are in supabase/schema.sql. Signed out, nothing here runs.
//
// It runs after signing in, at startup, a few seconds after a change, when the
// window comes back into focus, and every two minutes while it's open.
import { reloadData } from './state.js';
import { accountClient, currentUser } from './account.js';
import { escapeHtml, errorText } from './format.js';

// Local table → server table, in the order they're applied.
const TABLES = [['courses', 'courses'], ['tasks', 'tasks'], ['study_sessions', 'sessions']];
const PAGE = 1000;
const PUSH_BATCH = 500; // matches sync_pending in sync.rs
// Downloads start a minute before the last one ended: a row written just
// before then may only have been committed after it.
const OVERLAP_MS = 60_000;

let status = { state: 'idle', at: null, error: null };
let running = null;
let again = false;
let timer = null;
// The reload after a download changes data, which would schedule another sync.
let quietUntil = 0;

function setStatus(next) {
  status = { ...status, ...next };
  renderSyncStatus();
}

export function scheduleSync(delay = 4000) {
  if (!currentUser() || Date.now() < quietUntil) return;
  clearTimeout(timer);
  timer = setTimeout(() => { syncNow(); }, delay);
}

async function push(sb, userId) {
  let sent = 0;
  for (;;) {
    const pending = await window.api.syncPending();
    let full = false;
    for (const [local, remote] of TABLES) {
      const rows = pending[local] || [];
      if (!rows.length) continue;
      const { error } = await sb.from(remote).upsert(rows.map(r => ({ ...r, user_id: userId })), { onConflict: 'user_id,id' });
      if (error) throw error;
      await window.api.syncMarkPushed(local, rows);
      sent += rows.length;
      full ||= rows.length >= PUSH_BATCH;
    }
    if (!full) return sent;
  }
}

async function pull(sb) {
  const cursors = await window.api.syncCursors();
  let changed = 0;
  for (const [local, remote] of TABLES) {
    let from = cursors[local] ? new Date(Date.parse(cursors[local]) - OVERLAP_MS).toISOString() : null;
    for (;;) {
      let query = sb.from(remote).select('*').order('server_ts', { ascending: true }).limit(PAGE);
      if (from) query = query.gte('server_ts', from);
      const { data, error } = await query;
      if (error) throw error;
      if (!data.length) break;
      const last = data[data.length - 1].server_ts;
      const result = await window.api.syncApply(local, data, last);
      changed += result.changed;
      if (data.length < PAGE || last === from) break;
      from = last;
    }
  }
  return changed;
}

export async function syncNow() {
  const user = currentUser();
  if (!user) {
    setStatus({ state: 'idle', error: null });
    return;
  }
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    setStatus({ state: 'syncing', error: null });
    try {
      const sb = await accountClient();
      await window.api.syncLink(user.id);
      await push(sb, user.id);
      const changed = await pull(sb);
      if (changed > 0) {
        quietUntil = Date.now() + 2000;
        await reloadData();
      }
      setStatus({ state: 'ok', at: Date.now(), error: null });
    } catch (err) {
      console.error('Sync failed:', err);
      setStatus({ state: 'error', error: /failed to fetch|network/i.test(errorText(err)) ? 'Offline' : errorText(err) });
    } finally {
      running = null;
      if (again) {
        again = false;
        scheduleSync(500);
      }
    }
  })();
  return running;
}

function agoText(at) {
  const secs = Math.round((Date.now() - at) / 1000);
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  return new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// The line on the Account card.
export function renderSyncStatus() {
  const el = document.getElementById('sync-status');
  if (!el) return;
  let text;
  if (status.state === 'syncing') text = 'Syncing…';
  else if (status.state === 'error') text = `Couldn't sync: ${escapeHtml(status.error)}. Your data is safe on this computer and will sync later.`;
  else if (status.at) text = `Synced ${agoText(status.at)}. Subjects, tasks and sessions follow your account to other devices.`;
  else text = 'Subjects, tasks and sessions follow your account to other devices.';
  el.className = `section-sub account-note sync-status ${status.state}`;
  el.innerHTML = `<span>${text}</span>${status.state === 'syncing' ? '' : ' <button type="button" class="link-btn" data-action="sync">Sync now</button>'}`;
}

export function initSync() {
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleSync(500); });
  window.addEventListener('focus', () => scheduleSync(500));
  setInterval(() => { if (!document.hidden) scheduleSync(0); }, 2 * 60 * 1000);
  // Keep "Synced 3 min ago" current while Settings is open.
  setInterval(renderSyncStatus, 30 * 1000);
}
