// Screen stack with animated transitions and per-screen color themes.
import { focusFirst, setScope } from './focus.js';
import { sfx } from './sfx.js';

const screens = new Map();
const history = [];
let active = null;
let busy = false;

export function register(name, mod) {
  screens.set(name, mod);
}

export function current() {
  return active;
}

export function setTheme(h1, h2 = h1 + 70) {
  const stage = document.getElementById('stage');
  stage.style.setProperty('--h1', h1);
  stage.style.setProperty('--h2', h2);
  // The background has its own animated copies so only it repaints during the color fade.
  const bg = document.getElementById('bg');
  bg.style.setProperty('--bh1', h1);
  bg.style.setProperty('--bh2', h2);
}

export async function go(name, params = {}, { replace = false } = {}) {
  const mod = screens.get(name);
  if (!mod || busy) return;
  busy = true;
  const host = document.getElementById('screen-host');
  const prev = active;
  if (prev && !replace) history.push({ name: prev.name, params: prev.params });

  const el = document.createElement('section');
  el.className = `screen screen-${name} enter`;
  document.body.dataset.screen = name;
  host.appendChild(el);
  setScope(el);
  if (mod.hue) setTheme(...mod.hue);

  if (prev) {
    prev.ctrl?.unmount?.();
    prev.el.classList.add('leave');
    setTimeout(() => prev.el.remove(), 320);
  }
  active = { name, params, el, ctrl: null };
  try {
    active.ctrl = (await mod.mount(el, params)) || {};
  } finally {
    busy = false;
  }
  if (!el.querySelector('.focused')) focusFirst(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('enter')));
}

export function back() {
  if (active?.ctrl?.onBack?.()) return true;
  const prev = history.pop();
  if (!prev) return false;
  sfx.back();
  go(prev.name, prev.params, { replace: true });
  return true;
}

export function resetHistory() {
  history.length = 0;
}
