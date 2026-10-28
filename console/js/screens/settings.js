// Settings: sound, performance, profile, and an "about" panel with hub, service and control info.
import { mountTopbar } from '../chrome.js';
import { focus, getFocused } from '../focus.js';
import { glyph, icon } from '../icons.js';
import { go } from '../router.js';
import { changePin, signOut } from '../session.js';
import { sfx } from '../sfx.js';
import { saveSettings, store } from '../store.js';
import { esc, hints } from '../ui.js';

const CONTROLS = [
  ['Move', 'Arrow keys', 'D-pad / stick'],
  ['Select', 'Enter', glyph('a')],
  ['Back', 'Esc / Backspace', glyph('b')],
  ['Share', 'X', glyph('x')],
  ['Ask Claude', 'Y', glyph('y')],
  ['Menu', 'M', glyph('start')],
  ['Play / pause music', 'V', glyph('select')],
  ['Previous / next track', 'Q / E', `${glyph('lb')} ${glyph('rb')}`],
];

export default {
  hue: [228, 265],
  async mount(el) {
    el.innerHTML = `
      <div class="settings-list" data-group="settings"></div>
      <div class="settings-side">
        <div class="panel about"></div>
        <div class="panel controls-help">
          <div class="row-title">${icon('gamepad', 26)} Controls</div>
          <table>${CONTROLS.map(([a, k, g]) => `<tr><td>${a}</td><td class="dim">${k}</td><td>${g}</td></tr>`).join('')}</table>
        </div>
      </div>
      ${hints([['a', 'Toggle'], ['b', 'Back']])}`;
    const cleanup = mountTopbar(el, 'Settings');
    const list = el.querySelector('.settings-list');
    const h = store.health || {};

    el.querySelector('.about').innerHTML = `
      <div class="about-head"><span class="brand-mark">π</span><div><h2 class="title-lg">aPiStation</h2><div class="dim">version ${esc(h.version || '0.1.0')} · role “${esc(h.role || 'all')}”</div></div></div>
      <div class="about-rows">
        <div><span>Claude</span><b>${h.ai?.enabled ? esc(h.ai.model) : 'Offline oracle — add ANTHROPIC_API_KEY to hub/.env'}</b></div>
        <div><span>Movies</span><b>${esc(h.services?.movies || '—')}</b></div>
        <div><span>Music</span><b>${esc(h.services?.music || '—')}</b></div>
        <div><span>Smart home</span><b>${esc(h.services?.home || '—')}</b></div>
        <div><span>Hub</span><b>${esc(location.host)}</b></div>
      </div>`;

    const slider = (key, ic, title, sub) => {
      const v = store.settings[key];
      return `<button class="setting" data-focus data-slider="${key}">
        <span class="setting-icon">${icon(ic, 26)}</span>
        <span class="setting-text"><b>${title}</b><small>${sub} <span class="dim">◀ ▶</span></small></span>
        <span class="slider-track"><i style="width:${v * 100}%"></i></span><span class="num setting-val">${Math.round(v * 100)}%</span>
      </button>`;
    };
    const paint = () => {
      const focusedKey = getFocused()?.dataset.slider || getFocused()?.dataset.act;
      const perf = store.settings.performance;
      list.innerHTML = `
        <div class="row-title">${icon('sliders', 26)} Console</div>
        ${slider('sfx', 'volume', 'Sound effects', 'Menu sounds and celebrations')}
        ${slider('music', 'music', 'Music volume', 'Albums and the chiptune synth')}
        <button class="setting" data-focus data-act="performance">
          <span class="setting-icon">${icon('zap', 26)}</span>
          <span class="setting-text"><b>Performance mode</b><small>Turns off the animated background for smoother menus</small></span>
          <span class="switch ${perf ? 'on' : ''}"><i></i></span>
        </button>
        <div class="row-title">${icon('user', 26)} Profile</div>
        <button class="setting" data-focus data-act="switch">
          <span class="setting-icon">${icon('users', 26)}</span>
          <span class="setting-text"><b>Sign out / switch profile</b><small>Signed in as ${esc(store.profile.name)}${store.guest ? ' (read-only demo)' : ''}</small></span>${icon('chevronRight', 26)}
        </button>
        ${store.guest ? '' : `<button class="setting" data-focus data-act="monitor">
          <span class="setting-icon">${icon('chart', 26)}</span>
          <span class="setting-text"><b>System monitor</b><small>Pi health over time, devices online and the security log</small></span>${icon('chevronRight', 26)}
        </button>`}
        ${store.guest ? '' : `<button class="setting" data-focus data-act="pin">
          <span class="setting-icon">${icon('lock', 26)}</span>
          <span class="setting-text"><b>Change PIN</b><small>Signs out your other devices</small></span>${icon('chevronRight', 26)}
        </button>`}
        <button class="setting" data-focus data-act="reload">
          <span class="setting-icon">${icon('refresh', 26)}</span>
          <span class="setting-text"><b>Restart console</b><small>Reloads the interface, the hub keeps running</small></span>${icon('chevronRight', 26)}
        </button>`;
      const again = focusedKey && list.querySelector(`[data-slider="${focusedKey}"], [data-act="${focusedKey}"]`);
      focus(again || list.querySelector('[data-focus]'), { silent: true, scroll: false });
    };

    list.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'performance') {
        saveSettings({ performance: !store.settings.performance });
        sfx.toggle(store.settings.performance);
        paint();
      }
      if (act === 'switch') signOut();
      if (act === 'pin') changePin();
      if (act === 'monitor') go('monitor');
      if (act === 'reload') location.reload();
    });

    paint();
    return {
      onButton(action) {
        const key = getFocused()?.dataset.slider;
        if (key && (action === 'left' || action === 'right')) {
          const v = Math.round(Math.max(0, Math.min(1, store.settings[key] + (action === 'right' ? 0.1 : -0.1))) * 10) / 10;
          saveSettings({ [key]: v });
          sfx.move();
          paint();
          return true;
        }
        return false;
      },
      unmount: cleanup,
    };
  },
};
