// For You: recommendations for every part of the console on the left (tonight's lineup, films, Claude's mix,
// games from the library and the Store, the house, the Cloud Drive), and on the right the free aPi Assistant,
// a small model running on the Pi (no tokens) that also acts on commands (scenes, playback, any song or artist).
import { api } from '../api.js';
import { cover } from '../art.js';
import { mountTopbar } from '../chrome.js';
import { focus, focusables, getFocused } from '../focus.js';
import { icon } from '../icons.js';
import { lastSource } from '../input.js';
import { playItem, playSongs } from '../playback.js';
import { go } from '../router.js';
import { findItem, loadDrive, loadFilms, loadMusic, loadRecs, on, store } from '../store.js';
import { celebrate, esc, hints, keyboardPrompt, timeAgo, toast } from '../ui.js';

const chats = new Map(); // profile id → messages, kept while the console runs

const PROMPTS = [
  ['sparkles', 'What can aPiStation do?'],
  ['music', 'Play Daft Punk'],
  ['moon', 'Good night'],
  ['heart', 'Ce pot face pe consola asta?'],
];

function card(act, item, title, sub, reason, badge = '') {
  return `<button class="card fy-card" data-focus data-act="${esc(act)}">
    ${badge ? `<span class="badge-corner">${badge}</span>` : ''}
    ${cover(item, 'square')}
    <div class="card-label">${esc(title)}</div>
    ${sub ? `<div class="card-sub">${esc(String(sub))}</div>` : ''}
    ${reason ? `<div class="fy-reason">${esc(reason)}</div>` : ''}
  </button>`;
}

const sceneCard = (scene, reason) => `<button class="card fy-card" data-focus data-act="scene:${esc(scene.id)}">
    <span class="badge-corner">${icon('home', 14)} House</span>
    <div class="cover cover-square icon-cover" style="--ch:${scene.hue}">${icon(scene.icon, 72, 1.5)}</div>
    <div class="card-label">${esc(scene.name)}</div><div class="card-sub">Smart home scene</div>
    ${reason ? `<div class="fy-reason">${esc(reason)}</div>` : ''}
  </button>`;

const skeleton = '<div class="nf-skeleton fy-skeleton"></div>'.repeat(5);

/** One row per category; `null` cards mean still loading. */
function sections() {
  const recs = store.recs;
  const lineup = recs && (recs.picks || []).map((p) => {
    const it = findItem(p.kind, p.item_id);
    return it && card(`item:${p.kind}:${p.item_id}`, it, it.title.split(' — ')[0], { movie: 'Film', album: 'Album', game: 'Game' }[p.kind], p.reason,
      `${icon('sparkles', 14)} ${esc(p.vibe)}`);
  }).filter(Boolean);
  const films = store.filmPicks && (store.filmPicks.top || []).slice(0, 12).map((f) => card(`film:${f.id}`, { ...f, poster_fit: 'contain' }, f.title, f.year, f.reason));
  const songs = store.musicPicks && (store.musicPicks.tracks || []).map((t) => card(`song:${t.id}`, t, t.title, t.artist, t.reason));
  const games = recs && (recs.games || []).map((g) => {
    if (g.kind === 'game') {
      const it = findItem('game', g.item_id);
      return it && card(`item:game:${g.item_id}`, it, it.title, it.platform, g.reason, `${icon('gamepad', 14)} Yours`);
    }
    const it = store.storeGames.find((s) => s.id === g.item_id);
    return it && card(`store:${g.item_id}`, it, it.title, `${it.platform} · free`, g.reason, `${icon('download', 14)} Store`);
  }).filter(Boolean);
  const scene = recs?.scene && store.home?.scenes?.find((s) => s.id === recs.scene.scene_id);
  const house = recs && [
    ...(scene ? [sceneCard(scene, recs.scene.reason)] : []),
    ...(store.home?.scenes || []).filter((s) => s !== scene).slice(0, 4).map((s) => sceneCard(s, s.description)),
  ];
  const files = store.driveRecent && store.driveRecent.map((f) => card(`file:${f.path}`, { id: f.path, title: f.name, poster: f.thumb },
    f.name, `${f.owner} · ${timeAgo(f.modified)}`, '', `${icon('cloud', 14)} Drive`));
  return [
    { id: 'lineup', icon: 'sparkles', title: "Tonight's lineup", cards: lineup },
    { id: 'films', icon: 'film', title: 'Films for you', cards: films },
    { id: 'music', icon: 'music', title: store.musicPicks?.headline ? `Claude's mix · ${store.musicPicks.headline}` : "Claude's mix", cards: songs },
    { id: 'games', icon: 'gamepad', title: 'Games for you', cards: games },
    { id: 'house', icon: 'home', title: 'For the house', cards: house },
    ...(files?.length ? [{ id: 'drive', icon: 'cloud', title: 'New in your Cloud Drive', cards: files }] : []),
  ];
}

