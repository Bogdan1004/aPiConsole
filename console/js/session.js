// Signing in and out: PIN pad for players, the read-only Guest profile, and resuming a remembered session.
import { api } from './api.js';
import { icon } from './icons.js';
import { music } from './music.js';
import { connect, disconnect } from './realtime.js';
import { go, resetHistory } from './router.js';
import { loadDrive, loadFilms, loadInbox, loadLibrary, loadMusic, loadRecs, refreshProfile, store } from './store.js';
import { celebrate, closeOverlay, esc, hints, openOverlay, toast } from './ui.js';

const PIN_LENGTH = 4;

/**
 * Number pad for a 4-digit PIN (controller, mouse or keyboard digits). `submit(pin, remember)` returns an error
 * message to show and stay open, or nothing to close. Resolves true once submitted successfully, false if closed.
 */
export function pinPad({ title, subtitle = '', remember = null, submit }) {
  return new Promise((resolve) => {
    let done = false;
    let detach = () => {};
    openOverlay({
      className: 'center-panel',
      render(body, layer) {
        let pin = '';
        let keep = remember ?? false;
        let busy = false;
        const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'back', '0', 'cancel'];
        body.innerHTML = `<div class="panel pin-panel">
          <div class="kicker">${esc(subtitle)}</div><h2 class="title-lg">${esc(title)}</h2>
          <div class="pin-dots">${'<i></i>'.repeat(PIN_LENGTH)}</div>
          <div class="pin-error"></div>
          <div class="pin-keys" data-group="keys">${keys.map((k) => `<button class="pin-key ${k.length > 1 ? 'small' : ''}" data-focus data-key="${k}">${
            k === 'back' ? icon('back', 26) : k === 'cancel' ? icon('x', 26) : k}</button>`).join('')}</div>
          ${remember === null ? '' : `<button class="setting pin-remember" data-focus data-remember>
            <span class="setting-text"><b>Remember this device</b><small>Stay signed in here for 90 days</small></span>
            <span class="switch ${keep ? 'on' : ''}"><i></i></span></button>`}
          ${hints([['a', 'Press'], ['b', 'Cancel']])}</div>`;
        const dots = [...body.querySelectorAll('.pin-dots i')];
        const errorEl = body.querySelector('.pin-error');
        const paint = () => dots.forEach((d, i) => d.classList.toggle('on', i < pin.length));
        const finish = (ok) => {
          if (done) return;
          done = true;
          detach();
          resolve(ok);
          closeOverlay(layer, { silent: true });
        };
        const press = async (key) => {
          if (busy) return;
          if (key === 'cancel') return finish(false);
          if (key === 'back') pin = pin.slice(0, -1);
          else if (pin.length < PIN_LENGTH) pin += key;
          errorEl.textContent = '';
          paint();
          if (pin.length < PIN_LENGTH) return;
          busy = true;
          const error = await submit(pin, keep);
          busy = false;
          if (!error) return finish(true);
          errorEl.textContent = error;
          body.querySelector('.pin-panel').classList.remove('shake');
          void body.offsetWidth;
          body.querySelector('.pin-panel').classList.add('shake');
          pin = '';
          paint();
        };
        body.addEventListener('click', (e) => {
          const key = e.target.closest('[data-key]')?.dataset.key;
          if (key) return press(key);
          if (e.target.closest('[data-remember]')) {
            keep = !keep;
            body.querySelector('.pin-remember .switch').classList.toggle('on', keep);
          }
          return null;
        });
        const onKey = (e) => {
          if (/^\d$/.test(e.key)) press(e.key);
          else if (e.key === 'Backspace') press('back');
          else return;
          e.preventDefault();
          e.stopPropagation();
        };
        window.addEventListener('keydown', onKey, true);
        detach = () => window.removeEventListener('keydown', onKey, true);
        // Digits typed on a paired phone.
        layer.text = (typed, submit) => {
          if (submit) [...typed].filter((ch) => /\d/.test(ch)).forEach((d) => press(d));
        };
      },
      onClose: () => {
        detach();
        if (!done) { done = true; resolve(false); }
      },
    });
  });
}

