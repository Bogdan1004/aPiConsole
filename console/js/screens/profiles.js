// "Who's playing?" — profile select with level rings.
import { api } from '../api.js';
import { ring } from '../chrome.js';
import { icon } from '../icons.js';
import { setTheme } from '../router.js';
import { signIn } from '../session.js';
import { store } from '../store.js';
import { esc, hints, toast } from '../ui.js';

export default {
  hue: [265, 190],
  async mount(el) {
    try {
      store.profiles = await api.profiles();
    } catch { /* keep what boot loaded */ }
    el.innerHTML = `
      <div class="profiles">
        <div class="brand big"><span class="brand-mark">π</span><span class="brand-word">a<b>Pi</b>Station</span></div>
        <h1 class="display">Who's playing?</h1>
        <div class="profile-row" data-group="profiles">
          ${store.profiles.map((p, i) => `
            <button class="profile-card ${p.guest ? 'guest' : ''}" data-focus ${i === 0 ? 'data-autofocus' : ''} data-id="${p.id}" style="--hue:${p.hue}">
              ${ring(p, 230)}
              <span class="pf-name">${esc(p.name)} ${p.guest ? '' : `<span class="pf-lock">${icon(p.has_pin ? 'lock' : 'unlock', 22)}</span>`}</span>
              <span class="pf-meta">${p.guest ? 'Look around · no PIN' : `Level ${p.level} · ${esc(p.title)}`}</span>
              <span class="pf-stats">${p.guest ? `<span>${icon('sparkles', 20)} Demo mode</span>` : `
                <span>${icon('flame', 20)} ${p.streak}</span>
                <span>${icon('trophy', 20)} ${p.trophies.total}</span>
                ${p.unread ? `<span class="pf-unread">${icon('inbox', 20)} ${p.unread}</span>` : ''}`}
              </span>
            </button>`).join('')}
        </div>
        ${hints([['a', 'Sign in']])}
      </div>`;

    el.addEventListener('focused', (e) => {
      const p = store.profiles.find((x) => x.id === e.target.dataset.id);
      if (p) setTheme(p.hue, p.hue + 70);
    });

    let busy = false;
    el.addEventListener('click', async (e) => {
      const card = e.target.closest('.profile-card');
      if (!card || busy) return;
      busy = true;
      card.classList.add('chosen');
      try {
        await signIn(store.profiles.find((p) => p.id === card.dataset.id));
      } catch (err) {
        toast({ icon: 'x', title: 'Could not sign in', text: err.message, tone: 'error' });
      }
      busy = false;
      card.classList.remove('chosen');
    });
    return {};
  },
};
