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
  return autoColors().get(course.id) || SUBJECT_COLORS[0];
}

// Automatic colors, by subject id. Each subject starts from the color for its
// place in the library and moves on to the next one while that color is taken,
// by a color picked for another subject (or one close to it) or by an earlier
// automatic subject. With every color taken, they repeat.
let autoCache = { courses: null, colors: new Map() };

function autoColors() {
  if (autoCache.courses === state.courses) return autoCache.colors;
  const chosen = state.courses.filter(c => c.color).map(c => c.color);
  const taken = new Set(SUBJECT_COLORS.filter(p => chosen.some(c => colorDistance(c, p) < 60)));
  const colors = new Map();
  state.courses.forEach((course, index) => {
    if (course.color) return;
    let pick = null;
    for (let step = 0; step < SUBJECT_COLORS.length; step++) {
      const candidate = SUBJECT_COLORS[(index + step) % SUBJECT_COLORS.length];
      if (!taken.has(candidate)) { pick = candidate; break; }
    }
    pick = pick || SUBJECT_COLORS[index % SUBJECT_COLORS.length];
    taken.add(pick);
    colors.set(course.id, pick);
  });
  autoCache = { courses: state.courses, colors };
  return colors;
}

// What "Automatic" would give a subject added now.
export function nextAutoColor() {
  const taken = new Set([...autoColors().values()]);
  state.courses.filter(c => c.color).forEach(c => SUBJECT_COLORS.forEach(p => {
    if (colorDistance(c.color, p) < 60) taken.add(p);
  }));
  const start = state.courses.length;
  for (let step = 0; step < SUBJECT_COLORS.length; step++) {
    const candidate = SUBJECT_COLORS[(start + step) % SUBJECT_COLORS.length];
    if (!taken.has(candidate)) return candidate;
  }
  return SUBJECT_COLORS[start % SUBJECT_COLORS.length];
}

function rgb(hex) {
  const n = Number.parseInt(String(hex).replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Plain RGB distance: enough to tell "the same blue" from "a different color".
function colorDistance(a, b) {
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  return Math.hypot(r1 - r2, g1 - g2, b1 - b2);
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
