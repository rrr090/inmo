// The Friends page: add people by their friend code and see when they're
// studying. The server side is the "Friends" part of supabase/schema.sql.
//
// While signed in, this also keeps your own status up to date for your
// friends: whether a session is running (with its subject, if you share it),
// your hours today and this week, and your streak. It's written on start,
// stop, pause and break, every minute during a session, and when the totals
// change. Signed out, nothing here talks to the server.
import { icon } from './icons.js';
import { showToast, confirmDialog } from './notify.js';
import { escapeHtml, errorText, formatCompact, localDateKey, weekdayIndex, fmtDay } from './format.js';
import { state, courseById } from './state.js';
import { courseColor } from './colors.js';
import { currentStreak } from './subjects.js';
import { accountClient, currentUser, onAccountChange, accountsConfigured } from './account.js';

const HEARTBEAT_MS = 60_000;  // during a session; the server calls a status 5 minutes old stale
const REFRESH_MS = 60_000;    // the list, while the page is open, besides the live updates
const TICK_MS = 20_000;       // redraws the running clocks

let me = null;           // the signed-in account's id
let profile = null;      // { friend_code, share_subject }
let people = [];         // rows of friends_overview()
let loadedAt = 0;        // when `people` was loaded (Date.now())
let loadError = null;
let loading = null;
let dirty = false;       // a friend's status changed while the page was hidden
let channel = null;
let seenIncoming = null; // incoming request ids already known, so only new ones get a toast
let busy = false;
let lastSessionAt = null;

const isActive = () => document.getElementById('friends-page')?.classList.contains('active');

// ---------- Your status ----------

function deviceId() {
  try {
    let id = localStorage.getItem('inmo-device');
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem('inmo-device', id);
    }
    return id;
  } catch {
    return 'unknown';
  }
}

const clampSecs = (secs) => Math.max(0, Math.min(10_000_000, Math.round(secs || 0)));

function subjectLabel(course) {
  const name = course.code && course.title ? `${course.code} — ${course.title}` : course.code || course.title || '';
  return name.slice(0, 200) || null;
}

function statusRow() {
  const t = state.timer;
  const studying = Boolean(t.isStudying && t.phase === 'focus');
  const onBreak = Boolean(t.isStudying && t.phase === 'break');
  const course = studying || onBreak ? courseById(t.courseId) : null;
  const share = Boolean(profile?.share_subject && course);
  const color = share ? courseColor(course) : null;

  const now = new Date();
  const todayKey = localDateKey(now);
  const monday = new Date(now);
  monday.setDate(monday.getDate() - weekdayIndex(monday));
  const mondayKey = localDateKey(monday);
  let today = 0;
  let week = 0;
  for (const day of state.dailyStats) {
    if (day.date === todayKey) today = day.total_seconds;
    if (day.date >= mondayKey && day.date <= todayKey) week += day.total_seconds;
  }

  return {
    user_id: me,
    device: deviceId(),
    studying,
    on_break: onBreak,
    paused: studying && Boolean(t.paused),
    elapsed_secs: studying ? Math.min(172_800, clampSecs(t.elapsedSecs)) : 0,
    subject: share ? subjectLabel(course) : null,
    subject_color: color && /^#[0-9a-f]{6}$/i.test(color) ? color : null,
    today_secs: clampSecs(today),
    week_secs: clampSecs(week),
    streak_days: currentStreak(),
    stats_date: todayKey,
    utc_offset_min: -now.getTimezoneOffset(),
    last_session_at: lastSessionAt,
  };
}

let lastSent = '';
let lastSentAt = 0;
let publishing = null;
let publishAgain = false;

