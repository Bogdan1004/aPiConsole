// Starting movies, albums and games, plus the full-screen player overlays.
import { api } from './api.js';
import { art } from './art.js';
import { glyph, icon } from './icons.js';
import { music } from './music.js';
import { openSnake } from './snake.js';
import { store } from './store.js';
import { celebrate, closeOverlay, esc, hints, openOverlay, toast } from './ui.js';

const VERB = { movie: 'Watching', album: 'Listening to', game: 'Playing' };

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

const onTv = () => document.body.classList.contains('kiosk');

/** Where a game plays by default: RetroArch on the TV, or EmulatorJS in this browser on a laptop. */
export function defaultTarget(item) {
  if (item.kind === 'movie') return item.imdb_id && !onTv() ? 'here' : 'tv';
  if (item.kind !== 'game' || !item.web) return 'tv';
  return onTv() && item.available ? 'tv' : 'here';
}

/** Songs from the internet catalog: plays `songs` from `index`, then keeps going with similar songs forever. */
export function playSongs(songs, index = 0, title = 'Endless radio', id = `mix-${Date.now()}`) {
  const song = songs[index];
  if (!song) return;
  music.playSongs({ id, title }, songs, index);
  api.musicStart(store.profile.id, song)
    .then((res) => celebrate(res.event, `Listening to ${song.title}`))
    .catch(() => {});
}

/** An artist's radio: their songs and similar artists', endless. */
export async function playArtistRadio(artist) {
  try {
    const songs = await api.musicRadio(store.profile.id, artist.id);
    playSongs(songs, 0, `${artist.title} radio`);
  } catch (err) {
    toast({ icon: 'x', title: `Could not start ${artist.title} radio`, text: err.message, tone: 'error' });
  }
}

export async function playItem(item, target = defaultTarget(item)) {
  if (item.kind === 'game' && target === 'tv' && !item.available) return openSetupHelp(item);
  let res;
  try {
    res = await api.play(store.profile.id, item.kind, item.id, target);
  } catch (err) {
    toast({ icon: 'x', title: `Could not start ${item.title}`, text: err.message, tone: 'error' });
    return;
  }
  celebrate(res.event, `${VERB[item.kind]} ${item.title}`);
  if (item.kind === 'album') {
    music.play(item, res.tracks);
  } else if (item.kind === 'movie' && res.launch.mode === 'web-video') {
    if (music.playing) music.toggle();
    openBrowserVideo(item, res.launch.url);
  } else if (item.kind === 'movie') {
    if (music.playing) music.toggle();
    openVideo(item, res.launch);
  } else if (res.launch.mode === 'builtin') {
    if (music.playing) music.toggle();
    openSnake(item);
  } else if (res.launch.mode === 'web') {
    if (music.playing) music.toggle();
    openWebGame(item, res.launch);
  } else {
    if (music.playing) music.toggle();
    openRunning(item);
  }
}

