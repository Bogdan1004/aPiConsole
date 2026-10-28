// Real-time link to the hub (one WebSocket): presence, the phone controller and watch/listen together.
// Every message from the hub is re-emitted on the store bus as `rt:<type>`.
import { emit, store } from './store.js';

/** This console's id, kept across reloads so a paired phone finds it again. */
export const cid = (() => {
  const make = () => Array.from({ length: 24 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
  try {
    let id = localStorage.getItem('apistation.cid');
    if (!id) {
      id = make();
      localStorage.setItem('apistation.cid', id);
    }
    return id;
  } catch {
    return make();
  }
})();

let ws = null;
let wanted = false;
let retry = 0;
let timer = null;

function open() {
  clearTimeout(timer);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  // The kiosk says it is the TV: phones paired with it then drive the Pi's virtual gamepad (games included).
  const tv = document.body.classList.contains('kiosk') ? '&tv=1' : '';
  ws = new WebSocket(`${proto}://${location.host}/ws?role=console&cid=${cid}${tv}`);
  ws.onopen = () => {
    retry = 0;
    store.online = true;
    emit('rt:open', {});
  };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.t === 'hello' || msg.t === 'presence') store.presence = msg.presence;
    if (msg.t === 'hello' || msg.t === 'phones') store.phones = msg.phones ?? msg.count ?? 0;
    emit(`rt:${msg.t}`, msg);
  };
  ws.onclose = () => {
    ws = null;
    store.online = false;
    emit('rt:close', {});
    if (wanted) timer = setTimeout(open, Math.min(20000, 1000 * 2 ** retry++));
  };
}

/** Called after signing in; reconnects by itself until disconnect(). */
export function connect() {
  wanted = true;
  if (!ws) open();
}

export function disconnect() {
  wanted = false;
  clearTimeout(timer);
  ws?.close();
  ws = null;
  store.presence = {};
  store.phones = 0;
}

export function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
