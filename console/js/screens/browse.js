// Shared layout for Movies and Games: big backdrop + details on top, a shelf of covers below.
import { art, cover } from '../art.js';
import { mountTopbar, openShare } from '../chrome.js';
import { focus } from '../focus.js';
import { icon } from '../icons.js';
import { playItem } from '../playback.js';
import { go } from '../router.js';
import { friendOf, store } from '../store.js';
import { esc, hints } from '../ui.js';

/**
 * opts: { crumb, aspect, items(), kicker(item), meta(item), tags(item), description(item),
 *         status(item) → {label, tone}, shelfTitle, askPrompt(item) }
 */
// Laptop browsers get "Play here" (EmulatorJS) plus "Play on TV" (RetroArch on the Pi); the TV gets one Play.
function playButtons(item, status) {
  const kiosk = document.body.classList.contains('kiosk');
  if (item.kind === 'game' && item.web && !kiosk) {
    return `<button class="btn primary" data-focus data-act="play-here">${icon('play', 24)} Play here</button>
      ${item.available ? `<button class="btn" data-focus data-act="play-tv">${icon('tv', 22)} Play on TV</button>` : ''}`;
  }
  const install = item.kind === 'game' && !item.available && !item.web;
  return `<button class="btn primary" data-focus data-act="play">${icon('play', 24)} ${install ? 'How to install' : 'Play'}</button>`;
}

export function browseScreen(opts) {
  return {
    hue: opts.hue,
    async mount(el, params = {}) {
      const items = opts.items();
      const picks = new Set((store.recs?.picks || []).map((p) => p.item_id));
      el.innerHTML = `
        <div class="backdrop"></div>
        <div class="browse-info"></div>
        <div class="browse-shelf">
          <div class="row-title">${icon(opts.shelfTitle[0], 26)} ${opts.shelfTitle[1]} <small>${items.length}</small></div>
          <div class="shelf" data-group="shelf" data-scroll="x">
            ${items.map((it) => `<button class="card browse-card browse-${opts.aspect}" data-focus data-id="${esc(it.id)}">
              ${picks.has(it.id) ? `<span class="badge-corner">${icon('sparkles', 16)} Pick</span>` : ''}
              ${cover(it, opts.aspect)}
              <div class="card-label">${esc(it.title)}</div>
            </button>`).join('')}
            ${opts.shelfTail || ''}
          </div>
        </div>
        ${hints([['a', 'Play'], ['x', 'Share'], ['y', 'Ask Claude'], ['b', 'Back']])}`;
      const cleanup = mountTopbar(el, opts.crumb);
      const backdrop = el.querySelector('.backdrop');
      const info = el.querySelector('.browse-info');
      const friend = friendOf(store.profile.id);
      let current = null;
      let timer = null;

      const show = (item) => {
        if (current === item) return;
        current = item;
        const status = opts.status?.(item);
        backdrop.innerHTML = `<div class="backdrop-art fade-in">${item.poster ? cover(item, 'wide') : art(item, 'wide')}</div>`;
        info.innerHTML = `
          <div class="kicker">${esc(opts.kicker(item))}</div>
          <h1 class="title-xl">${esc(item.title)}</h1>
          <div class="meta-line">${opts.meta(item).filter(Boolean).map((m) => `<span>${m}</span>`).join('')}</div>
          <p class="browse-desc muted">${esc(opts.description(item))}</p>
          <div class="tags">${(opts.tags(item) || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}
            ${status ? `<span class="tag ${status.tone}">${status.label}</span>` : ''}
            ${picks.has(item.id) ? `<span class="tag accent">${icon('sparkles', 16)} Picked for you</span>` : ''}</div>
          <div class="btn-row" data-group="actions" data-enter="first">
            ${playButtons(item, status)}
            ${friend ? `<button class="btn" data-focus data-act="share">${icon('share', 22)} Share with ${esc(friend.name)}</button>` : ''}
            <button class="btn" data-focus data-act="ask">${icon('sparkles', 22)} Ask Claude</button>
            ${opts.extraButtons?.(item) || ''}
          </div>`;
      };

      el.addEventListener('focused', (e) => {
        const card = e.target.closest('.browse-card');
        if (!card) return;
        clearTimeout(timer);
        timer = setTimeout(() => show(items.find((it) => it.id === card.dataset.id)), 70);
      });
      el.addEventListener('click', (e) => {
        const card = e.target.closest('.browse-card');
        if (card) return playItem(items.find((it) => it.id === card.dataset.id));
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'play') playItem(current);
        if (act === 'play-here') playItem(current, 'here');
        if (act === 'play-tv') playItem(current, 'tv');
        if (act === 'share') openShare(current);
        if (act === 'ask') go('ai', { prompt: opts.askPrompt(current) });
        if (act) opts.onAct?.(act, current);
      });

      const start = items.find((it) => it.id === params.focus) || items[0];
      show(start);
      focus(el.querySelector(`.browse-card[data-id="${CSS.escape(start.id)}"]`), { silent: true });

      return {
        onButton(action) {
          if (action === 'x' && current) { openShare(current); return true; }
          if (action === 'y' && current) { go('ai', { prompt: opts.askPrompt(current) }); return true; }
          return false;
        },
        unmount() {
          cleanup();
          clearTimeout(timer);
        },
      };
    },
  };
}
