// Persistent console chrome: top bar, now-playing bar, quick menu, quests panel, share dialog.
import { api } from './api.js';
import { avatar, cover } from './art.js';
import { icon, glyph } from './icons.js';
import { music } from './music.js';
import { go, current, resetHistory } from './router.js';
import { store, on, friendOf } from './store.js';
import { celebrate, closeOverlay, esc, hints, html, keyboardPrompt, openOverlay, toast } from './ui.js';
import { lastSource } from './input.js';
import { openPairing } from './remote-host.js';
import { signOut } from './session.js';
import { leaveParty, party } from './together.js';

let cpuTemp = null;
async function pollTemp() {
  try {
    cpuTemp = (await api.system()).cpu_temp;
  } catch { /* hub restarting */ }
}
pollTemp();
setInterval(pollTemp, 30000);

function clock() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function ring(profile, size = 56) {
  return `<div class="ring" style="--p:${profile.progress};--size:${size}px;--hue:${profile.hue}">${avatar(profile, size - 8)}</div>`;
}

// ---------- top bar ----------
export function mountTopbar(el, crumb = '') {
  const bar = html`<header class="topbar">
    <div class="brand">
      <span class="brand-mark">π</span>
      <span class="brand-word">a<b>Pi</b>Station</span>
      ${crumb ? `<span class="crumb">${esc(crumb)}</span>` : ''}
    </div>
    <div class="topbar-right" data-group="top"></div>
  </header>`;
  el.prepend(bar);
  const right = bar.querySelector('.topbar-right');

  const paint = () => {
    const p = store.profile;
    if (!p) return;
    const quests = store.quests || [];
    const done = quests.filter((q) => q.done).length;
    const focusedAct = right.querySelector('.focused')?.dataset.act;
    right.innerHTML = `
      <button class="chip" data-focus data-act="quests" title="Daily quests">${icon('target', 22)}<span>${done}/${quests.length || 3}</span></button>
      <button class="chip" data-focus data-act="trophies" title="Trophies">${icon('trophy', 22)}<span>${p.trophies?.total ?? 0}</span></button>
      ${p.unread ? `<button class="chip chip-alert" data-focus data-act="friends" title="Inbox">${icon('inbox', 22)}<span>${p.unread}</span></button>` : ''}
      <span class="chip static streak" title="Daily streak">${icon('flame', 22)}<span>${p.streak}</span></span>
      ${store.phones ? `<span class="chip static" title="Phone controller">${icon('gamepad', 22)}<span>${store.phones}</span></span>` : ''}
      <span class="clock">${clock()}</span>
      ${cpuTemp ? `<span class="temp">${icon('thermometer', 20)}${Math.round(cpuTemp)}°</span>` : ''}
      <button class="profile-chip" data-focus data-act="menu">
        ${ring(p, 58)}
        <span class="pc-text">
          <span class="pc-name">${esc(p.name)}</span>
          <span class="pc-level">${store.guest ? 'Guest · read-only demo' : `Lv ${p.level} · ${esc(p.title)}`}</span>
          <span class="xpbar"><i style="width:${Math.round(p.progress * 100)}%"></i></span>
        </span>
      </button>`;
    if (focusedAct) right.querySelector(`[data-act="${focusedAct}"]`)?.classList.add('focused');
  };
  right.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'quests') openQuests();
    else if (act === 'trophies') go('trophies');
    else if (act === 'friends') go('friends');
    else if (act === 'menu') openQuickMenu();
  });
  paint();
  const offs = [on('profile', paint), on('quests', paint)];
  const tick = setInterval(paint, 20000);
  return () => { offs.forEach((off) => off()); clearInterval(tick); };
}