function openVideo(item, launch) {
  const native = launch.mode === 'native';
  const total = (item.minutes || 10) * 60;
  let elapsed = 0;
  let playing = true;
  let timer = null;
  let poll = null;

  openOverlay({
    className: 'full-panel player-overlay',
    render(body, layer) {
      body.innerHTML = `
        <div class="player">
          <div class="player-art">${art(item, 'wide')}</div>
          <div class="player-shade"></div>
          <div class="player-ui">
            <div class="kicker">${native ? 'Playing on your TV · VLC' : 'Now playing · demo stream'}</div>
            <h1 class="title-xl">${esc(item.title)}</h1>
            <div class="player-meta muted">${item.year || ''} · ${(item.genres || []).join(' · ')}</div>
            <div class="player-progress"><span class="num t-now">0:00</span><div class="bar"><i style="width:0"></i></div><span class="num t-total">${fmtTime(total)}</span></div>
            <div class="btn-row player-controls" data-group="controls">
              <button class="icon-btn" data-focus data-act="rew">${icon('prev', 28)}</button>
              <button class="icon-btn big" data-focus data-autofocus data-act="toggle">${icon('pause', 40)}</button>
              <button class="icon-btn" data-focus data-act="fwd">${icon('next', 28)}</button>
              <button class="icon-btn" data-focus data-act="stop">${icon('stop', 26)}</button>
            </div>
            ${native ? '' : `<p class="player-note dim">Demo mode: put <b>${esc(item.file || 'movie files')}</b> in ~/Videos or connect Jellyfin to stream the real film.</p>`}
            ${hints([['a', 'Select'], ['b', 'Stop']])}
          </div>
        </div>`;
      const bar = body.querySelector('.bar i');
      const now = body.querySelector('.t-now');
      const toggleBtn = body.querySelector('[data-act="toggle"]');
      const paint = () => {
        bar.style.width = `${(elapsed / total) * 100}%`;
        now.textContent = fmtTime(elapsed);
        toggleBtn.innerHTML = icon(playing ? 'pause' : 'play', 40);
      };
      const stop = async () => {
        clearInterval(timer);
        clearInterval(poll);
        if (native) await api.stopLauncher().catch(() => {});
      };
      if (native) {
        poll = setInterval(async () => {
          const st = await api.launcher().catch(() => null);
          if (st && !st.running) closeOverlay(layer, { silent: true });
        }, 2000);
      } else {
        timer = setInterval(() => {
          if (!playing) return;
          elapsed = Math.min(total, elapsed + 1);
          paint();
          if (elapsed >= total) closeOverlay(layer);
        }, 1000);
      }
      body.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'toggle') playing = !playing;
        if (act === 'rew') elapsed = Math.max(0, elapsed - 10);
        if (act === 'fwd') elapsed = Math.min(total, elapsed + 30);
        if (act === 'stop') return closeOverlay(layer);
        paint();
      });
      layer.onClose = stop;
      paint();
    },
  });
}

// A downloaded film streamed from the Pi into this browser (laptop).
function openBrowserVideo(item, url) {
  openOverlay({
    className: 'full-panel webgame-overlay',
    render(body, layer) {
      body.innerHTML = `
        <div class="webgame">
          <div class="webgame-screen"><video src="${esc(url)}" controls autoplay playsinline></video></div>
          <div class="webgame-bar">
            <div class="webgame-title"><b>${esc(item.title)}</b><span class="dim">${esc(String(item.year || ''))} · playing in this browser</span></div>
            <div class="webgame-keys"><span>${glyph('a')} Pause</span><span><kbd>◀ ▶</kbd> 10 s</span><span><kbd>F</kbd> Fullscreen</span><span>${glyph('b')} / <kbd>Esc</kbd> Close</span></div>
            <button class="btn small" data-act="close">${icon('x', 20)} Close</button>
          </div>
        </div>`;
      const video = body.querySelector('video');
      body.querySelector('[data-act="close"]').addEventListener('click', () => closeOverlay(layer));
      video.addEventListener('keydown', (e) => {
        if (e.key === 'f') video.requestFullscreen?.();
      });
      layer.onButton = (action) => {
        if (action === 'b' || action === 'quit') closeOverlay(layer);
        else if (action === 'a') (video.paused ? video.play() : video.pause());
        else if (action === 'left' || action === 'right') video.currentTime += action === 'right' ? 10 : -10;
        return true;
      };
      layer.onClose = () => {
        video.pause();
        video.removeAttribute('src');
        video.load();
      };
    },
  });
}

function openRunning(item) {
  // On the TV (kiosk) the game covers this screen; from a laptop browser it plays on the Pi's HDMI screen.
  const onTv = document.body.classList.contains('kiosk');
  const where = onTv
    ? 'The game is open in fullscreen. To come back here, hold <b>Start + Select</b> (or press Esc).'
    : "The game is playing on the screen connected to the Pi (HDMI). Play it there with a controller or keyboard plugged into the Pi. Press <b>B / Esc</b> here to close it.";
  openOverlay({
    className: 'full-panel player-overlay',
    render(body, layer) {
      body.innerHTML = `
        <div class="player">
          <div class="player-art">${art(item, 'wide')}</div>
          <div class="player-shade"></div>
          <div class="player-ui center">
            <div class="kicker">${esc(item.platform)} · ${onTv ? 'running on the TV' : 'running on the Pi'}</div>
            <h1 class="title-xl">${esc(item.title)}</h1>
            <p class="muted">${where}</p>
            <div class="btn-row"><button class="btn" data-focus data-autofocus data-act="stop">${icon('power', 24)} ${onTv ? 'Force quit' : 'Close game'}</button></div>
          </div>
        </div>`;
      const poll = setInterval(async () => {
        const st = await api.launcher().catch(() => null);
        if (st && !st.running) closeOverlay(layer, { silent: true });
      }, 2000);
      body.querySelector('[data-act="stop"]').addEventListener('click', () => closeOverlay(layer));
      layer.onClose = () => {
        clearInterval(poll);
        api.stopLauncher().catch(() => {});
      };
    },
  });
}

