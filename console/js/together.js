// Together: who is online and what they are doing (presence), invites, and watch / listen parties.
// Watch together: a shared player (a film downloaded on the Pi, or a trailer); anyone can pause or seek and
// everyone follows, with reactions. Listen together: the guests' music player follows the host's songs.
import { avatar } from './art.js';
import { icon } from './icons.js';
import { music } from './music.js';
import { send } from './realtime.js';
import { friendOf, on, store } from './store.js';
import { closeOverlay, esc, hints, openOverlay, toast } from './ui.js';
import { youtube } from './youtube.js';

export const party = { current: null, ui: null };
const REACTIONS = ['heart', 'flame', 'star', 'sparkles'];
const DRIFT = 1.5; // seconds of difference before a member jumps to the shared position

// ---------- presence ----------
const SCREEN_ACTIVITY = {
  home: 'On Home', movies: 'Browsing movies', music: 'In Music', games: 'In Games', store: 'In the Game Store',
  smarthome: 'In Smart Home', drive: 'In Cloud Drive', ai: 'In For You', friends: 'In Friends',
  trophies: 'Looking at trophies', stats: 'Looking at aPi Wrapped', settings: 'In Settings',
};
let lastActivity = '';

function activity() {
  const p = party.current;
  if (p) return { text: `${p.kind === 'watch' ? 'Watching' : 'Listening to'} ${p.media.title} together`, kind: 'party' };
  if (store.watching) return { text: `Watching ${store.watching}`, kind: 'watch' };
  if (music.playing && music.track) {
    return { text: `Listening to ${music.track.title}${music.track.artist ? ` · ${music.track.artist}` : ''}`, kind: 'listen' };
  }
  return { text: SCREEN_ACTIVITY[document.body.dataset.screen] || 'Online', kind: 'browse' };
}

function sendPresence() {
  if (!store.profile || store.guest) return;
  const a = activity();
  if (a.text === lastActivity) return;
  lastActivity = a.text;
  send({ t: 'presence', activity: a });
}

/** The other player, if they are signed in somewhere right now. */
export function onlineFriend() {
  const friend = store.profile && friendOf(store.profile.id);
  return friend && store.presence?.[friend.id]?.online ? friend : null;
}

// ---------- invites ----------
/** Start a party and invite the other player. kind: 'watch' (media: {title, video|youtube}) or 'listen' (a track). */
export function startParty(kind, media) {
  const friend = onlineFriend();
  if (!friend) {
    const other = store.profile && friendOf(store.profile.id);
    toast({ icon: 'users', title: other ? `${other.name} isn't online` : 'No friend to invite',
      text: 'They need to be signed in on a screen: the TV, a laptop or a phone.', tone: 'muted' });
    return;
  }
  if (party.current) leaveParty();
  send({ t: 'party-create', kind, media, guests: [friend.id] });
  toast({ icon: 'users', title: `Invited ${friend.name}`, text: kind === 'watch' ? 'The film starts when you press play.' : 'They will hear what you play.', tone: 'info' });
}

function showInvite(p) {
  openOverlay({
    className: 'center-panel',
    render(body, layer) {
      body.innerHTML = `<div class="panel invite-panel">
        ${avatar({ id: p.host, hue: store.profiles.find((x) => x.id === p.host)?.hue }, 96)}
        <div class="kicker">${p.kind === 'watch' ? 'Watch together' : 'Listen together'}</div>
        <h2 class="title-lg">${esc(p.host_name)} invites you</h2>
        <p class="muted">${p.kind === 'watch' ? 'to watch' : 'to listen to'} <b>${esc(p.media.title)}</b>${p.media.artist ? ` by ${esc(p.media.artist)}` : ''} together.</p>
        <div class="btn-row"><button class="btn primary" data-focus data-autofocus data-act="join">${icon('users', 22)} Join</button>
        <button class="btn" data-focus data-act="no">Not now</button></div>
        ${hints([['a', 'Select'], ['b', 'Not now']])}</div>`;
      body.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (!act) return;
        closeOverlay(layer, { silent: true });
        if (act === 'join') send({ t: 'party-join', id: p.id });
      });
    },
  });
}

export function leaveParty() {
  const p = party.current;
  if (!p) return;
  send({ t: 'party-leave', id: p.id });
  endParty();
}

function endParty() {
  if (party.current?.kind === 'listen') music.following = false;
  party.current = null;
  const ui = party.ui;
  party.ui = null;
  if (ui) closeOverlay(ui, { silent: true });
  sendPresence();
}