// ---------- now playing ----------
export function initNowPlaying() {
  const hostEl = document.getElementById('nowplaying-host');
  let raf = null;
  let last = 0;
  const paint = () => {
    if (!music.album) {
      hostEl.innerHTML = '';
      hostEl.classList.remove('show');
      cancelAnimationFrame(raf);
      raf = null;
      return;
    }
    const a = music.album;
    const t = music.track;
    const song = t?.kind === 'track';
    document.getElementById('yt-host').classList.toggle('paused', !music.playing);
    hostEl.innerHTML = `
      <div class="np ${music.playing ? 'playing' : 'paused'}">
        ${cover(song ? t : a, 'square')}
        <div class="np-info">
          <div class="np-title">${esc(music.engine === 'loading' ? 'Loading…' : t?.title || a.title)}</div>
          <div class="np-artist">${esc(song ? `${t.artist} · ${a.title}` : `${a.artist} · ${a.title}`)}</div>
          <div class="np-progress"><i></i></div>
        </div>
        <div class="np-viz">${'<i></i>'.repeat(10)}</div>
        <div class="np-keys">${glyph('lb')}${glyph('select')}${glyph('rb')}</div>
      </div>`;
    hostEl.classList.add('show');
    if (!raf) raf = requestAnimationFrame(loop);
  };
  const loop = (t) => {
    raf = requestAnimationFrame(loop);
    if (t - last < 60) return;
    last = t;
    const bars = hostEl.querySelectorAll('.np-viz i');
    const levels = music.levels(bars.length);
    bars.forEach((b, i) => { b.style.transform = `scaleY(${0.08 + levels[i] * 0.92})`; });
    const prog = hostEl.querySelector('.np-progress i');
    const d = music.duration();
    if (prog && d) prog.style.transform = `scaleX(${Math.min(music.elapsed() / d, 1)})`;
  };
  on('music', paint);
}

// ---------- quests ----------
export function questCard(q) {
  const pct = Math.min(q.progress / q.target, 1);
  return `<div class="quest ${q.done ? 'done' : ''}">
    <div class="quest-icon">${icon(q.done ? 'check' : q.icon, 26, 2.2)}</div>
    <div class="quest-body">
      <div class="quest-title">${esc(q.title)}</div>
      <div class="quest-desc">${esc(q.description)}</div>
      <div class="bar"><i style="width:${pct * 100}%"></i></div>
    </div>
    <div class="quest-meta"><div class="xp-pill">+${q.xp} XP</div><div class="quest-count">${Math.min(q.progress, q.target)}/${q.target}</div></div>
  </div>`;
}

function untilMidnight() {
  const now = new Date();
  const end = new Date(now);
  end.setHours(24, 0, 0, 0);
  const m = Math.floor((end - now) / 60000);
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function openQuests() {
  openOverlay({
    className: 'side-panel',
    render(body) {
      const quests = store.quests || [];
      body.innerHTML = `<div class="panel quests-panel">
        <div class="panel-head">${icon('target', 30)}<div><h2>Daily Quests</h2><p>New quests in ${untilMidnight()}</p></div></div>
        <div class="quest-list">${quests.map(questCard).join('')}</div>
        <button class="btn" data-focus data-autofocus data-act="trophies">${icon('trophy', 22)} All trophies</button>
        ${hints([['a', 'Open'], ['b', 'Close']])}
      </div>`;
      body.querySelector('[data-act="trophies"]').addEventListener('click', () => {
        closeOverlay(undefined, { silent: true });
        go('trophies');
      });
    },
  });
}

// ---------- quick menu ----------
export function openQuickMenu() {
  const p = store.profile;
  openOverlay({
    className: 'side-panel',
    render(body) {
      body.innerHTML = `<div class="panel quick-menu">
        <div class="qm-profile">${ring(p, 96)}<div><div class="qm-name">${esc(p.name)}</div><div class="qm-title">Level ${p.level} · ${esc(p.title)}</div>
          <div class="xpbar big"><i style="width:${Math.round(p.progress * 100)}%"></i></div>
          <div class="qm-xp">${p.xp - p.level_floor} / ${p.level_ceil - p.level_floor} XP to level ${p.level + 1}</div></div></div>
        <div class="qm-list">
          ${[...(party.current ? [['leave-party', 'users', `Leave: ${party.current.kind === 'watch' ? 'watching' : 'listening'} together`]] : []),
             ['home', 'home', 'Home'], ['phone', 'gamepad', store.phones ? `Phone controller · ${store.phones} connected` : 'Use your phone as controller'],
             ['trophies', 'trophy', 'Trophies & Quests'], ['stats', 'chart', 'aPi Wrapped'], ['ai', 'sparkles', 'Assistant'], ['friends', 'users', 'Friends'],
             ['settings', 'sliders', 'Settings'], ['switch', 'user', 'Switch profile'], ['reload', 'refresh', 'Restart console']]
            .map(([act, ic, label], i) => `<button class="qm-item" data-focus ${i === 0 ? 'data-autofocus' : ''} data-act="${act}">${icon(ic, 26)}<span>${label}</span>${icon('chevronRight', 22)}</button>`).join('')}
        </div>
        ${hints([['a', 'Select'], ['b', 'Close']])}
      </div>`;
      body.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (!act) return;
        closeOverlay(undefined, { silent: true });
        if (act === 'reload') return location.reload();
        if (act === 'phone') return openPairing();
        if (act === 'leave-party') return leaveParty();
        if (act === 'switch') return signOut();
        if (act === 'home') {
          resetHistory();
          return current()?.name === 'home' ? null : go('home', {}, { replace: true });
        }
        go(act);
      });
    },
  });
}

