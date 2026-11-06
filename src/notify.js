import { icon } from './icons.js';

const TOAST_ICONS = { success: 'circle-check', error: 'triangle-alert', info: 'info' };
const EXIT_ANIMATION_MS = 180;

function getToastContainer() {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.setAttribute('role', 'status');
    container.setAttribute('aria-live', 'polite');
    document.body.appendChild(container);
  }
  return container;
}

// Text goes in through textContent because it can include subject names.
export function showToast(title, { message = '', type = 'success', duration } = {}) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${icon(TOAST_ICONS[type], 18)}</span>
    <div class="toast-body">
      <div class="toast-title"></div>
      <div class="toast-message"></div>
    </div>
    <button class="icon-btn" aria-label="Dismiss" title="Dismiss">${icon('x', 14)}</button>
  `;
  toast.querySelector('.toast-title').textContent = title;
  toast.querySelector('.toast-message').textContent = message;

  let timer = null;
  const dismiss = () => {
    clearTimeout(timer);
    toast.classList.add('leaving');
    setTimeout(() => toast.remove(), EXIT_ANIMATION_MS);
  };
  toast.querySelector('button').onclick = dismiss;
  timer = setTimeout(dismiss, duration ?? (type === 'error' ? 7000 : 4000));

  getToastContainer().appendChild(toast);
}

// Resolves to true if confirmed. Cancel has focus, so pressing Enter by accident is safe.
export function confirmDialog({ title, message, confirmLabel }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open';
    overlay.innerHTML = `
      <div class="modal" role="alertdialog" aria-modal="true">
        <h2></h2>
        <p class="modal-text"></p>
        <div class="modal-actions">
          <button class="btn-secondary" data-action="cancel">Cancel</button>
          <button class="btn-danger" data-action="confirm"></button>
        </div>
      </div>
    `;
    overlay.querySelector('h2').textContent = title;
    overlay.querySelector('.modal-text').textContent = message;
    overlay.querySelector('[data-action="confirm"]').textContent = confirmLabel;

    const finish = (result) => {
      document.removeEventListener('keydown', onKeydown, true);
      overlay.remove();
      resolve(result);
    };
    const onKeydown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        finish(false);
      }
    };

    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) finish(false);
      const action = event.target.dataset.action;
      if (action) finish(action === 'confirm');
    });
    document.addEventListener('keydown', onKeydown, true);

    document.body.appendChild(overlay);
    overlay.querySelector('[data-action="cancel"]').focus();
  });
}

// A toast can't be seen while the app is minimized or behind other windows.
export function desktopNotify(title, body) {
  if (!document.hasFocus()) new Notification(title, { body });
}