function openWebGame(item, launch) {
  const color = getComputedStyle(document.getElementById('stage')).getPropertyValue('--accent').trim();
  const src = `play.html?${new URLSearchParams({ system: launch.system, url: launch.url, name: item.title, color })}`;
  openOverlay({
    className: 'full-panel webgame-overlay',
    render(body, layer) {
      body.innerHTML = `
        <div class="webgame">
          <div class="webgame-screen">
            <iframe src="${esc(src)}" allow="autoplay; gamepad; fullscreen" title="${esc(item.title)}"></iframe>
            <div class="webgame-loading"><div class="spinner"></div><span>Starting the ${esc(item.platform)} emulator…</span></div>
          </div>
          <div class="webgame-bar">
            <div class="webgame-title"><b>${esc(item.title)}</b><span class="dim">${esc(item.platform)} · playing in this browser</span></div>
            <div class="webgame-keys">
              <span><kbd>←↑↓→</kbd> Move</span><span><kbd>Z</kbd> A</span><span><kbd>X</kbd> B</span>
              <span><kbd>Enter</kbd> Start</span><span><kbd>V</kbd> Select</span><span><kbd>Esc</kbd> Exit</span>
              <span class="dim">Controller: Start + Select to exit</span>
            </div>
            <button class="btn small" data-focus data-autofocus data-act="close">${icon('x', 20)} Exit game</button>
          </div>
        </div>`;
      const frame = body.querySelector('iframe');
      // Once the page is in, EmulatorJS shows its own download progress (and any error), so drop our spinner.
      frame.addEventListener('load', () => {
        frame.contentWindow.focus();
        body.querySelector('.webgame-loading')?.remove();
      });
      const onMessage = (e) => {
        if (e.origin !== location.origin || e.source !== frame.contentWindow) return;
        if (e.data?.type === 'apistation-exit') closeOverlay(layer);
      };
      addEventListener('message', onMessage);
      body.querySelector('[data-act="close"]').addEventListener('click', () => closeOverlay(layer));
      // The emulator reads the controller itself; the console only listens for the exit combo.
      layer.onButton = (action) => {
        if (action === 'quit') closeOverlay(layer);
        return true;
      };
      layer.onClose = () => {
        removeEventListener('message', onMessage);
        frame.src = 'about:blank';
      };
    },
  });
}

function setupSteps(item) {
  const launch = item.launch || {};
  if (launch.type === 'retroarch') {
    return [
      'Install the emulators: <code>scripts/install-emulators.sh</code>',
      `Make sure the game file is at <code>~/roms/${esc(launch.rom)}</code>`,
    ];
  }
  if (launch.exec === 'moonlight-qt') {
    return ['Install Moonlight: <code>sudo apt install moonlight-qt</code>', 'Run Sunshine on your gaming PC and pair it once'];
  }
  return [`Install it: <code>sudo apt install ${esc(launch.exec || item.id)}</code>`];
}

export function openSetupHelp(item) {
  openOverlay({
    className: 'center-panel',
    render(body, layer) {
      body.innerHTML = `
        <div class="panel setup-panel">
          <div class="setup-head"><div class="cover cover-wide">${art(item, 'wide')}</div>
            <div><div class="kicker">Almost ready</div><h2 class="title-lg">${esc(item.title)}</h2><p class="muted">${esc(item.platform)} · ${esc(item.genre)}</p></div></div>
          <ol class="setup-steps">${setupSteps(item).map((s) => `<li>${s}</li>`).join('')}</ol>
          <p class="dim">Restart the hub afterwards and the game shows up as Ready.</p>
          <div class="btn-row"><button class="btn" data-focus data-autofocus>${icon('check', 22)} Got it</button></div>
        </div>`;
      body.querySelector('.btn').addEventListener('click', () => closeOverlay(layer));
    },
  });
}
