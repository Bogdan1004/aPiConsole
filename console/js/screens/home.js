// Home: PS5-style tile row, a hero that changes with the selected tile, and a contextual shelf.
import { api } from '../api.js';
import { avatar, cover } from '../art.js';
import { mountTopbar, openQuests, ring } from '../chrome.js';
import { focus, focusables, getFocused } from '../focus.js';
import { icon } from '../icons.js';
import { music } from '../music.js';
import { playItem, playSongs } from '../playback.js';
import { go, setTheme } from '../router.js';
import { signOut } from '../session.js';
import { findItem, friendOf, loadRecs, on, saveSettings, store } from '../store.js';
import { celebrate, esc, fmtBytes, hints, timeAgo, toast } from '../ui.js';

const KIND_SCREEN = { movie: 'movies', album: 'music', game: 'games' };

const TILES = [
  { id: 'foryou', label: 'For You', icon: 'sparkles', hue: [262, 190], screen: 'ai' },
  { id: 'games', label: 'Games', icon: 'gamepad', hue: [290, 330], screen: 'games' },
  { id: 'store', label: 'Store', icon: 'bag', hue: [196, 150], screen: 'store' },
  { id: 'movies', label: 'Movies', icon: 'film', hue: [8, 330], screen: 'movies' },
  { id: 'music', label: 'Music', icon: 'music', hue: [155, 195], screen: 'music' },
  { id: 'home', label: 'Smart Home', icon: 'home', hue: [36, 12], screen: 'smarthome' },
  { id: 'friends', label: 'Friends', icon: 'users', hue: [330, 285], screen: 'friends' },
  { id: 'drive', label: 'Cloud Drive', icon: 'cloud', hue: [205, 245], screen: 'drive' },
  { id: 'trophies', label: 'Trophies', icon: 'trophy', hue: [44, 18], screen: 'trophies' },
  { id: 'settings', label: 'Settings', icon: 'sliders', hue: [228, 265], screen: 'settings' },
];

let lastTile = 'foryou';
let systemCache = null;
// Selected shelf tab per tile (only Movies has tabs), remembered between visits.
const shelfTabs = { movies: 'top', music: 'picks' };

function card(item, extra = '') {
  return `<button class="card home-card" data-focus data-kind="${item.kind}" data-id="${esc(item.id)}">
    ${extra}${cover(item, 'wide')}
    <div class="card-label">${esc(item.title)}</div>
    <div class="card-sub">${esc(item.kind === 'album' ? item.artist : item.kind === 'game' ? item.platform : `${item.year} · ${(item.genres || []).join(', ')}`)}</div>
  </button>`;
}

function iconCard(id, ic, title, sub, hue, attrs = '') {
  return `<button class="card home-card" data-focus data-act="${id}" ${attrs}>
    <div class="cover cover-wide icon-cover" style="--ch:${hue}">${icon(ic, 64, 1.5)}</div>
    <div class="card-label">${esc(title)}</div><div class="card-sub">${esc(sub)}</div>
  </button>`;
}

// Films from the internet catalog (Cinemeta), opened in the Movies screen.
function filmCard(film, badge, sub) {
  return `<button class="card home-card" data-focus data-act="film:${esc(film.id)}">
    ${badge ? `<span class="badge-corner">${badge}</span>` : ''}${cover({ ...film, poster_fit: 'contain' }, 'wide')}
    <div class="card-label">${esc(film.title)}</div><div class="card-sub">${esc(sub)}</div>
  </button>`;
}

const empty = (text) => `<div class="empty">${esc(text)}</div>`;

/** Claude's top picks first, then what is popular right now, as on Browse movies. */
function topFilms() {
  const seen = new Set();
  const popular = store.filmRows.find((r) => r.id === 'popular')?.items || [];
  return [...(store.filmPicks?.top || []), ...popular].filter((f) => !seen.has(f.id) && seen.add(f.id)).slice(0, 24);
}

// Songs from the internet catalog: A plays the song and the rest of its list, then the endless radio.
function songCard(song, list, badge, sub) {
  return `<button class="card home-card" data-focus data-act="song:${list}:${esc(song.id)}">
    ${badge ? `<span class="badge-corner">${badge}</span>` : ''}${cover({ ...song, poster_fit: 'contain' }, 'wide')}
    <div class="card-label">${esc(song.title)}</div><div class="card-sub">${esc(sub)}</div>
  </button>`;
}

