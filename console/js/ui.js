// Shared UI: overlays, toasts, trophy popups, level-up celebration, on-screen keyboard.
import { icon, glyph } from './icons.js';
import { sfx } from './sfx.js';
import { focus, focusFirst, getFocused, setScope } from './focus.js';
import { store, setProfile, refreshProfile } from './store.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function html(strings, ...values) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String.raw({ raw: strings }, ...values).trim();
  return tpl.content.firstElementChild;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function fmtBytes(n) {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

export function fmtUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

export function timeAgo(ts) {
  if (!ts) return '';
  const then = new Date(ts.replace(' ', 'T'));
  const s = (Date.now() - then.getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

export function hints(list) {
  return `<div class="hints">${list.map(([b, label]) => `<span class="hint">${glyph(b)}${esc(label)}</span>`).join('')}</div>`;
}

// ---------- overlays ----------
const stack = [];
const host = () => document.getElementById('overlay-host');

export function topOverlay() {
  return stack[stack.length - 1] || null;
}

/**
 * Open a modal layer. `render(el)` fills it; `onButton(action)` may return true to consume input.
 * Focus is trapped inside until it closes, then restored.
 */
export function openOverlay({ className = '', render, onButton, onClose, sound = true } = {}) {
  const el = html`<div class="overlay ${className}"><div class="overlay-scrim"></div><div class="overlay-body"></div></div>`;
  const body = el.querySelector('.overlay-body');
  const layer = { el, body, onButton, onClose, restore: getFocused() };
  stack.push(layer);
  host().appendChild(el);
  render?.(body, layer);
  setScope(body);
  focusFirst(body);
  requestAnimationFrame(() => el.classList.add('open'));
  if (sound) sfx.open();
  el.querySelector('.overlay-scrim').addEventListener('click', () => closeOverlay(layer));
  return layer;
}

export function closeOverlay(layer = topOverlay(), { silent = false } = {}) {
  if (!layer) return;
  const i = stack.indexOf(layer);
  if (i >= 0) stack.splice(i, 1);
  layer.el.classList.remove('open');
  layer.el.classList.add('closing');
  setTimeout(() => layer.el.remove(), 260);
  if (!silent) sfx.back();
  const below = topOverlay();
  setScope(below ? below.body : document.getElementById('screen-host'));
  if (layer.restore?.isConnected) focus(layer.restore, { silent: true });
  else focusFirst(below ? below.body : document.getElementById('screen-host'));
  layer.onClose?.();
}

// ---------- toasts ----------
export function toast({ icon: ic = 'sparkles', title, text = '', tone = 'info', xp = null, duration = 3600 }) {
  const t = html`<div class="toast toast-${tone}">
    <div class="toast-icon">${icon(ic, 26)}</div>
    <div class="toast-body"><div class="toast-title">${esc(title)}</div>${text ? `<div class="toast-text">${esc(text)}</div>` : ''}</div>
    ${xp ? `<div class="xp-pill">+${xp} XP</div>` : ''}
  </div>`;
  const hostEl = document.getElementById('toast-host');
  hostEl.prepend(t);
  while (hostEl.children.length > 4) hostEl.lastElementChild.remove();
  requestAnimationFrame(() => t.classList.add('in'));
  const hide = () => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 400);
  };
  const timer = setTimeout(hide, duration);
  // Long-running toasts (uploads) update their text and close themselves when done.
  return {
    update: ({ text: next }) => { const line = t.querySelector('.toast-text'); if (line) line.textContent = next; },
    close: () => { clearTimeout(timer); hide(); },
  };
}

const TIER_LABEL = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold', platinum: 'Platinum' };

export function medal(tier, ic = 'trophy', size = 64) {
  return `<div class="medal medal-${tier}" style="--s:${size}px">${icon(ic, size * 0.46, 2)}</div>`;
}

async function trophyPopup(trophy) {
  const el = html`<div class="trophy-pop tier-${trophy.tier}">
    ${medal(trophy.tier, trophy.icon, 92)}
    <div class="trophy-pop-body">
      <div class="kicker">${TIER_LABEL[trophy.tier]} trophy unlocked</div>
      <div class="trophy-pop-name">${esc(trophy.name)}</div>
      <div class="trophy-pop-desc">${esc(trophy.description)}</div>
    </div>
    <div class="xp-pill">+${trophy.xp} XP</div>
    <div class="shine"></div>
  </div>`;
  document.getElementById('trophy-host').appendChild(el);
  sfx.trophy(trophy.tier);
  requestAnimationFrame(() => el.classList.add('in'));
  await sleep(3800);
  el.classList.add('out');
  setTimeout(() => el.remove(), 500);
  await sleep(350);
}

async function levelUp(profile) {
  const confetti = Array.from({ length: 46 }, (_, i) => {
    const hue = Math.floor(Math.random() * 360);
    return `<i style="--x:${Math.random() * 100}%;--d:${(Math.random() * 1.2).toFixed(2)}s;--r:${Math.floor(Math.random() * 720 - 360)}deg;--h:${hue};--w:${6 + (i % 4) * 3}px"></i>`;
  }).join('');
  const el = html`<div class="levelup">
    <div class="levelup-rays"></div>
    <div class="levelup-core">
      <div class="kicker">Level up</div>
      <div class="levelup-num">${profile.level}</div>
      <div class="levelup-title">${esc(profile.title)}</div>
      ${profile.next_title ? `<div class="levelup-next">Next title at level ${profile.next_title.level}: ${esc(profile.next_title.title)}</div>` : ''}
    </div>
    <div class="confetti">${confetti}</div>
  </div>`;
  document.getElementById('trophy-host').appendChild(el);
  sfx.levelup();
  requestAnimationFrame(() => el.classList.add('in'));
  await sleep(3200);
  el.classList.add('out');
  setTimeout(() => el.remove(), 600);
  await sleep(400);
}

const KIND_ICON = { watch: 'film', listen: 'music', play: 'gamepad', home: 'home', ai: 'sparkles', share: 'share', score: 'zap', login: 'power' };
let queue = Promise.resolve();

/** Turn a hub event (XP, quests, trophies, level) into toasts and popups, one after another. */
export function celebrate(event, label = '') {
  if (!event) return queue;
  setProfile(event.profile);
  queue = queue.then(async () => {
    if (event.xp > 0) {
      sfx.xp();
      toast({ icon: KIND_ICON[event.kind] || 'star', title: label || 'Nice!', text: `${event.profile.title} · Level ${event.profile.level}`, tone: 'xp', xp: event.xp });
    } else if (event.note && label) {
      toast({ icon: KIND_ICON[event.kind] || 'star', title: label, text: `No XP · ${event.note}`, tone: 'muted', duration: 2600 });
    }
    for (const q of event.quests_completed || []) {
      await sleep(500);
      sfx.quest();
      toast({ icon: 'target', title: `Quest complete · ${q.title}`, text: 'Daily quest reward', tone: 'quest', xp: q.xp, duration: 4200 });
    }
    for (const t of event.trophies_unlocked || []) {
      await sleep(400);
      await trophyPopup(t);
    }
    if (event.leveled_up) await levelUp(event.profile);
  });
  refreshProfile().catch(() => {});
  return queue;
}

// ---------- on-screen keyboard ----------
const OSK_ROWS = [
  '1234567890'.split(''),
  'qwertyuiop'.split(''),
  'asdfghjkl?'.split(''),
  'zxcvbnm,.!'.split(''),
  ['ă', 'â', 'î', 'ș', 'ț', "'", '-', ':'],
];

/** Gamepad-friendly text entry. Resolves with the text, or null when cancelled. */
export function keyboardPrompt({ title = 'Type a message', value = '', placeholder = '' } = {}) {
  return new Promise((resolve) => {
    let text = value;
    let shift = false;
    let done = false;
    const finish = (result, layer) => {
      if (done) return;
      done = true;
      resolve(result);
      closeOverlay(layer, { silent: result !== null });
      if (result !== null) sfx.select();
    };
    openOverlay({
      className: 'osk-overlay',
      render(body, layer) {
        body.innerHTML = `
          <div class="osk panel">
            <div class="osk-title">${icon('keyboard', 26)} ${esc(title)}</div>
            <div class="osk-field"><span class="osk-text"></span><span class="caret"></span></div>
            <div class="osk-keys" data-group="keys">
              ${OSK_ROWS.map((row) => `<div class="osk-row">${row.map((k) => `<button class="key" data-focus data-key="${esc(k)}">${esc(k)}</button>`).join('')}</div>`).join('')}
              <div class="osk-row">
                <button class="key wide" data-focus data-cmd="shift">Shift</button>
                <button class="key space" data-focus data-cmd="space">Space</button>
                <button class="key wide" data-focus data-cmd="del">${icon('back', 22)}</button>
                <button class="key wide primary" data-focus data-cmd="done">Done</button>
              </div>
            </div>
            ${hints([['a', 'Type'], ['x', 'Delete'], ['y', 'Space'], ['start', 'Done'], ['b', 'Cancel']])}
          </div>`;
        const field = body.querySelector('.osk-text');
        const paint = () => {
          field.textContent = text || placeholder;
          field.classList.toggle('placeholder', !text);
          body.querySelectorAll('[data-key]').forEach((k) => {
            k.textContent = shift ? k.dataset.key.toUpperCase() : k.dataset.key;
          });
          body.querySelector('[data-cmd="shift"]').classList.toggle('on', shift);
        };
        body.addEventListener('click', (e) => {
          const key = e.target.closest('.key');
          if (!key) return;
          if (key.dataset.key) {
            text += shift ? key.dataset.key.toUpperCase() : key.dataset.key;
            shift = false;
            sfx.move();
          } else if (key.dataset.cmd === 'space') text += ' ';
          else if (key.dataset.cmd === 'del') text = text.slice(0, -1);
          else if (key.dataset.cmd === 'shift') shift = !shift;
          else if (key.dataset.cmd === 'done') return finish(text.trim() || null, layer);
          paint();
        });
        layer.onButton = (action) => {
          if (action === 'x') { text = text.slice(0, -1); paint(); sfx.back(); return true; }
          if (action === 'y') { text += ' '; paint(); return true; }
          if (action === 'start') { finish(text.trim() || null, layer); return true; }
          if (action === 'b') { finish(null, layer); return true; }
          return false;
        };
        layer.onClose = () => { if (!done) { done = true; resolve(null); } };
        paint();
      },
    });
  });
}

export function profileName(pid) {
  return store.profiles.find((p) => p.id === pid)?.name || pid;
}
