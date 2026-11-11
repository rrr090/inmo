// Entry point: loads data, wires each page to data changes, and exposes the
// handlers the HTML's onclick attributes call.
import { renderIcons } from './icons.js';
import { showToast } from './notify.js';
import { state, onDataChanged, reloadData, getActiveCourse } from './state.js';
import { formatDuration } from './format.js';
import { initTimer, toggleTimer, setMode, renderModeTabs, updateInPageWidget } from './timer.js';
import * as subjects from './subjects.js';
import * as tasks from './tasks.js';
import * as analytics from './analytics.js';
import * as history from './history.js';
import * as settings from './settings.js';

async function init() {
  renderIcons();
  try {
    await settings.loadTimerSettings();
    const remembered = await window.api.getSetting('active_course_id');
    if (remembered) state.activeCourseId = remembered;

    onDataChanged(subjects.renderSubjects);
    onDataChanged(tasks.loadTasks);
    onDataChanged(() => analytics.isAnalyticsPageActive() && analytics.renderAnalyticsPage());
    onDataChanged(() => history.isHistoryPageActive() && history.renderHistory());

    await initTimer();
    renderModeTabs();
    await reloadData();
    await showRecoveredSession();
    settings.listenForUpdates();
  } catch (err) {
    console.error('Initialization error:', err);
    showToast('Something went wrong loading inmo', { message: String(err.message || err), type: 'error', duration: 0 });
  }
}

// A session left open by a crash is written to history by the backend at launch.
async function showRecoveredSession() {
  const result = await window.api.takeRecoveryResult();
  if (result && result.recovered) {
    showToast('Recovered an unfinished session', {
      message: `${formatDuration(result.duration)} restored to ${result.courseCode} — ${result.courseTitle}`,
      type: 'info',
      duration: 10000,
    });
    await reloadData();
  }
}

async function switchPage(pageId, element) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach(n => n.classList.remove('active'));
  document.getElementById(pageId)?.classList.add('active');
  (element || document.querySelector(`.nav-link[data-page="${pageId}"]`))?.classList.add('active');

  if (pageId === 'analytics-page') await analytics.renderAnalyticsPage();
  if (pageId === 'history-page') await history.renderHistory();
  if (pageId === 'settings-page') await settings.renderSettingsPage();
  updateInPageWidget();
}

function withActiveCourse(fn) {
  return () => {
    const course = getActiveCourse();
    if (course) fn(course.id);
  };
}

document.addEventListener('click', subjects.closeSubjectMenu);
document.addEventListener('keydown', (event) => {
  const addSubjectOpen = document.getElementById('modal').classList.contains('open');
  if (event.key === 'Escape') {
    subjects.closeSubjectMenu();
    if (addSubjectOpen) subjects.closeModal();
  }
  if (event.key === 'Enter' && addSubjectOpen && event.target.tagName === 'INPUT') subjects.handleAddCourse();
});

Object.assign(window, {
  switchPage,
  switchToTimerPage: () => switchPage('timer-page'),
  toggleTimer,
  setMode,
  // Subjects
  selectCourse: subjects.selectCourse,
  enableCourseEdit: subjects.enableCourseEdit,
  cancelCourseEdit: subjects.cancelCourseEdit,
  saveCourseInfo: subjects.saveCourseInfo,
  handleArchiveCourse: subjects.handleArchiveCourse,
  handleRestoreCourse: subjects.handleRestoreCourse,
  handleDeleteCourse: subjects.handleDeleteCourse,
  handleArchiveActiveCourse: withActiveCourse(subjects.handleArchiveCourse),
  handleDeleteActiveCourse: withActiveCourse(subjects.handleDeleteCourse),
  handleResetActiveCourse: subjects.handleResetActiveCourse,
  toggleArchivedList: subjects.toggleArchivedList,
  toggleSubjectMenu: subjects.toggleSubjectMenu,
  openModal: subjects.openModal,
  closeModal: subjects.closeModal,
  handleAddCourse: subjects.handleAddCourse,
  // Tasks
  handleAddTask: tasks.handleAddTask,
  handleToggleTask: tasks.handleToggleTask,
  handleDeleteTask: tasks.handleDeleteTask,
  // Analytics
  setTrendRange: analytics.setTrendRange,
  setTrendMode: analytics.setTrendMode,
  editCourseGoal: analytics.editCourseGoal,
  cancelGoalEdit: analytics.cancelGoalEdit,
  saveCourseGoal: analytics.saveCourseGoal,
  // History
  openSessionDialog: history.openSessionDialog,
  handleDeleteSession: history.handleDeleteSession,
  showMoreHistory: history.showMoreHistory,
  handleExportCsv: history.handleExportCsv,
  handleImportCsv: history.handleImportCsv,
  // Settings
  saveNumberSetting: settings.saveNumberSetting,
  toggleMiniWidgetSetting: settings.toggleMiniWidgetSetting,
  toggleShortcut: settings.toggleShortcut,
  toggleAutostart: settings.toggleAutostart,
  handleBackupNow: settings.handleBackupNow,
  handleOpenBackups: settings.handleOpenBackups,
  handleRestoreBackup: settings.handleRestoreBackup,
  handleInstallUpdate: settings.handleInstallUpdate,
  handleCheckUpdates: settings.handleCheckUpdates,
  saveToggleSetting: settings.saveToggleSetting,
});

init();