const songLists = () => ({
  picks: store.musicPicks?.tracks || [],
  history: store.musicRows.find((r) => r.id === 'history')?.items || [],
});

const HISTORY_BADGE = { 1: ['thumbUp', 'Liked'], '-1': ['thumbDown', 'Disliked'] };

const fan = (items, aspect) => `<div class="fan fan-${aspect}">${items.slice(0, 3).map((it, i) => `<div class="fan-item f${i}">${cover(it, aspect)}</div>`).join('')}</div>`;

// Each tile describes its hero (left text + right visual), its buttons and its shelf.
const VIEWS = {
  foryou() {
    const recs = store.recs;
    const items = (recs?.picks || []).map((p) => findItem(p.kind, p.item_id)).filter(Boolean);
    const online = store.health?.ai?.enabled && !store.guest; // guests never use Claude
    return {
      kicker: online ? 'Claude · personal picks' : 'Personal picks',
      title: recs?.headline || 'Finding something good…',
      desc: items[0] ? recs.picks[0].reason : 'Your AI companion looks at what you watched, played and listened to, and builds tonight\'s lineup.',
      chips: [online ? `${icon('sparkles', 18)} ${store.health.ai.model}` : `${icon('sparkles', 18)} Add an API key to unlock Claude`],
      buttons: [['open', 'Talk to the assistant', 'sparkles'], ['refresh', 'New picks', 'refresh']],
      visual: items.length ? fan(items, 'wide') : '<div class="orb"></div>',
      shelfTitle: ['sparkles', 'Picked for you'],
      shelf: items.map((it, i) => card(it, `<span class="badge-corner">${icon('sparkles', 16)} ${esc(recs.picks[i].vibe)}</span>`)).join(''),
    };
  },
  games() {
    const ready = store.games.filter((g) => g.available);
    return {
      kicker: 'Play',
      title: 'Game Library',
      desc: 'Retro classics through RetroArch, native Linux games and PC streaming with Moonlight. π Snake is built in, so there is always something to play.',
      chips: [`${store.games.length} games`, `${ready.length} ready to play`],
      buttons: [['open', 'Open library', 'gamepad'], ['goto:store', 'Game Store', 'bag']],
      visual: fan(store.games, 'wide'),
      shelfTitle: ['gamepad', 'Your games'],
      shelf: store.games.map((g) => card(g, g.available ? '' : `<span class="badge-corner">${icon('lock', 14)} Setup</span>`)).join(''),
    };
  },
  store() {
    const shop = store.storeGames || [];
    const featured = shop.filter((g) => g.featured);
    const installed = shop.filter((g) => g.installed).length;
    return {
      kicker: 'Free & legal games',
      title: 'Game Store',
      desc: 'Pick open-source PC games and homebrew made for retro consoles, download them in the background and delete them whenever you want.',
      chips: [`${shop.length} games`, `${installed} installed`, `${shop.filter((g) => g.install_type === 'rom').length} retro`],
      buttons: [['open', 'Browse the store', 'bag']],
      visual: fan(featured, 'wide'),
      shelfTitle: ['sparkles', 'Featured'],
      shelf: featured.map((g) => `<button class="card home-card" data-focus data-act="store:${esc(g.id)}">
        <span class="badge-corner">${g.installed ? `${icon('check', 15)} Installed` : `${icon('download', 15)} Free`}</span>
        ${cover(g, 'wide')}<div class="card-label">${esc(g.title)}</div><div class="card-sub">${esc(g.platform)} · ${esc(g.genre)}</div></button>`).join(''),
    };
  },
  movies() {
    const top = topFilms();
    const history = store.filmRows.find((r) => r.id === 'watched')?.items || [];
    return {
      kicker: 'Watch',
      title: 'Movie Night',
      desc: 'Claude recommends films from everything ever released, based on what you watched and rated. Search any film, keep My List and your watch history, and download free classics legally.',
      chips: [`${icon('sparkles', 18)} Claude picks`, `${history.length} watched`, `${store.movies.length} on your Pi`],
      buttons: [['open', 'Browse movies', 'film'], ['goto:movies-search', 'Search', 'search']],
      visual: fan(top.length ? top : [...store.movies].sort(() => 0.5 - Math.random()), 'poster'),
      shelfTitle: ['film', 'Library'],
      tabs: [
        ['top', 'Top movies', 'star', top.map((f) => filmCard(f, f.reason ? `${icon('sparkles', 15)} Claude pick` : '',
          [f.year, f.reason ? 'Picked for you' : 'Popular now'].filter(Boolean).join(' · '))).join('')
          || empty(store.filmRows.length ? 'Top movies need an internet connection' : 'Loading top movies…')],
        ['history', 'Watch history', 'clock', history.map((f) => {
          const [ic, label] = HISTORY_BADGE[f.rating_given] || ['play', 'Watched'];
          return filmCard(f, `${icon(ic, 15)} ${label}`, [f.year, timeAgo(f.watched_at)].filter(Boolean).join(' · '));
        }).join('') || empty('Nothing watched yet. Play a film or rate one in Movies.')],
        ['pi', 'On your Pi', 'drive', store.movies.map((m) => card(m)).join('') || empty('No films on the Pi yet')],
      ],
    };
  },
  music() {
    const { picks, history } = songLists();
    const playing = music.track?.kind === 'track' ? music.track : null;
    return {
      kicker: playing ? `Now playing · ${playing.artist}` : 'Listen',
      title: playing ? playing.title : store.musicPicks?.headline || 'Music',
      desc: 'Search any song or artist, let Claude make a mix from what you play and like, and the endless radio keeps going with similar songs.',
      chips: [`${icon('sparkles', 18)} Claude's mix`, `${history.length} played`,
        store.fullSongs ? `${icon('play', 16)} Full songs · YouTube` : '30-second previews'],
      buttons: [['mix', "Play Claude's mix", 'sparkles'], ['open', 'Open music', 'music'], ['goto:music-search', 'Search', 'search']],
      visual: `<div class="vinyl-stack">${cover(playing || picks[0] || store.albums[0] || {}, 'square')}<div class="vinyl"></div></div>`,
      shelfTitle: ['music', 'Music'],
      tabs: [
        ['picks', "Claude's mix", 'sparkles', picks.map((s) => songCard(s, 'picks', `${icon('sparkles', 15)} Pick`, s.artist)).join('')
          || empty(store.musicRows.length ? 'Claude is making your mix…' : 'Loading music…')],
        ['history', 'Recently played', 'clock', history.map((s) => songCard(s, 'history', s.rating_given === 1 ? `${icon('heart', 15)} Liked` : '',
          [s.artist, timeAgo(s.played_at)].filter(Boolean).join(' · '))).join('') || empty('Nothing played yet. Pick a song or start Claude\'s mix.')],
        ['pi', 'On your Pi', 'drive', store.albums.map((a) => card(a)).join('') || empty('No albums on the Pi yet')],
      ],
    };
  },
  home() {
    const h = store.home || { devices: [], scenes: [] };
    const on = h.devices.filter((d) => d.on && d.type !== 'lock').length;
    const active = h.scenes.find((s) => s.id === h.active_scene);
    return {
      kicker: h.mode === 'demo' ? 'Smart home · demo house' : 'Smart home · Home Assistant',
      title: active ? active.name : 'Your Home',
      desc: 'Lights, scenes, heating and locks in one place. Ask Claude to set the mood, or pick a scene right here.',
      chips: [`${on} devices on`, `${h.scenes.length} scenes`],
      buttons: [['open', 'Open controls', 'home'], ['scene:movie_night', 'Movie Night', 'film']],
      visual: `<div class="house">${h.devices.slice(0, 8).map((d) => `<div class="house-dot ${d.on ? 'on' : ''}" style="--c:${d.color || '#fde68a'};--b:${(d.brightness ?? 80) / 100}">${icon(DEVICE_ICON[d.type] || 'bulb', 34)}<span>${esc(d.name.split(' ').slice(-1)[0])}</span></div>`).join('')}</div>`,
      shelfTitle: ['zap', 'Scenes'],
      shelf: h.scenes.map((s) => iconCard(`scene:${s.id}`, s.icon, s.name, s.description, s.hue, h.active_scene === s.id ? 'data-active' : '')).join(''),
    };
  },
  friends() {
    const friend = friendOf(store.profile.id);
    const inbox = store.inbox || [];
    return {
      kicker: 'Social',
      title: friend ? `${friend.name} is ${friend.last_activity ? 'around' : 'new here'}` : 'Friends',
      desc: friend?.last_activity ? `Last seen ${timeAgo(friend.last_activity.ts)} · ${friend.last_activity.title || ''}` : 'Share movies, music and games between consoles.',
      chips: [`${inbox.length} shares received`, friend ? `${friend.name} · Lv ${friend.level}` : ''],
      buttons: [['open', 'Open friends', 'users']],
      visual: friend ? `<div class="friend-visual">${ring(friend, 300)}<div class="friend-bubble">${icon('inbox', 22)} ${inbox.filter((s) => !s.seen).length} new</div></div>` : '',
      shelfTitle: ['inbox', 'Shared with you'],
      shelf: inbox.map((s) => {
        const item = findItem(s.kind, s.item_id);
        return item ? card(item, `<span class="badge-corner">${avatar({ id: s.from_profile, hue: s.from_hue }, 22)} ${esc(s.from_name)}</span>`) : '';
      }).join('') || '<div class="empty">Nothing shared yet</div>',
    };
  },
  drive() {
    const s = systemCache;
    const pct = s ? s.storage.used / s.storage.total : 0;
    return {
      kicker: 'Storage & compute',
      title: 'Cloud Drive',
      desc: 'Your own cloud on the Pi: a Shared folder for everyone and a private one for you. Upload from any phone or laptop, preview, share links, and reach it from anywhere with Tailscale.',
      chips: s ? [`${fmtBytes(s.storage.free)} free`, `${s.cpu_temp}°C`, s.model.replace('Raspberry Pi', 'Pi')] : ['Loading…'],
      buttons: [['open', 'Open drive', 'folder']],
      visual: `<div class="donut" style="--p:${pct}"><div><b class="num">${Math.round(pct * 100)}%</b><span>used</span></div></div>`,
      shelfTitle: ['cloud', 'aPiCloud'],
      shelf: [
        iconCard('folder:Shared', 'users', 'Shared', 'Everyone on the console', 210),
        iconCard(`folder:${store.profile.name}`, 'folder', store.profile.name, 'Only you', 260),
        ...(store.driveRecent || []).map((f) => `<button class="card home-card" data-focus data-act="file:${esc(f.path)}">
          ${f.thumb ? `<div class="cover cover-wide"><img src="${f.thumb}" alt="" loading="lazy"></div>` : `<div class="cover cover-wide icon-cover" style="--ch:205">${icon(f.kind === 'video' ? 'film' : f.kind === 'audio' ? 'music' : 'file', 56, 1.5)}</div>`}
          <div class="card-label">${esc(f.name)}</div><div class="card-sub">${esc(f.owner)} · ${timeAgo(f.modified)}</div></button>`),
      ].join(''),
    };
  },
  trophies() {
    const p = store.profile;
    const quests = store.quests || [];
    return {
      kicker: 'Progress',
      title: `Level ${p.level} · ${p.title}`,
      desc: `${p.level_ceil - p.xp} XP to level ${p.level + 1}. Complete daily quests, keep your streak and collect all ${p.trophies.possible} trophies for Platinum.`,
      chips: [`${p.trophies.total}/${p.trophies.possible} trophies`, `${quests.filter((q) => q.done).length}/${quests.length} quests today`, `${p.streak} day streak`],
      buttons: [['open', 'View trophies', 'trophy'], ['goto:stats', 'aPi Wrapped', 'chart'], ['quests', 'Daily quests', 'target']],
      visual: `<div class="medal-stack">${['bronze', 'silver', 'gold', 'platinum'].map((t) => `<div class="medal-col"><div class="medal medal-${t}" style="--s:110px">${icon('trophy', 50, 2)}</div><b class="num">${p.trophies[t]}</b></div>`).join('')}</div>`,
      shelfTitle: ['target', 'Daily quests'],
      shelf: quests.map((q) => iconCard('quests', q.done ? 'check' : q.icon, q.title, `${Math.min(q.progress, q.target)}/${q.target} · +${q.xp} XP`, q.done ? 140 : 45)).join(''),
    };
  },
  settings() {
    return {
      kicker: 'System',
      title: 'Settings',
      desc: 'Sound, performance mode, profiles and information about the hub, services and AI.',
      chips: [`aPiStation ${store.health?.version || ''}`, `role: ${store.health?.role || 'all'}`],
      buttons: [['open', 'Open settings', 'sliders']],
      visual: `<div class="gear">${icon('sliders', 200, 1)}</div>`,
      shelfTitle: ['sliders', 'Quick settings'],
      shelf: [
        iconCard('perf', 'zap', 'Performance mode', store.settings.performance ? 'On' : 'Off', 50),
        iconCard('mute', 'volume', 'Sound effects', store.settings.sfx > 0 ? 'On' : 'Muted', 190),
        iconCard('switch', 'user', 'Switch profile', 'Back to profiles', 280),
      ].join(''),
    };
  },
};