// Sends the status if it changed, or if a session's heartbeat is due. A
// failed send is tried again on the next timer tick or check.
function publish(force = false) {
  if (!me) return Promise.resolve();
  const row = statusRow();
  const key = JSON.stringify({ ...row, elapsed_secs: 0 }); // the clock alone isn't a change
  const live = row.studying || row.on_break;
  const due = live && Date.now() - lastSentAt >= HEARTBEAT_MS;
  if (!force && key === lastSent && !due) return Promise.resolve();
  if (publishing) {
    publishAgain = true;
    return publishing;
  }
  publishing = (async () => {
    try {
      const sb = await accountClient();
      const { error } = await sb.from('statuses').upsert(row, { onConflict: 'user_id' });
      if (error) throw error;
      lastSent = key;
      lastSentAt = Date.now();
    } catch (err) {
      console.error('Could not update your status for friends:', err);
      lastSentAt = Date.now(); // wait a heartbeat before trying again
    } finally {
      publishing = null;
      if (publishAgain) {
        publishAgain = false;
        publish();
      }
    }
  })();
  return publishing;
}

// Called by account.js before signing out, so friends don't see a session
// that's still running as studying for the next few minutes.
export async function clearStatus() {
  if (!me) return;
  try {
    const sb = await accountClient();
    await sb.from('statuses').upsert({ ...statusRow(), studying: false, on_break: false, paused: false, elapsed_secs: 0, subject: null, subject_color: null }, { onConflict: 'user_id' });
  } catch (err) {
    console.error('Could not clear your status:', err);
  }
}

// On every data change: the totals may have moved.
export async function friendsDataChanged() {
  if (!me) return;
  try {
    const { rows } = await window.api.getHistory(1, '');
    lastSessionAt = rows.length ? new Date(rows[0].ended_at * 1000).toISOString() : null;
  } catch (err) {
    console.error('Could not read the latest session:', err);
  }
  publish();
}

// ---------- Friends and requests ----------

function friendly(err) {
  const text = errorText(err);
  if (/failed to fetch|network/i.test(text)) return 'Can\'t reach the server. Check your internet connection.';
  if (/friend_code|friends_overview|friend_add|statuses|schema cache|does not exist/i.test(text)) return 'Friends aren\'t set up on the server yet.';
  return text;
}

async function loadProfile(sb) {
  const { data, error } = await sb.from('profiles').select('friend_code, share_subject').eq('id', me).maybeSingle();
  if (error) throw error;
  profile = data || { friend_code: '', share_subject: false };
}

function refresh() {
  if (!me) return Promise.resolve();
  if (loading) {
    dirty = true;
    return loading;
  }
  const forUser = me;
  loading = (async () => {
    try {
      const sb = await accountClient();
      if (!profile) await loadProfile(sb);
      const { data, error } = await sb.rpc('friends_overview');
      if (error) throw error;
      if (forUser !== me) return;
      people = data || [];
      loadedAt = Date.now();
      loadError = null;
      dirty = false;
      noticeNewRequests();
    } catch (err) {
      console.error('Could not load friends:', err);
      if (forUser === me) loadError = friendly(err);
    } finally {
      loading = null;
    }
    render();
    updateBadge();
  })();
  return loading;
}

let refreshTimer = null;
function refreshSoon(delay = 800) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, delay);
}

// A friend's status changed. Their heartbeat comes every minute, so while
// nobody's looking it's only noted.
function friendChanged() {
  if (isActive() && !document.hidden) refreshSoon(1000);
  else dirty = true;
}

function noticeNewRequests() {
  const incoming = people.filter(p => p.relation === 'incoming');
  if (seenIncoming) {
    const fresh = incoming.filter(p => !seenIncoming.has(p.user_id));
    if (fresh.length && !isActive()) {
      const who = fresh.length === 1 ? nameOf(fresh[0]) : `${fresh.length} people`;
      showToast('Friend request', {
        message: `${who} want${fresh.length === 1 ? 's' : ''} to be friends.`,
        type: 'info',
        duration: 8000,
        action: { label: 'View', onClick: () => window.switchPage('friends-page') },
      });
    }
  }
  seenIncoming = new Set(incoming.map(p => p.user_id));
}