export default {
  hue: [262, 190],
  async mount(el, params = {}) {
    const pid = store.profile.id;
    if (!chats.has(pid)) chats.set(pid, []);
    const chat = chats.get(pid);
    const local = store.health?.assistant;
    const claude = store.health?.ai?.enabled && !store.guest;

    el.innerHTML = `
      <div class="fy-main" data-scroll="y-start" data-scroll-pad="62">
        <div class="fy-hero">
          <div class="orb small"></div>
          <div class="fy-hero-text">
            <div class="kicker">For you${claude ? ' · picked by Claude' : ''}</div>
            <h1 class="fy-headline"></h1>
            <p class="muted">Films, music, games and the house, chosen from what you watched, played and liked.</p>
          </div>
          <button class="btn small" data-focus data-act="refresh">${icon('refresh', 20)} New picks</button>
        </div>
        <div class="fy-rows"></div>
      </div>
      <div class="panel ai-chat">
        <div class="chat-head">
          <span class="chat-title">${icon('sparkles', 28)} aPi Assistant</span>
          <span class="badge-ai ${local?.enabled ? '' : 'offline'}"><span class="dot ${local?.enabled ? '' : 'off'}"></span>${local?.enabled ? `${esc(local.model)} · free, on this Pi` : 'Commands only'}</span>
        </div>
        <div class="chat-log" data-scroll="y"></div>
        <div class="chips" data-group="chips">${PROMPTS.map(([ic, p]) => `<button class="chip-btn" data-focus data-prompt="${esc(p)}">${icon(ic, 20)} ${esc(p)}</button>`).join('')}</div>
        <div class="chat-input" data-group="input">
          <input class="field" data-focus placeholder="Ask anything, or say “play Queen”…" maxlength="500">
          <button class="icon-btn" data-focus data-act="send">${icon('send', 26)}</button>
        </div>
      </div>
      ${hints([['a', 'Select'], ['y', 'New picks'], ['b', 'Back']])}`;
    const cleanup = mountTopbar(el, 'For You');
    const rowsEl = el.querySelector('.fy-rows');
    const log = el.querySelector('.chat-log');
    const input = el.querySelector('.chat-input input');
    let busy = false;
    let moved = false;

    // ----- recommendations -----
    const paintPicks = () => {
      el.querySelector('.fy-headline').textContent = store.recs?.headline || 'Thinking about your evening…';
      const f = getFocused();
      const keep = f && rowsEl.contains(f) ? f.dataset.act : null;
      rowsEl.innerHTML = sections().map((s) => `<section class="fy-row">
          <div class="row-title">${icon(s.icon, 24)} ${esc(s.title)}</div>
          <div class="shelf" data-group="fy-${s.id}" data-scroll="x">${s.cards === null || s.cards === undefined ? skeleton
            : s.cards.join('') || '<div class="empty">Nothing here yet</div>'}</div>
        </section>`).join('');
      if (keep) focus(rowsEl.querySelector(`[data-act="${CSS.escape(keep)}"]`) || focusables(rowsEl)[0], { silent: true });
      // Picks arrived while nothing was chosen yet: start on the first one.
      else if (!moved && getFocused()?.dataset.act === 'refresh' && rowsEl.querySelector('.fy-card')) focus(rowsEl.querySelector('.fy-card'), { silent: true });
    };

    const activate = async (act) => {
      const [type, ...rest] = act.split(':');
      const id = rest.join(':');
      if (type === 'item') return playItem(findItem(rest[0], rest.slice(1).join(':')));
      if (type === 'film') return go('movies', { focus: id });
      if (type === 'store') return go('store', { focus: id });
      if (type === 'file') return go('drive', { open: id });
      if (type === 'song') {
        const tracks = store.musicPicks.tracks;
        return playSongs(tracks, Math.max(tracks.findIndex((t) => t.id === id), 0), store.musicPicks.headline || "Claude's mix", 'claude-mix');
      }
      if (type === 'scene') {
        const res = await api.scene(pid, id);
        store.home = res.home;
        return celebrate(res.event, `Scene: ${res.scene.name}`);
      }
      return null;
    };

    // ----- chat with the free assistant -----
    const paintChat = () => {
      log.innerHTML = (chat.length ? '' : `<div class="msg ai"><div class="orb tiny"></div><div class="msg-body"><p>Hi ${esc(store.profile.name)}! I'm the aPi Assistant and I run right here on the Pi, so chat as much as you like. Ask me anything about the console, or tell me “play Daft Punk”, “movie night lights” or “good night”.</p></div></div>`)
        + chat.map((m) => (m.role === 'user'
          ? `<div class="msg user"><div class="msg-body"><p>${esc(m.text)}</p></div></div>`
          : `<div class="msg ai"><div class="orb tiny"></div><div class="msg-body">
              <p>${m.text ? esc(m.text) : '<span class="typing"><i></i><i></i><i></i></span>'}</p>
              ${m.songs ? `<span class="tag ok">${icon('music', 16)} ${esc(m.songs.title)}</span>` : ''}
              ${m.actions?.length ? `<div class="msg-actions">${m.actions.map((a) => (a.type === 'play'
                ? `<button class="btn small" data-focus data-play-kind="${a.item.kind}" data-play-id="${esc(a.item.id)}">${icon('play', 18)} ${esc(a.item.title)}</button>`
                : a.type === 'open'
                  ? `<button class="btn small" data-focus data-open="${esc(a.screen)}">${icon('chevronRight', 18)} ${esc(a.label)}</button>`
                  : `<span class="tag ok">${icon('check', 16)} ${esc(a.label)}</span>`)).join('')}</div>` : ''}
            </div></div>`)).join('');
      log.scrollTop = log.scrollHeight;
    };

    const send = async (text) => {
      text = (text || '').trim();
      if (!text || busy) return;
      busy = true;
      chat.push({ role: 'user', text });
      input.value = '';
      const history = chat.slice(0, -1).slice(-6).map((m) => ({ role: m.role, text: m.text }));
      const reply = { role: 'assistant', text: '' };
      chat.push(reply);
      paintChat();
      const bubble = log.querySelector('.msg:last-child p');
      try {
        // The local model writes a few words per second: show them as they come.
        const res = await api.chat(pid, text, history, (delta) => {
          reply.text += delta;
          bubble.textContent = reply.text;
          log.scrollTop = log.scrollHeight;
        });
        Object.assign(reply, { text: res.reply, actions: res.actions, songs: res.songs, source: res.source });
        store.home = res.home;
        busy = false;
        paintChat();
        celebrate(res.event, res.event.xp ? 'Asked the assistant' : '');
        if (res.songs?.tracks?.length) playSongs(res.songs.tracks, 0, res.songs.title);
        const firstPlay = log.querySelector('.msg:last-child [data-play-id], .msg:last-child [data-open]');
        if (firstPlay) focus(firstPlay, { silent: true });
      } catch (err) {
        busy = false;
        chat.splice(-2, 2);
        paintChat();
        toast({ icon: 'x', title: 'The assistant is unavailable', text: err.message, tone: 'error' });
      }
    };

    el.addEventListener('click', async (e) => {
      const play = e.target.closest('[data-play-id]');
      if (play) return playItem(findItem(play.dataset.playKind, play.dataset.playId));
      const open = e.target.closest('[data-open]')?.dataset.open;
      if (open) return open === 'ai' ? null : go(open);
      const prompt = e.target.closest('[data-prompt]');
      if (prompt) return send(prompt.dataset.prompt);
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'send') {
        if (input.value.trim()) return send(input.value);
        input.click();
      } else if (act === 'refresh') {
        store.recs = null;
        paintPicks();
        toast({ icon: 'sparkles', title: 'Asking for new picks…', tone: 'info', duration: 1800 });
        await loadRecs(true).catch(() => {});
      } else if (act) {
        activate(act);
      }
      if (e.target === input && lastSource === 'gamepad') {
        const text = await keyboardPrompt({ title: 'Ask the assistant', placeholder: 'Play Daft Punk' });
        if (text) send(text);
      }
    });
    input.addEventListener('submit-input', () => send(input.value));

    const offs = [on('recs', paintPicks), on('films', paintPicks), on('music-data', paintPicks), on('drive', paintPicks)];
    paintPicks();
    paintChat();
    if (!store.recs) loadRecs().catch(() => {});
    if (!store.filmPicks) loadFilms();
    if (!store.musicPicks) loadMusic();
    loadDrive();
    if (params.prompt) send(params.prompt);
    focus(rowsEl.querySelector('.fy-card') || el.querySelector('[data-act="refresh"]'), { silent: true });

    return {
      onButton(action) {
        if (['up', 'down', 'left', 'right'].includes(action)) moved = true;
        if (action === 'y') {
          el.querySelector('[data-act="refresh"]').click();
          return true;
        }
        return false;
      },
      unmount() {
        cleanup();
        offs.forEach((off) => off());
      },
    };
  },
};