// ---------- share ----------
const SHARE_MESSAGES = ['You have to check this out!', 'Perfect for tonight', 'Play this with me?', 'This reminded me of you'];

export function openShare(item) {
  const friend = friendOf(store.profile.id);
  if (!friend) return toast({ icon: 'users', title: 'No friends yet', text: 'Add a second profile first', tone: 'muted' });
  const kind = item.kind;
  openOverlay({
    className: 'center-panel',
    render(body, layer) {
      body.innerHTML = `<div class="panel share-panel">
        <div class="share-head">${cover(item, kind === 'album' ? 'square' : kind === 'game' ? 'wide' : 'poster')}
          <div><div class="kicker">Share with ${esc(friend.name)}</div><h2>${esc(item.title)}</h2>
          <div class="share-to">${ring(friend, 52)}<span>${esc(friend.name)} · Lv ${friend.level}</span></div></div></div>
        <div class="share-msgs" data-group="msgs">
          ${SHARE_MESSAGES.map((m, i) => `<button class="btn ghost" data-focus ${i === 0 ? 'data-autofocus' : ''} data-msg="${esc(m)}">“${esc(m)}”</button>`).join('')}
          <button class="btn ghost" data-focus data-custom>${icon('keyboard', 22)} Write a message…</button>
        </div>
        ${hints([['a', 'Send'], ['b', 'Cancel']])}
      </div>`;
      const send = async (message) => {
        try {
          const res = await api.share(store.profile.id, friend.id, kind, item.id, message);
          closeOverlay(layer, { silent: true });
          celebrate(res.event, `Shared with ${friend.name}`);
        } catch (err) {
          toast({ icon: 'x', title: 'Could not share', text: err.message, tone: 'error' });
        }
      };
      body.addEventListener('click', async (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        if (btn.dataset.msg) return send(btn.dataset.msg);
        if (btn.hasAttribute('data-custom')) {
          const text = await textEntry('Message for ' + friend.name);
          if (text) send(text);
        }
      });
    },
  });
}

/** Text input that uses the on-screen keyboard for gamepads and a native prompt field for keyboards. */
export async function textEntry(title, value = '') {
  if (lastSource === 'gamepad') return keyboardPrompt({ title, value });
  return new Promise((resolve) => {
    let done = false;
    openOverlay({
      className: 'center-panel',
      render(body, layer) {
        body.innerHTML = `<div class="panel text-entry">
          <div class="osk-title">${icon('keyboard', 26)} ${esc(title)}</div>
          <input class="field" data-focus data-autofocus value="${esc(value)}" maxlength="200">
          ${hints([['a', 'Send'], ['b', 'Cancel']])}
        </div>`;
        const input = body.querySelector('input');
        setTimeout(() => input.focus(), 60);
        input.addEventListener('submit-input', () => {
          done = true;
          resolve(input.value.trim() || null);
          closeOverlay(layer, { silent: true });
        });
        input.addEventListener('click', () => input.focus());
        layer.onClose = () => { if (!done) resolve(null); };
      },
    });
  });
}