function subscribe(sb) {
  channel = sb.channel(`friends-${me}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'statuses' }, (payload) => {
      const id = payload.new?.user_id || payload.old?.user_id;
      if (id && id !== me) friendChanged();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'friend_signals' }, () => refreshSoon(300))
    .subscribe((status) => {
      // After a dropped connection, catch up on what was missed.
      if (status === 'SUBSCRIBED' && loadedAt) refreshSoon(0);
    });
}

async function accountChanged(user) {
  const id = user?.id ?? null;
  if (id === me) return;
  if (channel) {
    const old = channel;
    channel = null;
    accountClient().then(sb => sb.removeChannel(old)).catch(() => {});
  }
  me = id;
  profile = null;
  people = [];
  loadedAt = 0;
  loadError = null;
  dirty = false;
  seenIncoming = null;
  lastSent = '';
  lastSentAt = 0;
  render();
  updateBadge();
  if (!me) return;
  try {
    subscribe(await accountClient());
  } catch (err) {
    console.error('Could not listen for friends\' updates:', err);
  }
  await refresh();
  await friendsDataChanged();
}

// ---------- Drawing ----------

const nameOf = (p) => (p.display_name || '').trim() || 'Unnamed';

function initial(p) {
  return escapeHtml(nameOf(p).charAt(0).toUpperCase());
}

// The running session's length now, from when the list was loaded.
function liveElapsed(p) {
  if (!p.studying) return 0;
  return p.elapsed_secs + (p.paused ? 0 : (Date.now() - loadedAt) / 1000);
}

function agoText(iso) {
  const then = new Date(iso);
  const mins = Math.round((Date.now() - then.getTime()) / 60000);
  if (mins < 60) return mins <= 1 ? 'just now' : `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24 && then.toDateString() === new Date().toDateString()) return `${hours} h ago`;
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (then.toDateString() === yesterday.toDateString()) return 'yesterday';
  return fmtDay(then);
}

function statusHtml(p) {
  const subject = p.subject ? ` · <span class="friend-subject" title="${escapeHtml(p.subject)}">${escapeHtml(p.subject)}</span>` : '';
  if (p.studying) {
    const what = p.paused ? 'Paused' : 'Studying';
    return `<span class="friend-live${p.paused ? ' paused' : ''}"></span>${what} for ${formatCompact(liveElapsed(p))}${subject}`;
  }
  if (p.on_break) return `<span class="friend-live break"></span>On a break${subject}`;
  if (p.last_session_at) return `Last studied ${escapeHtml(agoText(p.last_session_at))}`;
  return 'Hasn\'t studied yet';
}

function friendHtml(p) {
  const live = p.studying || p.on_break;
  const extra = p.studying ? liveElapsed(p) : 0;
  const color = p.subject_color && live ? ` style="--c: ${escapeHtml(p.subject_color)}"` : '';
  const streak = p.streak_days || 0;
  return `
    <div class="friend-row${live ? ' live' : ''}"${color}>
      <div class="friend-avatar" aria-hidden="true">${initial(p)}</div>
      <div class="friend-main">
        <div class="friend-name">${escapeHtml(nameOf(p))}</div>
        <div class="friend-status">${statusHtml(p)}</div>
      </div>
      <div class="friend-stats">
        <div><span>Today</span><b>${formatCompact((p.today_secs || 0) + extra)}</b></div>
        <div><span>This week</span><b>${formatCompact((p.week_secs || 0) + extra)}</b></div>
        <div class="friend-streak${streak ? ' on' : ''}" title="Days in a row with some study">${icon('flame', 13)}<b>${streak}</b></div>
      </div>
      <button class="icon-btn danger friend-remove" data-action="remove" data-id="${escapeHtml(p.user_id)}" title="Remove friend" aria-label="Remove ${escapeHtml(nameOf(p))} from friends">${icon('x', 14)}</button>
    </div>`;
}

