// The Settings page, and the update prompt.
import { showToast, confirmDialog } from './notify.js';
import { state } from './state.js';
import { escapeHtml, errorText } from './format.js';
import { renderModeTabs } from './timer.js';

// Number settings: key, default, min, max. Must match the clamps in timer.rs.
const NUMBER_SETTINGS = {
  pomodoro_focus_min: [25, 1, 180],
  pomodoro_short_break_min: [5, 0, 120],
  pomodoro_long_break_min: [15, 0, 120],
  pomodoro_long_break_every: [4, 1, 12],
  idle_threshold_min: [10, 0, 240],
};

async function readNumber(key) {
  const [def, min, max] = NUMBER_SETTINGS[key];
  const n = Number.parseInt(await window.api.getSetting(key), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

// Called once at startup, so the Pomodoro tab shows the right length right away.
export async function loadTimerSettings() {
  state.focusMin = await readNumber('pomodoro_focus_min');
  const mode = await window.api.getSetting('timer_mode');
  state.timerMode = mode === 'pomodoro' ? 'pomodoro' : 'stopwatch';
}

export async function renderSettingsPage() {
  for (const key of Object.keys(NUMBER_SETTINGS)) {
    const input = document.getElementById(`setting-${key}`);
    if (input) input.value = await readNumber(key);
  }
  document.getElementById('mini-widget-toggle').checked = (await window.api.getSetting('mini_widget_on_minimize')) === 'true';

  const shortcut = await window.api.getShortcut();
  document.getElementById('shortcut-label').innerText = shortcut.label;
  document.getElementById('shortcut-toggle').checked = shortcut.enabled;

  try {
    document.getElementById('autostart-toggle').checked = await window.api.getAutostart();
  } catch (err) {
    console.error('Could not read autostart:', err);
  }

  await renderBackupInfo();
  await renderUpdateInfo();
}

export async function saveNumberSetting(key, input) {
  const [, min, max] = NUMBER_SETTINGS[key];
  const n = Number(input.value);
  if (!Number.isInteger(n) || n < min || n > max) {
    showToast(`Enter a whole number from ${min} to ${max}`, { type: 'error' });
    input.value = await readNumber(key);
    return;
  }
  await window.api.setSetting(key, String(n));
  if (key === 'pomodoro_focus_min') {
    state.focusMin = n;
    renderModeTabs();
  }
}

export async function toggleMiniWidgetSetting(checked) {
  await window.api.setSetting('mini_widget_on_minimize', checked ? 'true' : 'false');
}

export async function toggleShortcut(input) {
  try {
    const result = await window.api.setShortcutEnabled(input.checked);
    input.checked = result.enabled;
  } catch (err) {
    input.checked = false;
    showToast('Shortcut unavailable', { message: errorText(err), type: 'error', duration: 9000 });
  }
}

export async function toggleAutostart(input) {
  try {
    input.checked = await window.api.setAutostart(input.checked);
  } catch (err) {
    input.checked = !input.checked;
    showToast('Could not change startup setting', { message: errorText(err), type: 'error' });
  }
}

// ---------- Backups ----------

async function renderBackupInfo() {
  const el = document.getElementById('backup-info');
  if (!el) return;
  const info = await window.api.getBackupInfo();
  el.innerHTML = `
    ${info.latest ? `Last automatic backup: <b>${escapeHtml(info.latest)}</b>.` : 'No automatic backup yet.'}
    inmo saves one a week and keeps the newest ${info.kept}.<br>
    <span class="settings-path">${escapeHtml(info.folder)}</span>`;
}

export async function handleBackupNow() {
  try {
    await window.api.backupNow();
    await renderBackupInfo();
    showToast('Backup saved');
  } catch (err) {
    showToast('Could not back up', { message: errorText(err), type: 'error' });
  }
}

export function handleOpenBackups() {
  window.api.openBackupsFolder().catch(err => showToast('Could not open the folder', { message: errorText(err), type: 'error' }));
}

export async function handleRestoreBackup() {
  const confirmed = await confirmDialog({
    title: 'Restore from a backup?',
    message: 'Everything in inmo will be replaced with the backup you pick. Your current data is saved to the backups folder first, so this can be undone by restoring that file.',
    confirmLabel: 'Choose backup…',
    danger: false,
  });
  if (!confirmed) return;
  try {
    const r = await window.api.restoreBackup();
    if (!r || r.canceled) return;
    // Everything on the page came from the old data.
    window.location.reload();
  } catch (err) {
    showToast('Could not restore', { message: errorText(err), type: 'error', duration: 9000 });
  }
}

// ---------- Updates ----------

async function renderUpdateInfo() {
  const el = document.getElementById('update-info');
  if (!el) return;
  const version = await window.__TAURI__.app.getVersion();
  const pending = await window.api.getUpdateStatus();
  el.innerHTML = pending
    ? `You have ${escapeHtml(version)}. Version <b>${escapeHtml(pending.version)}</b> is downloaded and installs when you close inmo.
       <div><button class="btn-primary" onclick="window.handleInstallUpdate()">Restart and update now</button></div>`
    : `You have ${escapeHtml(version)}. New versions download in the background and install when you close inmo.`;
}

export function listenForUpdates() {
  const announce = (info) => {
    showToast(`inmo ${info.version} is ready`, {
      message: 'It installs when you close inmo, or restart now.',
      type: 'info',
      duration: 0,
      action: { label: 'Restart now', onClick: handleInstallUpdate },
    });
    renderUpdateInfo();
  };
  window.api.onUpdateReady(announce);
  // Downloaded before this page loaded (e.g. after a reload).
  window.api.getUpdateStatus().then(p => { if (p) announce(p); }).catch(() => {});
}

export async function handleInstallUpdate() {
  if (state.timer.isStudying) {
    const ok = await confirmDialog({
      title: 'Restart to update?',
      message: 'The running session will be saved first.',
      confirmLabel: 'Save and restart',
      danger: false,
    });
    if (!ok) return;
  }
  try {
    await window.api.installUpdateNow();
  } catch (err) {
    showToast('Update failed', { message: errorText(err), type: 'error' });
  }
}