/** After signing in (or resuming a session): load everything and open Home. */
export async function enter(profile, event = null) {
  store.profile = profile;
  store.guest = profile.id === 'guest';
  connect();
  document.body.classList.toggle('guest', store.guest);
  await Promise.all([loadLibrary(), refreshProfile(), loadInbox()]);
  loadRecs().catch(() => {});
  loadFilms();
  loadMusic();
  loadDrive();
  resetHistory();
  await go('home', {}, { replace: true });
  if (store.guest) {
    toast({ icon: 'users', title: 'Welcome, guest!', text: 'Look around, play in the browser and chat. Changes are for signed-in players.', tone: 'info', duration: 6000 });
  } else if (event) {
    const welcome = `Welcome back, ${profile.name}!`;
    if (event.xp) celebrate(event, `${welcome} Day ${profile.streak} streak`);
    else toast({ icon: 'flame', title: welcome, text: `Day ${profile.streak} streak · keep it going`, tone: 'xp' });
  }
}

/** Sign in from the profile picker: Guest directly, players with their PIN (creating it the first time). */
export async function signIn(p) {
  if (p.guest) {
    const event = await api.login('guest');
    return enter(event.profile, event);
  }
  if (!p.has_pin) {
    let first = null;
    const created = await pinPad({
      title: `Create a PIN for ${p.name}`,
      subtitle: first ? 'Type it again' : 'Protects your profile, files and settings',
      submit: async (pin) => {
        if (!first) {
          first = pin;
          document.querySelector('.pin-panel .kicker').textContent = 'Type it again to confirm';
          return 'Now type it again';
        }
        if (pin !== first) {
          first = null;
          document.querySelector('.pin-panel .kicker').textContent = 'Protects your profile, files and settings';
          return "The two PINs didn't match. Start again.";
        }
        try {
          await api.setPin(p.id, pin);
        } catch (err) {
          return err.message;
        }
        p.has_pin = true;
        return null;
      },
    });
    if (!created) return null;
    toast({ icon: 'lock', title: 'PIN saved', text: 'Use it to sign in from now on.', tone: 'info' });
  }
  let event = null;
  const ok = await pinPad({
    title: p.name,
    subtitle: 'Enter your PIN',
    remember: true,
    submit: async (pin, remember) => {
      try {
        event = await api.login(p.id, pin, remember);
        return null;
      } catch (err) {
        return err.message;
      }
    },
  });
  return ok ? enter(event.profile, event) : null;
}

/** Signs out and goes back to the profile picker. */
export async function signOut() {
  music.stop();
  disconnect();
  try { await api.logout(); } catch { /* already signed out */ }
  store.profile = null;
  store.guest = false;
  document.body.classList.remove('guest');
  resetHistory();
  return go('profiles', {}, { replace: true });
}

/** Change the signed-in player's PIN (current PIN, new PIN, confirm). */
export async function changePin() {
  let old = null;
  let fresh = null;
  const ok = await pinPad({
    title: 'Change PIN',
    subtitle: 'Enter your current PIN',
    submit: async (pin) => {
      const kicker = document.querySelector('.pin-panel .kicker');
      if (old === null) {
        old = pin;
        kicker.textContent = 'Now the new PIN';
        return 'Current PIN noted';
      }
      if (fresh === null) {
        fresh = pin;
        kicker.textContent = 'Type the new PIN again';
        return 'New PIN noted';
      }
      if (pin !== fresh) {
        fresh = null;
        kicker.textContent = 'Now the new PIN';
        return "The new PINs didn't match. Type the new PIN again.";
      }
      try {
        await api.setPin(store.profile.id, fresh, old);
        return null;
      } catch (err) {
        old = null;
        fresh = null;
        kicker.textContent = 'Enter your current PIN';
        return err.message;
      }
    },
  });
  if (ok) toast({ icon: 'lock', title: 'PIN changed', text: 'Other devices were signed out.', tone: 'info' });
}