function requestHtml(p) {
  const id = escapeHtml(p.user_id);
  const actions = p.relation === 'incoming'
    ? `<button class="btn-primary" data-action="accept" data-id="${id}">Accept</button>
       <button class="btn-secondary" data-action="decline" data-id="${id}">Decline</button>`
    : `<button class="btn-secondary" data-action="cancel" data-id="${id}">Cancel request</button>`;
  return `
    <div class="friend-row request">
      <div class="friend-avatar" aria-hidden="true">${initial(p)}</div>
      <div class="friend-main">
        <div class="friend-name">${escapeHtml(nameOf(p))}</div>
        <div class="friend-status">${p.relation === 'incoming' ? 'Wants to be friends' : 'Request sent, waiting for them to accept'}</div>
      </div>
      <div class="friend-request-actions">${actions}</div>
    </div>`;
}

const codeText = (code) => (code && code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code || '');

function signedInHtml() {
  const friends = people.filter(p => p.relation === 'friend').sort((a, b) =>
    (Number(b.studying || b.on_break) - Number(a.studying || a.on_break))
    || ((b.today_secs || 0) + liveElapsed(b)) - ((a.today_secs || 0) + liveElapsed(a))
    || nameOf(a).localeCompare(nameOf(b)));
  const incoming = people.filter(p => p.relation === 'incoming');
  const outgoing = people.filter(p => p.relation === 'outgoing');
  const studyingNow = friends.filter(p => p.studying).length;
  const ready = Boolean(profile);

  const error = loadError ? `
    <div class="friends-error" role="alert">${icon('triangle-alert', 14)}<span>${escapeHtml(loadError)}</span>
      <button type="button" class="link-btn" data-action="retry">Try again</button></div>` : '';

  const requests = incoming.length || outgoing.length ? `
    <div class="section-box">
      <h3 class="label-with-icon">${icon('bell', 16)}Requests</h3>
      <div class="friend-list">${[...incoming, ...outgoing].map(requestHtml).join('')}</div>
    </div>` : '';

  let list;
  if (!loadedAt && !loadError) list = '<p class="section-sub friends-loading">Loading…</p>';
  else if (!friends.length) {
    list = `
      <div class="empty-state">
        ${icon('users', 22)}
        <div class="empty-state-title">No friends yet</div>
        <div class="empty-state-text">Send someone your friend code, or add theirs above.</div>
      </div>`;
  } else list = `<div class="friend-list">${friends.map(friendHtml).join('')}</div>`;

  return `
    ${error}
    <div class="section-box">
      <h3 class="label-with-icon">${icon('user-plus', 16)}Add a friend</h3>
      <div class="friends-add">
        <div class="friend-code-card">
          <span class="friend-code-label">Your friend code</span>
          <span class="friend-code" id="my-friend-code">${ready ? escapeHtml(codeText(profile.friend_code)) : '········'}</span>
          <div class="friend-code-actions">
            <button type="button" class="btn-outline" data-action="copy"${ready ? '' : ' disabled'}>${icon('copy', 14)}Copy</button>
            <button type="button" class="btn-secondary" data-action="new-code"${ready ? '' : ' disabled'}>New code</button>
          </div>
        </div>
        <form class="friend-add-form" data-submit="add">
          <label for="friend-code-input">Friend's code</label>
          <div class="friend-add-inputs">
            <input type="text" id="friend-code-input" maxlength="12" placeholder="ABCD EFGH" autocomplete="off" spellcheck="false" required>
            <button type="submit" class="btn-primary">Send request</button>
          </div>
          <p class="form-hint">They'll see your request and can accept it. Friends see each other's status.</p>
        </form>
      </div>
      <div class="settings-toggles settings-inline">
        <div class="setting-row">
          <div class="setting-row-info">
            <span class="setting-row-icon">${icon('book-open', 16)}</span>
            <div>
              <div class="setting-row-title">Show friends what I'm studying</div>
              <div class="setting-row-desc">Friends always see when you're studying and your hours. With this on, they also see the subject. Notes are never shared.</div>
            </div>
          </div>
          <label class="toggle-switch"><input type="checkbox" data-action="share" aria-label="Show friends what I'm studying"${profile?.share_subject ? ' checked' : ''}${ready ? '' : ' disabled'}><span class="toggle-slider"></span></label>
        </div>
      </div>
    </div>
    ${requests}
    <div class="section-box">
      <div class="section-head">
        <h3 class="label-with-icon">${icon('users', 16)}Friends${friends.length ? ` <span class="friends-count">${friends.length}</span>` : ''}</h3>
        ${studyingNow ? `<span class="friends-now"><span class="friend-live"></span>${studyingNow} studying now</span>` : ''}
      </div>
      ${list}
    </div>`;
}

