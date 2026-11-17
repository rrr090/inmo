// A date picker in the app's own language and look, in place of the native one,
// whose empty field shows the Windows language's placeholder ("дд.мм.гггг").
//
// Every <input type="date"> on the page, including ones in dialogs added later,
// is turned into a hidden input plus a button that opens a small calendar. The
// input keeps the value (YYYY-MM-DD, or "" for none) and its min/max, and fires
// "input" and "change" when a day is picked, so the code reading it is unchanged.
(function () {
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
  const valueProp = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');

  const pad = (n) => String(n).padStart(2, '0');
  const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = (key) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || '');
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  };
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const addMonths = (d, n) => {
    const target = new Date(d.getFullYear(), d.getMonth() + n, 1);
    const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    return new Date(target.getFullYear(), target.getMonth(), Math.min(d.getDate(), last));
  };

  function label(key) {
    const d = parse(key);
    if (!d) return '';
    const opts = { weekday: 'short', month: 'short', day: 'numeric' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString('en-US', opts);
  }

  const CAL_ICON = '<svg class="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/></svg>';
  const X_ICON = '<svg class="icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
  const PREV_ICON = '<svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>';
  const NEXT_ICON = '<svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';

  function enhance(input) {
    if (input.dataset.datepicker) return;
    input.dataset.datepicker = 'on';
    const initial = input.value;
    input.type = 'hidden';
    valueProp.set.call(input, initial);

    const wrap = document.createElement('span');
    wrap.className = 'date-field';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'date-field-btn';
    button.setAttribute('aria-haspopup', 'dialog');
    const ariaLabel = input.getAttribute('aria-label') || (input.id && document.querySelector(`label[for="${input.id}"]`)?.textContent) || 'Date';
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'date-field-clear';
    clear.title = 'Clear the date';
    clear.setAttribute('aria-label', 'Clear the date');
    clear.innerHTML = X_ICON;
    input.after(wrap);
    wrap.append(button);
    // A date that has to be filled in can be changed but not cleared.
    if (!input.required) wrap.append(clear);

    // A <label for> pointing at the input now opens the picker.
    if (input.id) {
      document.querySelectorAll(`label[for="${input.id}"]`).forEach(l => l.addEventListener('click', (e) => { e.preventDefault(); button.focus(); }));
    }

    const refresh = () => {
      const value = valueProp.get.call(input);
      const text = label(value);
      button.innerHTML = `${CAL_ICON}<span class="${text ? '' : 'date-field-placeholder'}">${text || input.dataset.placeholder || 'Pick a date'}</span>`;
      button.setAttribute('aria-label', `${ariaLabel.trim()}: ${text || 'none'}`);
      wrap.classList.toggle('has-value', Boolean(text));
    };
    // Code that sets input.value (clearing it after adding a task, say) updates the button.
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => valueProp.get.call(input),
      set: (v) => { valueProp.set.call(input, v ?? ''); refresh(); },
    });
    // Code that focuses the date field focuses the button instead.
    input.focus = () => button.focus();
    refresh();

    const set = (key) => {
      input.value = key;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    button.addEventListener('click', () => (openFor === input ? close() : open(input, button, set)));
    clear.addEventListener('click', () => { set(''); button.focus(); });
  }

  // ---------- The calendar ----------

  let pop = null;
  let openFor = null;
  let view = null;   // first of the month shown
  let focused = null; // the day keyboard focus is on

  function inRange(input, d) {
    const key = keyOf(d);
    const min = input.getAttribute('min');
    const max = input.getAttribute('max');
    return (!min || key >= min) && (!max || key <= max);
  }

  function open(input, button, set) {
    close();
    openFor = input;
    const current = parse(input.value);
    focused = current || new Date(new Date().setHours(0, 0, 0, 0));
    if (!inRange(input, focused)) {
      const min = parse(input.getAttribute('min'));
      const max = parse(input.getAttribute('max'));
      focused = min && keyOf(focused) < keyOf(min) ? min : max || focused;
    }
    pop = document.createElement('div');
    pop.className = 'datepicker';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Choose a date');
    document.body.appendChild(pop);
    pop._button = button;
    pop._set = set;
    render(true);
    place(button);
    button.setAttribute('aria-expanded', 'true');
  }

  function close(refocus) {
    if (!pop) return;
    const button = pop._button;
    pop.remove();
    pop = null;
    openFor = null;
    button.setAttribute('aria-expanded', 'false');
    if (refocus && button.isConnected) button.focus();
  }

  function place(button) {
    const box = button.getBoundingClientRect();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    let top = box.bottom + 6;
    if (top + h > window.innerHeight - 8 && box.top - h - 6 > 8) top = box.top - h - 6;
    const left = Math.max(8, Math.min(box.left, window.innerWidth - w - 8));
    pop.style.top = `${Math.max(8, top)}px`;
    pop.style.left = `${left}px`;
  }

  function render(focusDay) {
    const input = openFor;
    view = new Date(focused.getFullYear(), focused.getMonth(), 1);
    const selected = input.value;
    const today = keyOf(new Date());
    const start = addDays(view, -((view.getDay() + 6) % 7));
    let cells = '';
    for (let i = 0; i < 42; i++) {
      const d = addDays(start, i);
      const key = keyOf(d);
      const classes = ['datepicker-day'];
      if (d.getMonth() !== view.getMonth()) classes.push('outside');
      if (key === today) classes.push('today');
      if (key === selected) classes.push('selected');
      const enabled = inRange(input, d);
      const isFocus = key === keyOf(focused);
      cells += `<button type="button" class="${classes.join(' ')}" data-day="${key}" tabindex="${isFocus ? 0 : -1}" ${enabled ? '' : 'disabled'}
        aria-label="${d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}" ${key === selected ? 'aria-pressed="true"' : ''}>${d.getDate()}</button>`;
    }
    const todayOk = inRange(input, new Date());
    pop.innerHTML = `
      <div class="datepicker-head">
        <button type="button" class="icon-btn" data-nav="-1" aria-label="Previous month">${PREV_ICON}</button>
        <span class="datepicker-title" aria-live="polite">${MONTHS[view.getMonth()]} ${view.getFullYear()}</span>
        <button type="button" class="icon-btn" data-nav="1" aria-label="Next month">${NEXT_ICON}</button>
      </div>
      <div class="datepicker-grid">
        ${WEEKDAYS.map(w => `<span class="datepicker-weekday">${w}</span>`).join('')}
        ${cells}
      </div>
      <div class="datepicker-foot">
        <button type="button" class="btn-secondary" data-act="today" ${todayOk ? '' : 'disabled'}>Today</button>
        ${selected && !input.required ? '<button type="button" class="btn-secondary" data-act="clear">Clear</button>' : ''}
      </div>`;
    if (focusDay) pop.querySelector(`[data-day="${keyOf(focused)}"]`)?.focus();
  }

  function pick(key) {
    const set = pop._set;
    close(true);
    set(key);
  }

  function move(d) {
    if (!inRange(openFor, d)) return;
    focused = d;
    render(true);
  }

  document.addEventListener('click', (e) => {
    if (!pop || !pop.contains(e.target)) return;
    const day = e.target.closest('[data-day]');
    const nav = e.target.closest('[data-nav]');
    const act = e.target.closest('[data-act]');
    if (day && !day.disabled) pick(day.dataset.day);
    else if (nav) { focused = addMonths(focused, Number(nav.dataset.nav)); render(false); }
    else if (act?.dataset.act === 'today') pick(keyOf(new Date()));
    else if (act?.dataset.act === 'clear') pick('');
  });

  // Outside the picker and its button: close it.
  document.addEventListener('pointerdown', (e) => {
    if (pop && !pop.contains(e.target) && !pop._button.contains(e.target)) close();
  }, true);

  // On the window, in the capture phase, so the picker gets its keys before a
  // dialog (Escape closes the dialog) or the page shortcuts (Space, letters) do.
  window.addEventListener('keydown', (e) => {
    if (!pop) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    if (!pop.contains(document.activeElement)) return;
    const onDay = document.activeElement.matches('[data-day]');
    const steps = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    let handled = true;
    if (onDay && e.key in steps) move(addDays(focused, steps[e.key]));
    else if (onDay && e.key === 'Home') move(addDays(focused, -((focused.getDay() + 6) % 7)));
    else if (onDay && e.key === 'End') move(addDays(focused, 6 - ((focused.getDay() + 6) % 7)));
    else if (e.key === 'PageUp') { focused = addMonths(focused, -1); render(true); }
    else if (e.key === 'PageDown') { focused = addMonths(focused, 1); render(true); }
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      document.activeElement.click();
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  const reposition = () => { if (pop) place(pop._button); };
  window.addEventListener('resize', reposition);
  document.addEventListener('scroll', reposition, true);

  function enhanceAll(root) {
    if (root.matches?.('input[type="date"]')) enhance(root);
    root.querySelectorAll?.('input[type="date"]').forEach(enhance);
  }
  function start() {
    enhanceAll(document.body);
    new MutationObserver((records) => {
      for (const r of records) r.addedNodes.forEach(n => n.nodeType === 1 && enhanceAll(n));
      // The button's dialog was closed: the picker goes with it.
      if (pop && !pop._button.isConnected) close();
    }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
