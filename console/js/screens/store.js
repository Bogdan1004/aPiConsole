// Game Store: browse free games, download them in the background, play or delete installed ones.
import { api } from '../api.js';
import { art, cover } from '../art.js';
import { mountTopbar } from '../chrome.js';
import { focus, focusables, getFocused } from '../focus.js';
import { deleteGame, fmtSize, installGame, isActive, watchJobs } from '../gamestore.js';
import { icon } from '../icons.js';
import { playItem } from '../playback.js';
import { findItem, loadLibrary, on, store } from '../store.js';
import { closeOverlay, esc, hints, openOverlay } from '../ui.js';

const FILTERS = [
  ['all', 'grid', 'All games'],
  ['retro', 'gamepad', 'Retro'],
  ['pc', 'cpu', 'PC games'],
  ['installed', 'check', 'Installed'],
];
const matches = (g, f) => f === 'all' || (f === 'retro' ? g.install_type === 'rom' : f === 'pc' ? g.install_type === 'apt' : g.installed);

function badge(g) {
  if (isActive(g.job)) return `${icon('download', 15)} ${Math.round(g.job.progress * 100)}%`;
  if (g.installed) return `${icon('check', 15)} Installed`;
  return fmtSize(g.size_mb);
}

function card(g) {
  return `<button class="card browse-card browse-wide store-card ${g.installed ? 'installed' : ''}" data-focus data-id="${esc(g.id)}">
    <span class="badge-corner">${badge(g)}</span>
    ${cover(g, 'wide')}
    <span class="card-progress ${isActive(g.job) ? '' : 'is-hidden'}"><i style="width:${(g.job?.progress || 0) * 100}%"></i></span>
    <div class="card-label">${esc(g.title)}</div>
    <div class="card-sub">${esc(g.platform)} · ${esc(g.genre)}</div>
  </button>`;
}

function actions(g, pcEnabled) {
  const needsSetup = g.install_type === 'apt' && !pcEnabled;
  if (isActive(g.job)) {
    return `<div class="install-progress">
      <div class="bar"><i style="width:${g.job.progress * 100}%"></i></div>
      <span class="num">${Math.round(g.job.progress * 100)}%</span>
      <span class="dim">${esc(g.job.message || '')}</span>
    </div>`;
  }
  if (g.installed) {
    return `<button class="btn primary" data-focus data-act="play">${icon('play', 24)} Play</button>
      <button class="btn" data-focus data-act="${needsSetup ? 'setup' : 'delete'}">${icon('trash', 22)} Delete</button>`;
  }
  if (needsSetup) return `<button class="btn primary" data-focus data-act="setup">${icon('lock', 22)} One-time setup needed</button>`;
  return `<button class="btn primary" data-focus data-act="install">${icon('download', 24)} Download · ${fmtSize(g.size_mb)}</button>`;
}

// PC games are installed with apt, which needs a small root helper set up once with sudo.
function openSetupInfo() {
  openOverlay({
    className: 'center-panel',
    render(body, layer) {
      body.innerHTML = `
        <div class="panel setup-panel">
          <div class="panel-head">${icon('lock', 30)}<div><h2>One-time setup for PC games</h2><p>Retro games download right away; PC games are installed with apt.</p></div></div>
          <ol class="setup-steps">
            <li>Open a terminal on the Pi (or SSH from your laptop)</li>
            <li>Run <code>sudo ~/aPiConsole/kiosk/setup-store.sh</code> and type your password</li>
            <li>Come back here: Download now works for every PC game</li>
          </ol>
          <p class="dim">The helper can only install or remove the game packages listed in the Store, nothing else.</p>
          <div class="btn-row"><button class="btn" data-focus data-autofocus>${icon('check', 22)} Got it</button></div>
        </div>`;
      body.querySelector('.btn').addEventListener('click', () => closeOverlay(layer));
    },
  });
}

