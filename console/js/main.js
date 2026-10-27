// aPiStation console bootstrap.
import { lastSource, onAction } from './input.js';
import { getFocused, move } from './focus.js';
import * as router from './router.js';
import { closeOverlay, topOverlay, toast } from './ui.js';
import { initNowPlaying, openQuickMenu } from './chrome.js';
import { music } from './music.js';
import { sfx } from './sfx.js';
import { api } from './api.js';
import { enter, signOut } from './session.js';
import { on, store } from './store.js';

import boot from './screens/boot.js';
import profiles from './screens/profiles.js';
import home from './screens/home.js';
import movies from './screens/movies.js';
import musicScreen from './screens/music.js';
import games from './screens/games.js';
import smarthome from './screens/smarthome.js';
import drive from './screens/drive.js';
import ai from './screens/ai.js';
import friends from './screens/friends.js';
import trophies from './screens/trophies.js';
import settings from './screens/settings.js';
import gameStore from './screens/store.js';

const SCREENS = { boot, profiles, home, movies, music: musicScreen, games, store: gameStore, smarthome, drive, ai, friends, trophies, settings };
Object.entries(SCREENS).forEach(([name, mod]) => router.register(name, mod));

// ---------- fit the 1920×1080 stage to any screen ----------
function fit() {
  const scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
  document.getElementById('stage').style.setProperty('--scale', scale);
}
window.addEventListener('resize', fit);
fit();

// ---------- background: drifting stars + film grain ----------
function initBackground() {
  const canvas = document.getElementById('stars');
  const ctx = canvas.getContext('2d');
  const stars = Array.from({ length: 140 }, () => ({
    x: Math.random() * 960, y: Math.random() * 540, z: 0.2 + Math.random() * 0.8, p: Math.random() * 6.28,
  }));
  let last = 0;
  const loop = (t) => {
    if (!store.settings.performance && !document.hidden) {
      if (t - last > 33) {
        last = t;
        ctx.clearRect(0, 0, 960, 540);
        for (const s of stars) {
          s.x -= s.z * 0.12;
          if (s.x < 0) s.x += 960;
          const a = 0.25 + 0.75 * s.z * (0.6 + 0.4 * Math.sin(t / 700 + s.p));
          ctx.fillStyle = `rgba(255,255,255,${a.toFixed(2)})`;
          const size = s.z * 1.5;
          ctx.fillRect(s.x, s.y, size, size);
        }
      }
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  const grain = document.createElement('canvas');
  grain.width = grain.height = 160;
  const g = grain.getContext('2d');
  const img = g.createImageData(160, 160);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  document.querySelector('#bg .grain').style.backgroundImage = `url(${grain.toDataURL()})`;

  const applyPerf = () => document.body.classList.toggle('perf', !!store.settings.performance);
  applyPerf();
  on('settings', applyPerf);
}
initBackground();
initNowPlaying();

// ---------- input dispatch ----------
function activate() {
  const el = getFocused();
  if (!el) return;
  if (el.dataset.sound !== 'none') sfx.select();
  // Text fields: a keyboard types straight in, a gamepad gets the on-screen keyboard (via click).
  if (el.tagName === 'INPUT' && lastSource !== 'gamepad') el.focus();
  else el.click();
}

function defaultAction(action) {
  if (['up', 'down', 'left', 'right'].includes(action)) {
    if (!move(action)) {
      const el = getFocused();
      el?.classList.add('bump');
      setTimeout(() => el?.classList.remove('bump'), 200);
    }
    return;
  }
  if (action === 'a') return activate();
  if (action === 'b') return router.back();
}

function globalAction(action) {
  if (!store.profile) return false;
  if (action === 'start') { openQuickMenu(); return true; }
  if (action === 'y' && router.current()?.name !== 'ai') { router.go('ai'); return true; }
  if (action === 'select' && music.album) { music.toggle(); sfx.toggle(music.playing); return true; }
  if (action === 'lb' && music.album) { music.prev(); return true; }
  if (action === 'rb' && music.album) { music.next(); return true; }
  return false;
}

onAction((action) => {
  const layer = topOverlay();
  if (layer) {
    if (layer.onButton?.(action)) return;
    if (action === 'b') return closeOverlay(layer);
    return defaultAction(action);
  }
  const ctrl = router.current()?.ctrl;
  if (ctrl?.onButton?.(action)) return;
  if (globalAction(action)) return;
  defaultAction(action);
});

on('gamepad', ({ connected, id }) => {
  toast({ icon: 'gamepad', title: connected ? 'Controller connected' : 'Controller disconnected', text: id.split('(')[0].trim(), tone: connected ? 'info' : 'muted' });
});

// Dev shortcut: ?profile=bogdan&screen=movies skips boot when this browser is already signed in as that profile.
async function quickStart(pid, screen) {
  const [health, profiles, session] = await Promise.all([api.health(), api.profiles(), api.session()]);
  Object.assign(store, { health, profiles, session });
  if (session.profile?.id !== pid) return router.go('profiles', {}, { replace: true });
  await enter(session.profile);
  if (screen) await router.go(screen, {}, { replace: true });
  return null;
}

// The hub refused a request: the session ended (back to the profiles) or a guest tried to change something.
window.addEventListener('apistation:auth', ({ detail }) => {
  if (detail.code === 'signin' && store.profile) {
    toast({ icon: 'lock', title: 'Signed out', text: 'Your session ended. Sign in again.', tone: 'muted' });
    signOut();
  } else if (detail.code === 'guest') {
    toast({ icon: 'lock', title: 'Guest mode', text: detail.message, tone: 'muted' });
  } else if (detail.code === 'rate') {
    toast({ icon: 'clock', title: 'Slow down a little', text: detail.message, tone: 'muted' });
  }
});

const params = new URLSearchParams(location.search);
// The kiosk launcher opens ?kiosk=1: no mouse pointer on the TV.
document.body.classList.toggle('kiosk', params.has('kiosk'));
if (params.get('profile')) quickStart(params.get('profile'), params.get('screen'));
else router.go('boot');
