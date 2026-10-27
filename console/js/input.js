// Keyboard + Gamepad API → semantic actions (up/down/left/right/a/b/x/y/lb/rb/start/select).
import { emit } from './store.js';

const KEYMAP = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  Enter: 'a', ' ': 'a', Escape: 'b', Backspace: 'b',
  x: 'x', X: 'x', y: 'y', Y: 'y', q: 'lb', Q: 'lb', e: 'rb', E: 'rb', m: 'start', M: 'start', v: 'select', V: 'select',
};
// Standard gamepad mapping indices.
const BUTTONS = { 0: 'a', 1: 'b', 2: 'x', 3: 'y', 4: 'lb', 5: 'rb', 8: 'select', 9: 'start', 12: 'up', 13: 'down', 14: 'left', 15: 'right', 16: 'start' };
const DIRS = new Set(['up', 'down', 'left', 'right']);
const REPEAT_DELAY = 380;
const REPEAT_RATE = 110;

export let lastSource = 'keyboard';
let handler = () => {};
let lastKeyTime = 0;

export function onAction(fn) {
  handler = fn;
}

function fire(action, source) {
  lastSource = source;
  handler(action);
}

function isTyping() {
  const el = document.activeElement;
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
}

window.addEventListener('keydown', (e) => {
  if (isTyping()) {
    // While typing, only a few keys drive the console.
    if (e.key === 'Escape' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      document.activeElement.blur();
      fire(KEYMAP[e.key], 'keyboard');
    } else if (e.key === 'Enter') {
      e.preventDefault();
      document.activeElement.dispatchEvent(new CustomEvent('submit-input', { bubbles: true }));
    }
    return;
  }
  const action = KEYMAP[e.key];
  if (!action) return;
  e.preventDefault();
  const now = performance.now();
  if (e.repeat && now - lastKeyTime < 90) return;
  lastKeyTime = now;
  fire(action, 'keyboard');
});

// ---------- gamepad polling ----------
const held = new Map(); // action → { since, last }

// While a native game (RetroArch, VLC) has the screen, Chromium loses focus and must ignore the pad.
// Buttons still held when focus comes back (e.g. Start+Select used to quit) are swallowed too.
let quietUntil = 0;
window.addEventListener('focus', () => { quietUntil = performance.now() + 600; });

function pollGamepads() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const pressed = new Set();
  for (const pad of pads) {
    if (!pad) continue;
    pad.buttons.forEach((b, i) => {
      if (b.pressed && BUTTONS[i]) pressed.add(BUTTONS[i]);
    });
    const [ax = 0, ay = 0] = pad.axes;
    if (ax < -0.55) pressed.add('left');
    if (ax > 0.55) pressed.add('right');
    if (ay < -0.55) pressed.add('up');
    if (ay > 0.55) pressed.add('down');
  }
  const now = performance.now();
  const quiet = !document.hasFocus() || now < quietUntil;
  // Start + Select together: leave a game running in the browser.
  if (pressed.has('start') && pressed.has('select')) pressed.add('quit');
  for (const action of pressed) {
    const state = held.get(action);
    if (!state) {
      held.set(action, { since: now, last: now });
      if (!quiet) fire(action, 'gamepad');
    } else if (!quiet && DIRS.has(action) && now - state.since > REPEAT_DELAY && now - state.last > REPEAT_RATE) {
      state.last = now;
      fire(action, 'gamepad');
    }
  }
  for (const action of [...held.keys()]) {
    if (!pressed.has(action)) held.delete(action);
  }
  requestAnimationFrame(pollGamepads);
}

window.addEventListener('gamepadconnected', (e) => emit('gamepad', { connected: true, id: e.gamepad.id }));
window.addEventListener('gamepaddisconnected', (e) => emit('gamepad', { connected: false, id: e.gamepad.id }));
requestAnimationFrame(pollGamepads);