const DEVICE_ICON = { light: 'bulb', switch: 'plug', fan: 'fan', media: 'tv', climate: 'thermometer', lock: 'lock' };

export default {
  hue: TILES[0].hue,
  async mount(el) {
    el.innerHTML = `
      <div class="tiles" data-group="tiles">
        ${TILES.map((t) => `<button class="tile" data-focus data-tile="${t.id}" ${t.id === lastTile ? 'data-autofocus' : ''}>
          ${icon(t.icon, 50, 1.6)}<span class="tile-label">${t.label}</span></button>`).join('')}
      </div>
      <div class="hero">
        <div class="hero-text"></div>
        <div class="hero-visual"></div>
      </div>
      <div class="home-shelf">
        <div class="row-title"></div>
        ${hints([['a', 'Select'], ['y', 'Assistant'], ['start', 'Menu']])}
        <div class="shelf" data-group="shelf" data-scroll="x"></div>
      </div>`;
    const cleanupTopbar = mountTopbar(el);
    const heroText = el.querySelector('.hero-text');
    const heroVisual = el.querySelector('.hero-visual');
    const shelfTitle = el.querySelector('.home-shelf .row-title');
    const shelf = el.querySelector('.home-shelf .shelf');
    let tileId = lastTile;
    let swapTimer = null;

    const render = (animate = true) => {
      const tile = TILES.find((t) => t.id === tileId);
      const view = VIEWS[tileId]();
      setTheme(...tile.hue);
      const paint = () => {
        heroText.innerHTML = `
          <div class="kicker">${view.kicker}</div>
          <h1 class="title-xl">${esc(view.title)}</h1>
          <p class="hero-desc muted">${esc(view.desc)}</p>
          <div class="tags">${view.chips.filter(Boolean).map((c) => `<span class="tag">${c}</span>`).join('')}</div>
          <div class="btn-row" data-group="hero">${view.buttons.map(([act, label, ic], i) => `<button class="btn ${i === 0 ? 'primary' : ''}" data-focus data-act="${act}">${icon(ic, 24)} ${esc(label)}</button>`).join('')}</div>`;
        heroVisual.innerHTML = view.visual;
        shelfTitle.innerHTML = `${icon(view.shelfTitle[0], 26)} ${view.shelfTitle[1]}${view.tabs ? `
          <span class="shelf-tabs" data-group="shelf-tabs" data-enter="active">${view.tabs.map(([id, label, ic]) => `
            <button class="chip-btn" data-focus data-shelf-tab="${id}">${icon(ic, 18)} ${label}</button>`).join('')}</span>` : ''}`;
        paintShelf(view);
        el.querySelector('.hero').classList.remove('swap');
        el.querySelector('.home-shelf').classList.remove('swap');
      };
      if (!animate) return paint();
      el.querySelector('.hero').classList.add('swap');
      el.querySelector('.home-shelf').classList.add('swap');
      clearTimeout(swapTimer);
      swapTimer = setTimeout(paint, 140);
    };

    // Shelf content only (tab switch, films arriving), so focus on tiles and hero buttons survives.
    const paintShelf = (view = VIEWS[tileId]()) => {
      const tab = view.tabs && (view.tabs.find(([id]) => id === shelfTabs[tileId]) || view.tabs[0]);
      shelfTitle.querySelectorAll('[data-shelf-tab]').forEach((b) => b.classList.toggle('active', b.dataset.shelfTab === tab[0]));
      shelf.innerHTML = tab ? tab[3] : view.shelf;
      shelf.scrollLeft = 0;
    };

    // Shelf data arrived for a tile: repaint it without losing focus.
    const refreshTile = (id) => () => {
      if (tileId !== id) return;
      const cur = getFocused();
      if (!cur || cur.closest('.tiles')) return render(false);
      const act = shelf.contains(cur) && cur.dataset.act;
      paintShelf();
      if (act) focus(shelf.querySelector(`[data-act="${CSS.escape(act)}"]`) || focusables(shelf)[0] || shelfTitle.querySelector('.active'), { silent: true });
    };

    const select = (id, animate = true) => {
      el.querySelectorAll('.tile').forEach((t) => t.classList.toggle('selected', t.dataset.tile === id));
      if (id === tileId && heroText.innerHTML) return;
      tileId = id;
      lastTile = id;
      render(animate);
    };

    el.addEventListener('focused', (e) => {
      const tile = e.target.closest('.tile');
      if (tile) select(tile.dataset.tile);
      const tab = e.target.dataset.shelfTab;
      if (tab && tab !== shelfTabs[tileId]) {
        shelfTabs[tileId] = tab;
        paintShelf();
      }
    });

    el.addEventListener('click', async (e) => {
      const tile = e.target.closest('.tile');
      if (tile) return go(TILES.find((t) => t.id === tile.dataset.tile).screen);
      const item = e.target.closest('[data-kind]');
      if (item) {
        const it = findItem(item.dataset.kind, item.dataset.id);
        return go(KIND_SCREEN[it.kind], { focus: it.id });
      }
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      const tileDef = TILES.find((t) => t.id === tileId);
      if (act === 'open') return go(tileDef.screen);
      if (act === 'refresh') {
        toast({ icon: 'sparkles', title: 'Asking for new picks…', tone: 'info', duration: 1800 });
        await loadRecs(true).catch(() => {});
        return render();
      }
      if (act === 'quick') return playItem(store.games.find((g) => g.available) || store.games[0]);
      if (act === 'surprise') return go('movies', { focus: store.movies[Math.floor(Math.random() * store.movies.length)].id });
      if (act === 'shuffle') return playItem(store.albums[Math.floor(Math.random() * store.albums.length)]);
      if (act === 'quests') return openQuests();
      if (act.startsWith('scene:')) {
        const res = await api.scene(store.profile.id, act.slice(6));
        store.home = res.home;
        celebrate(res.event, res.event.xp ? `Scene: ${res.scene.name}` : '');
        return render(false);
      }
      if (act.startsWith('folder:')) return go('drive', { path: act.slice(7) });
      if (act.startsWith('file:')) return go('drive', { open: act.slice(5) });
      if (act.startsWith('store:')) return go('store', { focus: act.slice(6) });
      if (act.startsWith('film:')) return go('movies', { focus: act.slice(5) });
      if (act === 'goto:movies-search') return go('movies', { search: true });
      if (act === 'goto:music-search') return go('music', { search: true });
      if (act === 'mix') {
        const mix = store.musicPicks;
        if (!mix?.tracks?.length) return go('music', { mix: true });
        return playSongs(mix.tracks, 0, mix.headline || "Claude's mix", 'claude-mix');
      }
      if (act.startsWith('song:')) {
        const [, list, id] = act.split(':');
        const songs = songLists()[list] || [];
        return playSongs(songs, Math.max(songs.findIndex((s) => s.id === id), 0), list === 'picks' ? store.musicPicks.headline : 'Recently played');
      }
      if (act.startsWith('goto:')) return go(act.slice(5));
      if (act === 'perf' || act === 'mute') {
        if (act === 'perf') saveSettings({ performance: !store.settings.performance });
        else saveSettings({ sfx: store.settings.sfx > 0 ? 0 : 0.6 });
        return render(false);
      }
      if (act === 'switch') return signOut();
    });

    const offs = [
      on('recs', () => tileId === 'foryou' && render(false)),
      on('inbox', () => tileId === 'friends' && render(false)),
      on('films', refreshTile('movies')),
      on('music-data', refreshTile('music')),
      on('drive', refreshTile('drive')),
    ];
    api.system().then((s) => { systemCache = s; if (tileId === 'drive') render(false); }).catch(() => {});
    // Watch history may have changed in Movies since sign-in (the catalog rows are cached by the hub).
    if (store.filmRows.length) api.filmsHome(store.profile.id).then((d) => { store.filmRows = d.rows; refreshTile('movies')(); }).catch(() => {});
    if (store.musicRows.length) api.musicHome(store.profile.id).then((d) => { store.musicRows = d.rows; refreshTile('music')(); }).catch(() => {});

    select(tileId, false);
    focus(el.querySelector(`.tile[data-tile="${tileId}"]`), { silent: true });

    return {
      unmount() {
        cleanupTopbar();
        offs.forEach((off) => off());
        clearTimeout(swapTimer);
      },
    };
  },
};