// ---------- watch together ----------
function openWatchParty(p) {
  if (music.playing) music.toggle();
  let player = null; // { play, pause, time, seek, playing }
  let applying = 0;
  let heartbeat = null;
  const isHost = () => party.current?.host === store.profile.id;
  party.ui = openOverlay({
    className: 'full-panel party-overlay',
    render(body, layer) {
      body.innerHTML = `<div class="party">
        <div class="party-stage"><div class="party-player"></div><div class="party-reactions"></div></div>
        <div class="party-side">
          <div class="kicker">${icon('users', 18)} Watching together</div>
          <h2 class="title-lg">${esc(p.media.title)}</h2>
          <div class="party-members"></div>
          <p class="muted">Anyone can pause or jump; everyone's screen follows.</p>
          <div class="btn-row" data-group="party-controls">
            <button class="btn primary" data-focus data-autofocus data-act="toggle">${icon('play', 22)} Play</button>
            <button class="icon-btn" data-focus data-act="back10" title="Back 10 seconds">${icon('prev', 22)}</button>
            <button class="icon-btn" data-focus data-act="fwd10" title="Forward 10 seconds">${icon('next', 22)}</button>
          </div>
          <div class="btn-row" data-group="party-react">${REACTIONS.map((r) => `<button class="icon-btn" data-focus data-react="${r}" title="Send ${r}">${icon(r, 24)}</button>`).join('')}</div>
          <button class="btn" data-focus data-act="leave">${icon('x', 20)} Leave</button>
          ${hints([['a', 'Select'], ['b', 'Leave']])}
        </div></div>`;
      const stage = body.querySelector('.party-player');
      const toggleBtn = body.querySelector('[data-act="toggle"]');
      const paintMembers = () => {
        const members = party.current?.members || [];
        body.querySelector('.party-members').innerHTML = members.map((pid) => {
          const prof = store.profiles.find((x) => x.id === pid);
          return `<span class="party-member">${avatar({ id: pid, hue: prof?.hue }, 34)} ${esc(prof?.name || pid)}${pid === party.current.host ? ' <small class="dim">host</small>' : ''}</span>`;
        }).join('');
      };
      const paintButton = () => {
        const on = player?.playing();
        toggleBtn.innerHTML = `${icon(on ? 'pause' : 'play', 22)} ${on ? 'Pause' : 'Play'}`;
      };
      // Something changed here: tell the others (unless we're just following them).
      const broadcast = () => {
        paintButton();
        if (Date.now() < applying || !player) return;
        send({ t: 'party-state', id: p.id, playing: player.playing(), position: player.time() });
      };
      let pending = null; // a state that arrived before the player was ready
      layer.apply = (state) => {
        if (!player) {
          pending = state;
          return;
        }
        applying = Date.now() + 800;
        const target = state.position + (state.playing ? 0.3 : 0);
        if (Math.abs(player.time() - target) > DRIFT) player.seek(target);
        if (state.playing && !player.playing()) player.play();
        if (!state.playing && player.playing()) player.pause();
        setTimeout(paintButton, 300);
      };
      layer.paintMembers = paintMembers;
      paintMembers();

      if (p.media.video) {
        stage.innerHTML = `<video src="${esc(p.media.video)}" playsinline preload="auto"></video>`;
        const v = stage.querySelector('video');
        player = { play: () => v.play().catch(() => {}), pause: () => v.pause(), time: () => v.currentTime, seek: (s) => { v.currentTime = s; }, playing: () => !v.paused };
        ['play', 'pause', 'seeked'].forEach((ev) => v.addEventListener(ev, broadcast));
      } else if (p.media.youtube) {
        stage.innerHTML = '<div class="party-yt"></div>';
        youtube().then(() => {
          if (!window.YT) return;
          let state = -1;
          // The player can only be controlled once YouTube says it's ready.
          new window.YT.Player(stage.querySelector('.party-yt'), {
            host: 'https://www.youtube-nocookie.com', videoId: p.media.youtube, width: '100%', height: '100%',
            playerVars: { controls: 1, rel: 0, playsinline: 1, origin: location.origin },
            events: {
              onReady: (e) => {
                const yt = e.target;
                player = { play: () => yt.playVideo(), pause: () => yt.pauseVideo(), time: () => yt.getCurrentTime() || 0,
                  seek: (s) => yt.seekTo(s, true), playing: () => state === 1 };
                if (pending || p.state?.position) layer.apply(pending || p.state);
                pending = null;
              },
              onStateChange: (e) => { state = e.data; if (e.data === 1 || e.data === 2) broadcast(); },
            },
          });
        });
      }
      // Joining late: catch up with the shared position.
      if (p.state?.position && player) setTimeout(() => layer.apply(p.state), 1200);
      heartbeat = setInterval(() => {
        if (isHost() && player?.playing()) send({ t: 'party-state', id: p.id, playing: true, position: player.time() });
      }, 5000);

      body.addEventListener('click', (e) => {
        const react = e.target.closest('[data-react]')?.dataset.react;
        if (react) {
          send({ t: 'party-react', id: p.id, icon: react });
          floatReaction(react, store.profile.name);
          return;
        }
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (!player && act !== 'leave') return;
        if (act === 'toggle') player.playing() ? player.pause() : player.play();
        if (act === 'back10') { player.seek(Math.max(0, player.time() - 10)); broadcast(); }
        if (act === 'fwd10') { player.seek(player.time() + 10); broadcast(); }
        if (act === 'leave') leaveParty();
      });
      layer.onClose = () => {
        clearInterval(heartbeat);
        stage.innerHTML = '';
        if (party.current) {
          send({ t: 'party-leave', id: p.id });
          party.current = null;
          party.ui = null;
          sendPresence();
        }
      };
    },
  });
}

