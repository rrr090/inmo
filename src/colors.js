// Subject colors and terms, shared by the library, the timer, history and
// every chart, so a subject looks the same everywhere.
import { state } from './state.js';

// Validated for colorblind separation on the dark card surface. A subject
// without a color of its own gets one of these by its place in the library.
export const SUBJECT_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
export const COLOR_NAMES = ['Blue', 'Orange', 'Teal', 'Amber', 'Pink', 'Green', 'Violet', 'Red'];
export const OTHER_COLOR = '#6b7280';

export function courseColor(course) {
  if (!course) return OTHER_COLOR;
  if (course.color) return course.color;
  const index = state.courses.findIndex(c => c.id === course.id);
  return SUBJECT_COLORS[(index < 0 ? 0 : index) % SUBJECT_COLORS.length];
}

export function swatch(course, extraClass = '') {
  return `<span class="swatch ${extraClass}" style="background: ${courseColor(course)};" aria-hidden="true"></span>`;
}

// Every term in use, the newest first: a term is as new as the most recently
// added subject in it.
export function allTerms(courses = state.courses) {
  const newest = new Map();
  courses.forEach((c, i) => {
    if (c.term) newest.set(c.term, i);
  });
  return [...newest.entries()].sort((a, b) => b[1] - a[1]).map(([term]) => term);
}