function render() {
  const body = document.getElementById('friends-body');
  if (!body || !isActive()) return;
  // Keep a code that's being typed.
  const typed = document.getElementById('friend-code-input');
  const typedValue = typed?.value ?? '';
  const hadFocus = typed && document.activeElement === typed;

  if (!accountsConfigured()) {
    body.innerHTML = `<div class="section-box"><p class="section-sub">Friends need accounts, which aren't set up in this build of inmo.</p></div>`;
  } else if (!me) {
    body.innerHTML = `
      <div class="section-box friends-signin">
        <div class="empty-state">
          ${icon('users', 22)}
          <div class="empty-state-title">Sign in to add friends</div>
          <div class="empty-state-text">Friends need an account. Create one or sign in under Settings → Account, then come back here.</div>
        </div>
        <button type="button" class="btn-primary" data-action="settings">Go to Settings</button>
      </div>`;
  } else {
    body.innerHTML = signedInHtml();
  }
  body.classList.toggle('busy', busy);
  const input = document.getElementById('friend-code-input');
  if (input) {
    input.value = typedValue;
    if (hadFocus) input.focus();
  }
}

function updateBadge() {
  const badge = document.getElementById('friends-badge');
  if (!badge) return;
  const count = me ? people.filter(p => p.relation === 'incoming').length : 0;
  badge.textContent = count > 9 ? '9+' : String(count);
  badge.classList.toggle('is-hidden', count === 0);
  badge.title = count === 1 ? '1 friend request' : `${count} friend requests`;
}

// From switchPage.
export function showFriendsPage() {
  render();
  if (me && (dirty || loadError || Date.now() - loadedAt > 10_000)) refresh();
}

// ---------- Actions ----------

async function run(fn) {
  if (busy) return;
  busy = true;
  document.getElementById('friends-body')?.classList.add('busy');
  try {
    await fn(await accountClient());
  } catch (err) {
    showToast('Friends', { message: friendly(err), type: 'error' });
  } finally {
    busy = false;
    render();
  }
}

const personById = (id) => people.find(p => p.user_id === id);

async function copyCode() {
  const code = profile?.friend_code;
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    showToast('Friend code copied', { message: `Send ${codeText(code)} to a friend so they can add you.` });
  } catch {
    const el = document.getElementById('my-friend-code');
    if (el) window.getSelection()?.selectAllChildren(el);
    showToast('Couldn\'t copy', { message: 'The code is selected: press Ctrl+C.', type: 'info' });
  }
}

