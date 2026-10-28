// aPiStation Remote: a phone becomes a controller for the console that showed the QR code. Buttons, typed text
// and music commands go over a WebSocket to the hub, which relays them to that console only.
const KEY = 'apistation.remote.key';
const statusEl = document.getElementById('status');
const screenEl = document.getElementById('screen');
const musicEl = document.getElementById('music');
const textEl = document.getElementById('text');

let ws = null;
let retry = 0;
let pair = new URLSearchParams(location.search).get('pair');

const store = {
  get: () => { try { return localStorage.getItem(KEY); } catch { return null; } },
  set: (v) => { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch { /* private mode */ } },
};

function setStatus(text, state) {
  statusEl.querySelector('span').textContent = text;
  statusEl.dataset.state = state;
}

function connect() {
  const key = store.get();
  if (!pair && !key) {
    setStatus('Not paired', 'off');
    screenEl.textContent = 'Open the quick menu on the TV (Menu button) → "Use your phone as controller" and scan the QR code.';
    return;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const query = pair ? `pair=${encodeURIComponent(pair)}` : `key=${encodeURIComponent(key)}`;
  ws = new WebSocket(`${proto}://${location.host}/ws?role=phone&${query}`);
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.t === 'key') {
      store.set(msg.key);
      pair = null;
      history.replaceState(null, '', location.pathname); // the pairing link works only once
    } else if (msg.t === 'paired') {
      retry = 0;
      setStatus(msg.tv ? 'TV controller' : msg.profile ? `${msg.profile}'s screen` : 'Connected', 'on');
      if (msg.tv && !msg.pad) {
        screenEl.textContent = 'Menus work. For games on the TV, run kiosk/setup-phone-pad.sh once on the Pi (it needs sudo).';
      }
    } else if (msg.t === 'state') {
      paintState(msg);
    } else if (msg.t === 'phones') {
      // another phone joined or left; nothing to do
    }
  };
  ws.onclose = (e) => {
    ws = null;
    if (e.code === 4401 || e.code === 4403) {
      store.set(null);
      pair = null;
      setStatus('Pairing expired', 'off');
      screenEl.textContent = 'This phone was disconnected. Scan a new QR code on the TV.';
      return;
    }
    setStatus('Reconnecting…', 'wait');
    setTimeout(connect, Math.min(10000, 800 * 2 ** retry++));
  };
}

function paintState(s) {
  screenEl.innerHTML = '';
  const where = document.createElement('b');
  where.textContent = s.screen || 'aPiStation';
  screenEl.append(where);
  if (s.label) screenEl.append(` · ${s.label}`);
  document.body.classList.toggle('typing', !!s.typing);
  textEl.placeholder = s.typing ? 'The TV is waiting for text: type here' : 'Type on the TV…';
  musicEl.hidden = !s.music;
  if (s.music) {
    document.getElementById('music-title').textContent = s.music.title;
    document.getElementById('music-artist').textContent = s.music.artist;
    document.getElementById('music-toggle').textContent = s.music.playing ? '⏸' : '▶';
  }
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function buzz() {
  navigator.vibrate?.(12);
}

// ----- buttons: press and release, like a real pad (games need to know a button is held) -----
document.querySelectorAll('[data-action]').forEach((btn) => {
  let pressed = false;
  const release = () => {
    if (!pressed) return;
    pressed = false;
    btn.classList.remove('down');
    send({ t: 'input', action: btn.dataset.action, down: false });
  };
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    btn.setPointerCapture?.(e.pointerId);
    if (pressed) return;
    pressed = true;
    btn.classList.add('down');
    buzz();
    send({ t: 'input', action: btn.dataset.action, down: true });
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => btn.addEventListener(ev, release));
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
});
// Leaving the page (or the screen turning off) must not leave a button held down.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) document.querySelectorAll('[data-action].down').forEach((b) => b.dispatchEvent(new PointerEvent('pointercancel')));
});

document.querySelectorAll('[data-music]').forEach((btn) => btn.addEventListener('click', () => {
  buzz();
  send({ t: 'music', cmd: btn.dataset.music });
}));

// ----- typing: live while typing (search updates on the TV), Send submits -----
let typeTimer = null;
textEl.addEventListener('input', () => {
  clearTimeout(typeTimer);
  typeTimer = setTimeout(() => send({ t: 'text', text: textEl.value, submit: false }), 300);
});
document.getElementById('type').addEventListener('submit', (e) => {
  e.preventDefault();
  clearTimeout(typeTimer);
  send({ t: 'text', text: textEl.value, submit: true });
  textEl.value = '';
  buzz();
});

connect();