export default {
  hue: [196, 150],
  async mount(el, params = {}) {
    let games = store.storeGames;
    let pcEnabled = true;
    try {
      const data = await api.storeCatalog();
      games = data.games;
      pcEnabled = data.pc_enabled;
    } catch { /* use what login loaded */ }
    let filter = params.filter || 'all';
    let current = null;

    el.innerHTML = `
      <div class="backdrop"></div>
      <div class="browse-info store-info"></div>
      <div class="store-filters" data-group="filters">
        ${FILTERS.map(([id, ic, label]) => `<button class="chip-btn" data-focus data-filter="${id}">${icon(ic, 20)} ${label}</button>`).join('')}
        <span class="store-note dim">${icon('heart', 18)} Free and legal: open-source PC games and homebrew made for retro consoles</span>
      </div>
      <div class="browse-shelf store-shelf">
        <div class="row-title"></div>
        <div class="shelf" data-group="shelf" data-scroll="x"></div>
      </div>
      ${hints([['a', 'Select'], ['b', 'Back']])}`;
    const cleanup = mountTopbar(el, 'Store');
    const backdrop = el.querySelector('.backdrop');
    const info = el.querySelector('.store-info');
    const shelf = el.querySelector('.shelf');
    const shelfTitle = el.querySelector('.store-shelf .row-title');

    const renderInfo = () => {
      const g = current;
      const kind = g.install_type === 'rom' ? 'Plays on the TV and in a laptop browser' : 'Runs on the Pi';
      info.innerHTML = `
        <div class="kicker">${esc(g.platform)} · ${esc(g.genre)}</div>
        <h1 class="title-xl">${esc(g.title)}</h1>
        <div class="meta-line">
          <span>${icon('user', 18)} ${esc(g.developer)}</span>
          ${g.players ? `<span>${icon('users', 18)} ${esc(g.players)} players</span>` : ''}
          <span>${icon(g.controls && !g.controls.includes('Controller') ? 'keyboard' : 'gamepad', 18)} ${esc(g.controls || 'Controller')}</span>
        </div>
        <p class="browse-desc muted">${esc(g.description)}</p>
        <div class="tags">
          <span class="tag">${esc(g.license)}</span>
          <span class="tag">${fmtSize(g.size_mb)}</span>
          <span class="tag">${kind}</span>
          ${g.installed ? `<span class="tag ok">${icon('check', 16)} Installed</span>` : ''}
        </div>
        <div class="btn-row store-actions" data-group="actions" data-enter="first">${actions(g, pcEnabled)}</div>
        <p class="store-credit dim">Screenshot: ${esc(g.cover_src || 'official')}</p>`;
    };

    const show = (g) => {
      if (!g) return;
      const changed = current?.id !== g.id;
      current = g;
      if (changed) backdrop.innerHTML = `<div class="backdrop-art fade-in">${g.poster ? cover(g, 'wide') : art(g, 'wide')}</div>`;
      renderInfo();
    };

    const renderShelf = () => {
      const list = games.filter((g) => matches(g, filter));
      const label = FILTERS.find(([id]) => id === filter)[2];
      shelfTitle.innerHTML = `${icon('bag', 26)} ${label} <small>${list.length}</small>`;
      shelf.innerHTML = list.map(card).join('') || '<div class="empty">Nothing here yet. Download something from All games.</div>';
      shelf.scrollLeft = 0;
      el.querySelectorAll('[data-filter]').forEach((b) => b.classList.toggle('active', b.dataset.filter === filter));
      return list;
    };

    // Live progress: patch the card and the action area in place so focus isn't lost.
    const offJobs = on('store-jobs', (jobs) => {
      for (const job of jobs) {
        const g = games.find((x) => x.id === job.id);
        if (!g) continue;
        const wasActive = isActive(g.job);
        g.job = job;
        if (!isActive(job) && job.state === 'done') g.installed = job.action === 'install';
        const cardEl = shelf.querySelector(`[data-id="${CSS.escape(g.id)}"]`);
        if (cardEl) {
          cardEl.querySelector('.badge-corner').innerHTML = badge(g);
          cardEl.querySelector('.card-progress').classList.toggle('is-hidden', !isActive(job));
          cardEl.querySelector('.card-progress i').style.width = `${job.progress * 100}%`;
          cardEl.classList.toggle('installed', g.installed);
        }
        if (current?.id !== g.id) continue;
        const bar = info.querySelector('.install-progress');
        if (isActive(job) && bar) {
          bar.querySelector('.bar i').style.width = `${job.progress * 100}%`;
          bar.querySelector('.num').textContent = `${Math.round(job.progress * 100)}%`;
          bar.querySelector('.dim').textContent = job.message || '';
        } else if (isActive(job) !== wasActive || !isActive(job)) {
          const hadFocus = info.contains(getFocused());
          renderInfo();
          if (hadFocus) focus(focusables(info)[0] || shelf.querySelector(`[data-id="${CSS.escape(g.id)}"]`), { silent: true });
        }
      }
    });

    el.addEventListener('focused', (e) => {
      const c = e.target.closest('.store-card');
      if (c) show(games.find((g) => g.id === c.dataset.id));
    });

    el.addEventListener('click', async (e) => {
      const f = e.target.closest('[data-filter]');
      if (f) {
        filter = f.dataset.filter;
        const list = renderShelf();
        if (list[0]) show(list[0]);
        return;
      }
      if (e.target.closest('.store-card')) {
        // On a card, A jumps to the main action for that game.
        const first = focusables(info)[0];
        if (first) focus(first);
        return;
      }
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act || !current) return;
      if (act === 'setup') return openSetupInfo();
      if (act === 'install') {
        const job = await installGame(current);
        if (job) { current.job = job; renderInfo(); }
      } else if (act === 'delete') {
        await deleteGame({ ...current, source: 'store' });
      } else if (act === 'play') {
        if (!findItem('game', current.id)) await loadLibrary();
        const item = findItem('game', current.id);
        if (item) playItem(item);
      }
    });

    const list = renderShelf();
    const start = list.find((g) => g.id === params.focus) || list.find((g) => g.featured && !g.installed) || list[0];
    show(start);
    focus(shelf.querySelector(`[data-id="${CSS.escape(start.id)}"]`), { silent: true });
    if (games.some((g) => isActive(g.job))) watchJobs();

    return {
      unmount() {
        cleanup();
        offJobs();
      },
    };
  },
};