const ACTIONS = {
  settings: () => window.switchPage('settings-page'),
  retry: () => refresh(),
  copy: copyCode,
  'new-code': async () => {
    const ok = await confirmDialog({
      title: 'Get a new friend code?',
      message: 'Your current code stops working, so nobody new can add you with it. Your friends and requests stay.',
      confirmLabel: 'New code',
      danger: false,
    });
    if (!ok) return;
    await run(async (sb) => {
      const { data, error } = await sb.rpc('friend_code_reset');
      if (error) throw error;
      profile = { ...profile, friend_code: data };
      showToast('New friend code', { message: codeText(data) });
    });
  },
  accept: (id) => run(async (sb) => {
    const { error } = await sb.rpc('friend_accept', { other: id });
    if (error) throw error;
    showToast('Friend added', { message: `You and ${nameOf(personById(id) || {})} are friends now.` });
    await refresh();
  }),
  decline: (id) => run(async (sb) => {
    const { error } = await sb.rpc('friend_remove', { other: id });
    if (error) throw error;
    await refresh();
  }),
  cancel: (id) => ACTIONS.decline(id),
  remove: async (id) => {
    const name = nameOf(personById(id) || {});
    const ok = await confirmDialog({
      title: `Remove ${name} from your friends?`,
      message: 'You stop seeing each other\'s status. You can add each other again with your friend codes.',
      confirmLabel: 'Remove',
    });
    if (!ok) return;
    await run(async (sb) => {
      const { error } = await sb.rpc('friend_remove', { other: id });
      if (error) throw error;
      showToast('Friend removed', { message: name, type: 'info' });
      await refresh();
    });
  },
};

async function addFriend() {
  const input = document.getElementById('friend-code-input');
  const code = (input?.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 8) {
    showToast('A friend code has 8 letters and numbers', { type: 'error' });
    return;
  }
  if (code === profile?.friend_code) {
    showToast('That\'s your own friend code', { message: 'Ask your friend for theirs.', type: 'info' });
    return;
  }
  await run(async (sb) => {
    const { data, error } = await sb.rpc('friend_add', { code });
    if (error) throw error;
    const name = (data?.name || '').trim() || 'them';
    const messages = {
      requested: ['Request sent', `${name === 'them' ? 'They' : name} can accept it in inmo.`, 'success'],
      accepted: ['Friend added', `${name} had already sent you a request, so you're friends now.`, 'success'],
      friends: ['Already friends', `You and ${name} are already friends.`, 'info'],
      pending: ['Already sent', `You already sent ${name} a request.`, 'info'],
    };
    const [title, message, type] = messages[data?.result] || ['Done', '', 'success'];
    showToast(title, { message, type });
    const el = document.getElementById('friend-code-input');
    if (el) el.value = '';
    await refresh();
  });
}

async function setShare(checked, input) {
  await run(async (sb) => {
    const { error } = await sb.from('profiles').update({ share_subject: checked }).eq('id', me);
    if (error) {
      input.checked = !checked;
      throw error;
    }
    profile = { ...profile, share_subject: checked };
    await publish(true);
  });
}

function wire() {
  const body = document.getElementById('friends-body');
  if (!body || body.dataset.wired) return;
  body.dataset.wired = '1';
  body.addEventListener('submit', (event) => {
    event.preventDefault();
    if (event.target.dataset.submit === 'add') addFriend();
  });
  body.addEventListener('click', (event) => {
    const el = event.target.closest('button[data-action]');
    if (el && !el.disabled && ACTIONS[el.dataset.action]) ACTIONS[el.dataset.action](el.dataset.id);
  });
  body.addEventListener('change', (event) => {
    if (event.target.dataset.action === 'share') setShare(event.target.checked, event.target);
  });
}

export function initFriends() {
  wire();
  onAccountChange(accountChanged);
  const user = currentUser();
  if (user) accountChanged(user);
  // Every timer tick: sends the status when the session changes or a heartbeat is due.
  window.api.onTimerState(() => publish());
  setInterval(() => {
    publish(); // a new day, or a send that failed
    if (me && isActive() && !document.hidden && Date.now() - loadedAt > REFRESH_MS) refresh();
  }, 30_000);
  setInterval(() => {
    const typing = document.activeElement?.id === 'friend-code-input';
    if (me && isActive() && !document.hidden && !loading && !typing) render();
  }, TICK_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && me && isActive() && (dirty || Date.now() - loadedAt > REFRESH_MS)) refresh();
  });
  render();
}