function floatReaction(name, who) {
  const host = party.ui?.body.querySelector('.party-reactions');
  if (!host) return;
  const el = document.createElement('div');
  el.className = 'party-reaction';
  el.style.left = `${10 + Math.random() * 70}%`;
  el.innerHTML = `${icon(name, 56, 1.8)}<span>${esc(who)}</span>`;
  host.append(el);
  setTimeout(() => el.remove(), 2600);
}

// ---------- listen together ----------
let lastSent = '';
function broadcastMusic() {
  const p = party.current;
  if (!p || p.kind !== 'listen' || p.host !== store.profile.id || !music.track) return;
  const t = music.track;
  const track = { id: t.id, kind: 'track', title: t.title, artist: t.artist, artist_id: t.artist_id, album: t.album, poster: t.poster, duration: t.duration };
  const key = `${t.id}:${music.playing}:${music.engine}`;
  if (key === lastSent) return;
  lastSent = key;
  send({ t: 'party-state', id: p.id, playing: music.playing, position: music.elapsed(), track });
}

function followMusic(state) {
  const track = state.track || party.current?.media;
  if (!track) return;
  if (music.track?.id !== track.id) {
    music.playSongs({ id: `party-${party.current.id}`, title: `With ${party.current.host_name}` }, [track], 0);
    music.following = true;
    // The song needs a moment to load before it can jump to the host's position.
    setTimeout(() => { if (state.position > 3) music.seek(state.position + 1.5); }, 2500);
  } else if (Math.abs(music.elapsed() - state.position) > 4) {
    music.seek(state.position);
  }
  if (state.playing !== music.playing && music.track?.id === track.id && music.engine !== 'loading') music.toggle();
}

// ---------- wiring ----------
export function initTogether() {
  on('rt:open', () => { lastActivity = ''; sendPresence(); });
  on('music', () => { sendPresence(); broadcastMusic(); });
  new MutationObserver(sendPresence).observe(document.body, { attributes: true, attributeFilter: ['data-screen'] });
  setInterval(() => { if (party.current?.kind === 'listen' && party.current.host === store.profile?.id && music.playing) { lastSent = ''; broadcastMusic(); } }, 8000);

  on('rt:hello', ({ parties }) => (parties || []).forEach((p) => p.host !== store.profile?.id && showInvite(p)));
  on('rt:party-invite', ({ party: p }) => showInvite(p));
  on('rt:party', ({ party: p }) => {
    const first = party.current?.id !== p.id;
    party.current = p;
    if (p.kind === 'watch') {
      if (first) openWatchParty(p);
      else party.ui?.paintMembers?.();
    } else if (first) {
      if (p.host === store.profile.id) {
        lastSent = '';
        broadcastMusic();
      } else {
        toast({ icon: 'music', title: `Listening with ${p.host_name}`, text: 'Your music follows theirs. Leave from the quick menu.', tone: 'info' });
        followMusic({ ...p.state, track: p.media });
      }
    } else if (p.host === store.profile.id && p.members.length > 1) {
      toast({ icon: 'users', title: `${p.members.filter((m) => m !== store.profile.id).map((m) => store.profiles.find((x) => x.id === m)?.name || m).join(', ')} joined`, tone: 'info', duration: 2500 });
      lastSent = '';
      broadcastMusic();
    }
    sendPresence();
  });
  on('rt:party-state', (state) => {
    if (state.id !== party.current?.id) return;
    if (party.current.kind === 'watch') party.ui?.apply?.(state);
    else if (party.current.host !== store.profile.id) followMusic(state);
  });
  on('rt:party-react', ({ icon: name, name: who }) => floatReaction(name, who));
  on('rt:party-gone', ({ id, reason }) => {
    if (id !== party.current?.id) return;
    toast({ icon: 'users', title: reason === 'host-left' ? 'The host left: the party is over' : 'The party is over', tone: 'muted' });
    endParty();
  });
}
