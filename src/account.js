// Optional inmo accounts, backed by Supabase (see supabase/schema.sql). Lives in
// Settings → Account. With EMAIL_CODES on, sign-up and password resets are
// confirmed with a 6-digit code from an email, so there is no browser round trip;
// without it, sign-up is confirmed by the email's link and there is no reset yet. An account holds only a profile for now; study data
// stays on this computer.
import { showToast, confirmDialog } from './notify.js';
import { escapeHtml, errorText } from './format.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY, EMAIL_CODES, EMAIL_LINK_LANDING } from './supabase-config.js';

// Where an email's confirmation link lands. Without it, Supabase sends the
// browser to the page that asked, which in the app is http://tauri.localhost.
const linkOptions = EMAIL_LINK_LANDING ? { emailRedirectTo: EMAIL_LINK_LANDING } : {};

const configured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
let client = null;
let user = null;
let profile = null;
// signin | signup | verify | reset | reset-verify | account | edit-name
let view = 'signin';
let pendingEmail = '';
let busy = false;

// The library loads the first time it's needed (a sign-in, or a saved one being
// restored), not at startup. build-ui.js copies it to vendor/.
let loading = null;
function loadLibrary() {
  if (window.supabase?.createClient) return Promise.resolve();
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '../vendor/@supabase/supabase-js/dist/umd/supabase.js';
    script.onload = () => resolve();
    script.onerror = () => {
      loading = null;
      reject(new Error('Could not load the accounts library'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

async function getClient() {
  if (client) return client;
  await loadLibrary();
  client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'inmo-auth' },
  });
  client.auth.onAuthStateChange((_event, session) => {
    const next = session?.user ?? null;
    if (next?.id === user?.id) return;
    user = next;
    profile = null;
    if (user) {
      view = 'account';
      // Not from inside this callback: Supabase holds a lock while it runs.
      setTimeout(loadProfile, 0);
    } else if (view === 'account' || view === 'edit-name') {
      view = 'signin';
    }
    renderAccount();
  });
  return client;
}

// Signs back in from the saved session at startup, if there is one, without
// loading the library when nobody has ever signed in on this computer.
export async function initAccount() {
  if (!configured) return;
  let saved = null;
  try { saved = localStorage.getItem('inmo-auth'); } catch { /* storage blocked */ }
  if (!saved) return;
  try {
    const sb = await getClient();
    const { data } = await sb.auth.getSession();
    user = data.session?.user ?? null;
    if (user) {
      view = 'account';
      await loadProfile();
    }
  } catch (err) {
    console.error('Could not restore the account session:', err);
  }
}

async function loadProfile() {
  if (!user) return;
  try {
    const { data, error } = await client.from('profiles').select('display_name').eq('id', user.id).maybeSingle();
    if (error) throw error;
    profile = data || { display_name: user.user_metadata?.display_name || '' };
  } catch (err) {
    console.error('Could not load the profile:', err);
    profile = { display_name: user.user_metadata?.display_name || '' };
  }
  renderAccount();
}

// ---------- Drawing ----------

function field(id, label, type, attrs = '') {
  return `
    <div class="form-group">
      <label for="${id}">${label}</label>
      <input type="${type}" id="${id}" ${attrs}>
    </div>`;
}

function views() {
  const email = escapeHtml(pendingEmail);
  switch (view) {
    case 'signup':
      return `
        <form class="account-form" data-submit="signup">
          ${field('acc-name', 'Name', 'text', 'maxlength="40" autocomplete="nickname" placeholder="Shown to friends in shared features later"')}
          ${field('acc-email', 'Email', 'email', `required autocomplete="email" value="${email}"`)}
          ${field('acc-password', 'Password', 'password', 'required minlength="8" autocomplete="new-password" placeholder="At least 8 characters"')}
          <div class="account-actions">
            <button type="submit" class="btn-primary">Create account</button>
            <button type="button" class="btn-secondary" data-go="signin">I have an account</button>
          </div>
        </form>`;
    case 'verify':
      // Until the project sends its own emails (see supabase/README.md), Supabase's
      // email has a link instead of a code: it confirms the address in the browser,
      // and the person then signs in here.
      if (!EMAIL_CODES) {
        return `
          <div class="account-form">
            <p class="section-sub">We sent an email to <b>${email}</b>. Click the link in it to confirm your address, then come back and sign in.</p>
            <div class="account-actions">
              <button type="button" class="btn-primary" data-go="signin">I've confirmed, sign in</button>
              <button type="button" class="btn-secondary" data-action="resend">Send the email again</button>
            </div>
          </div>`;
      }
      return `
        <form class="account-form" data-submit="verify">
          <p class="section-sub">We sent a 6-digit code to <b>${email}</b>. Enter it to confirm your email.</p>
          ${field('acc-code', 'Code', 'text', 'required inputmode="numeric" autocomplete="one-time-code" maxlength="10" class="account-code"')}
          <div class="account-actions">
            <button type="submit" class="btn-primary">Confirm</button>
            <button type="button" class="btn-secondary" data-action="resend">Send a new code</button>
            <button type="button" class="btn-secondary" data-go="signin">Back</button>
          </div>
        </form>`;
    case 'reset':
      return `
        <form class="account-form" data-submit="reset">
          <p class="section-sub">We'll email you a code to set a new password.</p>
          ${field('acc-email', 'Email', 'email', `required autocomplete="email" value="${email}"`)}
          <div class="account-actions">
            <button type="submit" class="btn-primary">Send code</button>
            <button type="button" class="btn-secondary" data-go="signin">Back</button>
          </div>
        </form>`;
    case 'reset-verify':
      return `
        <form class="account-form" data-submit="reset-verify">
          <p class="section-sub">Enter the code we sent to <b>${email}</b> and choose a new password.</p>
          ${field('acc-code', 'Code', 'text', 'required inputmode="numeric" autocomplete="one-time-code" maxlength="10" class="account-code"')}
          ${field('acc-password', 'New password', 'password', 'required minlength="8" autocomplete="new-password" placeholder="At least 8 characters"')}
          <div class="account-actions">
            <button type="submit" class="btn-primary">Set password</button>
            <button type="button" class="btn-secondary" data-go="signin">Back</button>
          </div>
        </form>`;
    case 'edit-name':
      return `
        <form class="account-form" data-submit="name">
          ${field('acc-name', 'Name', 'text', `maxlength="40" autocomplete="nickname" value="${escapeHtml(profile?.display_name || '')}"`)}
          <div class="account-actions">
            <button type="submit" class="btn-primary">Save</button>
            <button type="button" class="btn-secondary" data-go="account">Cancel</button>
          </div>
        </form>`;
    case 'account': {
      const name = profile?.display_name || '';
      const initial = (name || user.email || '?').trim().charAt(0).toUpperCase();
      return `
        <div class="account-card">
          <div class="account-avatar" aria-hidden="true">${escapeHtml(initial)}</div>
          <div class="account-who">
            <b>${escapeHtml(name || 'No name yet')}</b>
            <span>${escapeHtml(user.email || '')}</span>
          </div>
        </div>
        <p class="section-sub account-note">Your study data still stays on this computer. Syncing between devices is coming in a later version.</p>
        <div class="account-actions">
          <button type="button" class="btn-outline" data-go="edit-name">Change name</button>
          <button type="button" class="btn-outline" data-action="signout">Sign out</button>
          <button type="button" class="btn-secondary danger-text" data-action="delete">Delete account</button>
        </div>`;
    }
    default:
      return `
        <form class="account-form" data-submit="signin">
          <p class="section-sub">Optional. An account will let you sync between devices and study with friends in later versions.</p>
          ${field('acc-email', 'Email', 'email', `required autocomplete="email" value="${email}"`)}
          ${field('acc-password', 'Password', 'password', 'required autocomplete="current-password"')}
          <div class="account-actions">
            <button type="submit" class="btn-primary">Sign in</button>
            <button type="button" class="btn-secondary" data-go="signup">Create an account</button>
            ${EMAIL_CODES ? '<button type="button" class="btn-secondary" data-go="reset">Forgot password?</button>' : ''}
          </div>
        </form>`;
  }
}

export function renderAccount() {
  const body = document.getElementById('account-body');
  if (!body) return;
  if (!configured) {
    body.innerHTML = '<p class="section-sub">Accounts aren\'t set up in this build of inmo.</p>';
    return;
  }
  if ((view === 'account' || view === 'edit-name') && !user) view = 'signin';
  body.innerHTML = views();
  body.classList.toggle('busy', busy);
  body.querySelector('input:not([type="hidden"])')?.focus();
}

// ---------- Actions ----------

const value = (id) => document.getElementById(id)?.value.trim() ?? '';

function friendly(err) {
  const text = errorText(err);
  if (/invalid login credentials/i.test(text)) return 'Wrong email or password.';
  if (/token has expired|invalid.*otp|otp.*invalid/i.test(text)) return 'That code is wrong or has expired. Ask for a new one.';
  if (/already registered/i.test(text)) return 'There\'s already an account with that email. Sign in instead.';
  if (/failed to fetch|network/i.test(text)) return 'Can\'t reach the server. Check your internet connection.';
  return text;
}

async function run(fn) {
  if (busy) return;
  busy = true;
  document.getElementById('account-body')?.classList.add('busy');
  try {
    const sb = await getClient();
    await fn(sb);
    busy = false;
    renderAccount();
  } catch (err) {
    // Keep the form as it is, so what was typed isn't lost.
    busy = false;
    document.getElementById('account-body')?.classList.remove('busy');
    showToast('Account', { message: friendly(err), type: 'error' });
  }
}

const SUBMIT = {
  signin: () => run(async (sb) => {
    pendingEmail = value('acc-email');
    const { error } = await sb.auth.signInWithPassword({ email: pendingEmail, password: document.getElementById('acc-password').value });
    if (error && /email not confirmed/i.test(error.message)) {
      await sb.auth.resend({ type: 'signup', email: pendingEmail, options: linkOptions });
      view = 'verify';
      showToast('Confirm your email first', { message: EMAIL_CODES ? 'We sent you a new code.' : 'We sent the confirmation email again.', type: 'info' });
      return;
    }
    if (error) throw error;
    showToast('Signed in');
  }),
  signup: () => run(async (sb) => {
    pendingEmail = value('acc-email');
    const { data, error } = await sb.auth.signUp({
      email: pendingEmail,
      password: document.getElementById('acc-password').value,
      options: { ...linkOptions, data: { display_name: value('acc-name').slice(0, 40) } },
    });
    if (error) throw error;
    // With email confirmation on, there's no session until the code is entered.
    if (!data.session) view = 'verify';
    else showToast('Account created');
  }),
  verify: () => run(async (sb) => {
    const { error } = await sb.auth.verifyOtp({ email: pendingEmail, token: value('acc-code'), type: 'signup' });
    if (error) throw error;
    showToast('Email confirmed', { message: 'You\'re signed in.' });
  }),
  reset: () => run(async (sb) => {
    pendingEmail = value('acc-email');
    const { error } = await sb.auth.resetPasswordForEmail(pendingEmail);
    if (error) throw error;
    view = 'reset-verify';
  }),
  'reset-verify': () => run(async (sb) => {
    const password = document.getElementById('acc-password').value;
    const { error } = await sb.auth.verifyOtp({ email: pendingEmail, token: value('acc-code'), type: 'recovery' });
    if (error) throw error;
    const { error: updateError } = await sb.auth.updateUser({ password });
    if (updateError) throw updateError;
    view = 'account';
    showToast('Password changed', { message: 'You\'re signed in.' });
  }),
  name: () => run(async (sb) => {
    const name = value('acc-name').slice(0, 40);
    const { error } = await sb.from('profiles').update({ display_name: name }).eq('id', user.id);
    if (error) throw error;
    profile = { ...profile, display_name: name };
    view = 'account';
  }),
};

const ACTIONS = {
  resend: () => run(async (sb) => {
    const { error } = await sb.auth.resend({ type: 'signup', email: pendingEmail, options: linkOptions });
    if (error) throw error;
    showToast(EMAIL_CODES ? 'New code sent' : 'Email sent again', { type: 'info' });
  }),
  signout: () => run(async (sb) => {
    const { error } = await sb.auth.signOut();
    if (error) throw error;
    user = null;
    profile = null;
    view = 'signin';
    showToast('Signed out', { type: 'info' });
  }),
  delete: async () => {
    const ok = await confirmDialog({
      title: 'Delete your inmo account?',
      message: 'Your account and profile are removed from the server for good. Your study data on this computer is not touched.',
      confirmLabel: 'Delete account',
    });
    if (!ok) return;
    await run(async (sb) => {
      const { error } = await sb.rpc('delete_my_account');
      if (error) throw error;
      await sb.auth.signOut({ scope: 'local' });
      user = null;
      profile = null;
      view = 'signin';
      showToast('Account deleted', { type: 'info' });
    });
  },
};

// One set of listeners on the Account card, for whichever view is showing.
export function wireAccount() {
  const body = document.getElementById('account-body');
  if (!body || body.dataset.wired) return;
  body.dataset.wired = '1';
  body.addEventListener('submit', (event) => {
    event.preventDefault();
    const handler = SUBMIT[event.target.dataset.submit];
    if (handler) handler();
  });
  body.addEventListener('click', (event) => {
    const go = event.target.closest('[data-go]');
    if (go) {
      const email = document.getElementById('acc-email')?.value.trim();
      if (email) pendingEmail = email;
      view = go.dataset.go;
      renderAccount();
      return;
    }
    const action = event.target.closest('[data-action]');
    if (action && ACTIONS[action.dataset.action]) ACTIONS[action.dataset.action]();
  });
}
