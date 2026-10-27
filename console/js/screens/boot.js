// Boot animation, shown straight after the Pi starts the kiosk.
import { api } from '../api.js';
import { glyph } from '../icons.js';
import { go } from '../router.js';
import { enter } from '../session.js';
import { sfx } from '../sfx.js';
import { store } from '../store.js';

export default {
  hue: [265, 190],
  async mount(el) {
    el.innerHTML = `
      <div class="boot">
        <div class="boot-logo">
          <svg class="boot-ring" viewBox="0 0 200 200">
            <defs><linearGradient id="boot-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#c4b5fd"/><stop offset=".5" stop-color="#a78bfa"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs>
            <circle cx="100" cy="100" r="86" class="ring-track"/>
            <circle cx="100" cy="100" r="86" class="ring-draw" stroke="url(#boot-g)"/>
          </svg>
          <div class="boot-orbit"><i></i></div>
          <div class="boot-pi">π</div>
        </div>
        <div class="boot-word">a<b>Pi</b>Station</div>
        <div class="boot-tag">games · movies · music · smart home · cloud · AI</div>
        <div class="boot-press">${glyph('a')} Press any button</div>
        <div class="boot-status"><span class="spinner"></span><span class="boot-status-text">Connecting to hub…</span></div>
      </div>`;
    const status = el.querySelector('.boot-status-text');
    let ready = false;
    let leaving = false;

    const proceed = () => {
      if (!ready || leaving) return;
      leaving = true;
      sfx.select();
      // A remembered device goes straight in; otherwise "Who's playing?".
      if (store.session?.signed_in) enter(store.session.profile);
      else go('profiles', {}, { replace: true });
    };

    const load = (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const [health, profiles, session] = await Promise.all([api.health(), api.profiles(), api.session()]);
          store.health = health;
          store.profiles = profiles;
          store.session = session;
          status.textContent = `Hub online · ${health.ai.enabled ? 'Claude connected' : 'AI offline mode'}`;
          el.querySelector('.spinner')?.remove();
          return;
        } catch {
          status.textContent = `Waiting for hub… (${attempt + 1})`;
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
    })();

    sfx.boot();
    await Promise.all([load, new Promise((r) => setTimeout(r, 2600))]);
    ready = true;
    el.querySelector('.boot').classList.add('ready');
    const auto = setTimeout(proceed, 9000);
    el.addEventListener('click', proceed);

    return {
      onButton() {
        proceed();
        return true;
      },
      unmount() {
        clearTimeout(auto);
      },
    };
  },
};
