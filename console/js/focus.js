// Spatial navigation: arrows/D-pad move focus to the nearest [data-focus] element in that direction.
// Elements inside a [data-group] remember the last focused child, so moving back into a row
// returns to where you were (like a console home screen).
import { sfx } from './sfx.js';

let current = null;
let scope = document.body;
const memory = new Map(); // group element → last focused element

export function getFocused() {
  return current && current.isConnected ? current : null;
}

export function setScope(el) {
  scope = el;
}

function visible(el) {
  if (!el.isConnected || el.closest('[hidden], .is-hidden')) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

export function focusables(root = scope) {
  return [...root.querySelectorAll('[data-focus]:not([disabled])')].filter(visible);
}

function scrollIntoView(el) {
  for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
    const mode = node.dataset.scroll;
    if (!mode) continue;
    const horizontal = mode.startsWith('x');
    const anchor = mode.endsWith('start') ? 'start' : 'nearest';
    // offsetLeft/Top are unscaled CSS pixels relative to the scroll container (position: relative).
    let offset = 0;
    for (let n = el; n && n !== node; n = n.offsetParent) offset += horizontal ? n.offsetLeft : n.offsetTop;
    const size = horizontal ? el.offsetWidth : el.offsetHeight;
    const view = horizontal ? node.clientWidth : node.clientHeight;
    const pos = horizontal ? node.scrollLeft : node.scrollTop;
    const pad = Number(node.dataset.scrollPad || 80);
    let target = pos;
    if (anchor === 'start') target = offset - pad;
    else if (offset - pad < pos) target = offset - pad;
    else if (offset + size + pad > pos + view) target = offset + size + pad - view;
    node.scrollTo({ [horizontal ? 'left' : 'top']: Math.max(0, target), behavior: 'smooth' });
  }
}

export function focus(el, { silent = false, scroll = true } = {}) {
  if (!el || el === current) return;
  const prev = current;
  if (prev) prev.classList.remove('focused');
  current = el;
  el.classList.add('focused');
  const group = el.closest('[data-group]');
  if (group) memory.set(group, el);
  if (scroll) scrollIntoView(el);
  if (!silent) sfx.move();
  el.dispatchEvent(new CustomEvent('focused', { bubbles: true, detail: { prev } }));
}

/** Focus the first element (or the remembered one) inside `root`. */
export function focusFirst(root = scope, { silent = true } = {}) {
  const preferred = root.querySelector('[data-autofocus]');
  const all = focusables(root);
  // Prefer the screen's content over the top bar chips.
  const target = (preferred && visible(preferred) && preferred) || all.find((el) => !el.closest('.topbar')) || all[0];
  if (target) focus(target, { silent });
  return target;
}

function rect(el) {
  const r = el.getBoundingClientRect();
  return { l: r.left, r: r.right, t: r.top, b: r.bottom, cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2 };
}

export function move(dir) {
  const cur = getFocused();
  if (!cur || !scope.contains(cur)) return focusFirst(scope, { silent: false });
  const a = rect(cur);
  let best = null;
  let bestScore = Infinity;
  for (const el of focusables(scope)) {
    if (el === cur) continue;
    const b = rect(el);
    let primary;
    let secondary;
    if (dir === 'left' || dir === 'right') {
      primary = dir === 'right' ? b.l - a.r : a.l - b.r;
      if ((dir === 'right' ? b.cx - a.cx : a.cx - b.cx) <= 2) continue;
      const overlap = Math.min(a.b, b.b) - Math.max(a.t, b.t);
      secondary = overlap > 0 ? Math.abs(a.cy - b.cy) * 0.15 : -overlap + Math.abs(a.cy - b.cy) * 0.5;
      primary = Math.max(primary, 0) + 1;
      const score = primary + secondary * 3;
      if (score < bestScore) { bestScore = score; best = el; }
    } else {
      primary = dir === 'down' ? b.t - a.b : a.t - b.b;
      if ((dir === 'down' ? b.cy - a.cy : a.cy - b.cy) <= 2) continue;
      const overlap = Math.min(a.r, b.r) - Math.max(a.l, b.l);
      secondary = overlap > 0 ? Math.abs(a.cx - b.cx) * 0.3 : -overlap + Math.abs(a.cx - b.cx) * 0.4;
      primary = Math.max(primary, 0) + 1;
      const score = primary * 1.5 + secondary;
      if (score < bestScore) { bestScore = score; best = el; }
    }
  }
  if (!best) return null;
  // Entering a different group: jump to the element remembered there.
  const fromGroup = cur.closest('[data-group]');
  const toGroup = best.closest('[data-group]');
  if (toGroup && toGroup !== fromGroup) {
    const remembered = memory.get(toGroup);
    if (remembered && remembered.isConnected && visible(remembered) && toGroup.contains(remembered)) best = remembered;
    // Action rows (Play, Share, ...) start at their first button rather than the nearest one.
    else if (toGroup.dataset.enter === 'first') best = focusables(toGroup)[0] || best;
    // Tab strips start at the selected tab.
    else if (toGroup.dataset.enter === 'active') best = toGroup.querySelector('.active[data-focus]') || best;
  }
  focus(best);
  return best;
}

/** Mouse support: hovering focuses, clicking activates through normal click handlers. */
document.addEventListener('mouseover', (e) => {
  const el = e.target.closest('[data-focus]');
  if (el && scope.contains(el) && !el.disabled) focus(el, { silent: true, scroll: false });
});
