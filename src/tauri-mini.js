// window.miniApi for the floating timer (mini-widget.html).
(function () {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  window.miniApi = {
    onTimerState: (callback) => listen('timer-state', (event) => callback(event.payload)),
    restoreMainWindow: () => invoke('restore_main_window'),
    stopTimer: () => invoke('stop_timer_from_widget')
  };

  // WebView2 ignores -webkit-app-region, so drag the frameless widget by hand.
  // Moving a few pixels starts a native drag; a plain click still restores the app.
  let downAt = null;
  window.addEventListener('mousedown', (e) => {
    if (e.button === 0 && !e.target.closest('button')) downAt = { x: e.screenX, y: e.screenY };
  });
  window.addEventListener('mousemove', (e) => {
    if (!downAt) return;
    if (Math.abs(e.screenX - downAt.x) + Math.abs(e.screenY - downAt.y) > 3) {
      downAt = null;
      window.__TAURI__.window.getCurrentWindow().startDragging();
    }
  });
  window.addEventListener('mouseup', () => { downAt = null; });

  const stopBtn = document.getElementById('stop-btn');
  window.miniApi.onTimerState((data) => {
    document.getElementById('time').innerText = (data && data.timeStr) || '00:00:00';
    document.getElementById('course').innerText = (data && data.courseLabel) || 'No active subject';
    stopBtn.innerText = data && data.phase === 'break' ? 'SKIP' : 'STOP';
  });
  document.getElementById('widget').addEventListener('click', (e) => {
    if (e.target !== stopBtn) window.miniApi.restoreMainWindow();
  });
  stopBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    window.miniApi.stopTimer();
  });
})();
