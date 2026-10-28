// The console side of the phone controller: buttons, typed text and music commands from paired phones, the
// QR pairing screen, and the state sent back so the phone knows what is on the TV (e.g. a text field to fill).
import { api } from './api.js';
import { getFocused } from './focus.js';
import { icon } from './icons.js';
import { remoteAction } from './input.js';
import { music } from './music.js';
import { cid, send } from './realtime.js';
import { emit, on, store } from './store.js';
import { closeOverlay, esc, hints, openOverlay, remoteText, toast } from './ui.js';

const SCREEN_NAMES = {
  home: 'Home', movies: 'Movies', music: 'Music', games: 'Games', store: 'Game Store', smarthome: 'Smart Home',
  drive: 'Cloud Drive', ai: 'For You', friends: 'Friends', trophies: 'Trophies', settings: 'Settings',
  stats: 'aPi Wrapped', monitor: 'Monitor', profiles: 'Profiles',
};

let lastState = '';
function sendState() {
  const f = getFocused();
  const typing = !!(document.querySelector('.osk-overlay, .pin-panel') || f?.matches?.('input.field'));
  const t = music.track;
  const state = {
    t: 'state',
    screen: SCREEN_NAMES[document.body.dataset.screen] || '',
    label: (f?.querySelector?.('.card-label, .pf-name')?.textContent || f?.getAttribute?.('aria-label') || f?.textContent || '').trim().slice(0, 60),
    typing,
    music: music.album ? { title: t?.title || music.album.title, artist: t?.artist || music.album.artist || '', playing: music.playing } : null,
  };
  const key = JSON.stringify(state);
  if (key === lastState) return;
  lastState = key;
  send(state);
}

/** QR code on the TV; the phone that scans it becomes a controller for this console. */
export async function openPairing() {
  let pairing;
  try {
    pairing = await api.pairPhone(cid);
  } catch (err) {
    toast({ icon: 'x', title: 'Could not create a pairing code', text: err.message, tone: 'error' });
    return;
  }
  openOverlay({
    className: 'center-panel',
    render(body, layer) {
      body.innerHTML = `<div class="panel pair-panel">
        <div class="kicker">${icon('gamepad', 18)} Phone as controller</div>
        <h2 class="title-lg">Scan with your phone</h2>
        <div class="pair-qr">${pairing.qr}</div>
        <p class="muted">Or open <b class="num">${esc(pairing.url.replace(/\?.*/, ''))}</b> … the code works once, for 10 minutes.
        Your phone needs to be on the same Wi-Fi${pairing.url.startsWith('https') ? ' or on Tailscale' : ''}.</p>
        <div class="pair-status"><span class="spinner"></span> Waiting for a phone…</div>
        ${store.phones ? `<button class="btn small" data-focus data-act="unpair">${icon('x', 18)} Disconnect ${store.phones} phone${store.phones > 1 ? 's' : ''}</button>` : ''}
        ${hints([['b', 'Close']])}</div>`;
      const off = on('rt:phones', ({ count }) => {
        if (count > 0) {
          off();
          closeOverlay(layer, { silent: true });
        }
      });
      body.addEventListener('click', async (e) => {
        if (!e.target.closest('[data-act="unpair"]')) return;
        await api.unpairPhones(cid).catch(() => {});
        toast({ icon: 'gamepad', title: 'Phones disconnected', duration: 2000 });
        closeOverlay(layer, { silent: true });
      });
      layer.onClose = off;
    },
  });
}

const DIRS = new Set(['up', 'down', 'left', 'right']);
const held = new Map(); // action → repeat timer, while a phone button is held

/** A game running in this browser (EmulatorJS): phone buttons go straight into the emulator. */
function gameFrame() {
  return document.querySelector('.webgame-overlay.open iframe');
}

function phoneButton({ action, down = true, hold = false }) {
  const frame = gameFrame();
  if (frame) {
    frame.contentWindow.postMessage({ type: 'apistation-pad', action, down }, location.origin);
    if (down) held.set(action, null);
    else held.delete(action);
    if (held.has('start') && held.has('select')) remoteAction('quit'); // the exit combo, like on a controller
    return;
  }
  if (!down) {
    clearTimeout(held.get(action));
    clearInterval(held.get(action));
    held.delete(action);
    return;
  }
  remoteAction(action);
  // Holding a direction on the phone scrolls like holding it on a pad.
  if (hold && DIRS.has(action)) {
    held.set(action, setTimeout(() => held.set(action, setInterval(() => remoteAction(action), 110)), 380));
  }
}

export function initRemoteHost() {
  on('rt:remote', phoneButton);
  on('rt:remote-text', ({ text, submit }) => {
    if (!remoteText(text, submit)) toast({ icon: 'keyboard', title: 'Nothing to type into here', tone: 'muted', duration: 1600 });
  });
  on('rt:remote-music', ({ cmd }) => {
    if (!music.album) return;
    if (cmd === 'toggle') music.toggle();
    if (cmd === 'next') music.next();
    if (cmd === 'prev') music.prev();
  });
  let count = 0;
  on('rt:phones', ({ count: n }) => {
    if (n > count) toast({ icon: 'gamepad', title: 'Phone connected', text: 'It now works as a controller for this screen.', tone: 'info' });
    count = n;
    emit('profile', store); // repaint the top bar badge
  });
  on('rt:phone-hello', () => { lastState = ''; sendState(); });
  // Keep the phone in sync with what the TV shows (cheap: only sent when something changed).
  on('music', sendState);
  setInterval(() => { if (store.phones) sendState(); }, 700);
}
