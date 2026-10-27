// Music, YouTube Music style: the focused song or artist on the left, what is playing on the right (the YouTube
// video while a full song plays), and rows below: the endless queue, Claude's mix, history, charts and artists.
import { api } from '../api.js';
import { cover } from '../art.js';
import { mountTopbar, openShare } from '../chrome.js';
import { focus, focusables, getFocused } from '../focus.js';
import { glyph, icon } from '../icons.js';
import { lastSource } from '../input.js';
import { music } from '../music.js';
import { playArtistRadio, playItem, playSongs } from '../playback.js';
import { friendOf, on, store } from '../store.js';
import { closeOverlay, esc, hints, keyboardPrompt, openOverlay, timeAgo, toast } from '../ui.js';

const CLAUDE_MIX = 'claude-mix';

const fmtTime = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '');
const fmtFans = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n || 0));

function subtitle(item) {
  if (item.kind === 'artist') return `${fmtFans(item.fans)} fans`;
  if (item.kind === 'album') return item.artist;
  return [item.artist, item.played_at && timeAgo(item.played_at)].filter(Boolean).join(' · ');
}

function card(item, rowId) {
  const badge = item.reason ? `${icon('sparkles', 14)} Pick` : item.rating_given === 1 ? icon('heart', 14) : '';
  const now = music.track?.id === item.id || music.album?.id === item.id;
  return `<button class="card mu-card ${item.kind === 'artist' ? 'mu-artist' : ''} ${now ? 'now' : ''}" data-focus data-row="${esc(rowId)}" data-id="${esc(item.id)}">
    ${badge ? `<span class="badge-corner">${badge}</span>` : ''}
    ${cover(item, 'square')}
    <div class="card-label">${esc(item.title)}</div>
    <div class="card-sub">${esc(subtitle(item))}</div>
  </button>`;
}

function rowHtml(row) {
  return `<section class="nf-row" data-row-id="${esc(row.id)}">
    <div class="row-title">${icon(row.icon || 'music', 24)} ${esc(row.title)} <small>${row.items.length}</small></div>
    <div class="shelf" data-group="row-${esc(row.id)}" data-scroll="x">${row.items.map((it) => card(it, row.id)).join('')}</div>
  </section>`;
}

const skeletonRow = (text) => `<section class="nf-row nf-loading" data-row-id="picks-loading">
    <div class="row-title">${icon('sparkles', 24)} ${esc(text)}</div>
    <div class="shelf">${'<div class="nf-skeleton mu-skeleton"></div>'.repeat(9)}</div>
  </section>`;

function sourceNote() {
  if (music.engine === 'youtube') return `${icon('play', 16)} Full song · YouTube`;
  if (music.engine === 'preview' && store.fullSongs && /^[\d.]+$|^\[/.test(location.hostname)) {
    // YouTube refuses most label songs on pages opened by IP address; the name address works.
    return `${icon('clock', 16)} Preview · full songs at ${store.health?.hostname || 'apiconsole'}.local:${location.port || 80}`;
  }
  if (music.engine === 'preview') {
    return `${icon('clock', 16)} 30-second preview · ${store.fullSongs ? 'no full version on YouTube' : 'full songs need a YouTube key'}`;
  }
  if (music.engine === 'loading') return 'Finding the song…';
  if (music.track?.url) return `${icon('drive', 16)} From your music server`;
  return `${icon('music', 16)} Synthesized live on the Pi`;
}

function openSearch(onSong, onArtist) {
  openOverlay({
    className: 'full-panel search-overlay',
    render(body, layer) {
      body.innerHTML = `
        <div class="nf-search-panel">
          <div class="nf-search-bar">${icon('search', 32)}
            <input class="field" data-focus data-autofocus placeholder="Search any song or artist…" maxlength="80">
          </div>
          <div class="mu-search-results" data-scroll="y" data-scroll-pad="40">
            <div class="empty">Type a song or an artist: the whole Deezer catalog can be searched and played.</div>
          </div>
          ${hints([['a', 'Play'], ['b', 'Close']])}
        </div>`;
      const input = body.querySelector('input');
      const results = body.querySelector('.mu-search-results');
      let found = { tracks: [], artists: [] };
      let timer = null;
      let seq = 0;
      const run = async (q, focusResults = false) => {
        if (q.trim().length < 2) return;
        const mine = ++seq;
        results.innerHTML = '<div class="empty"><div class="spinner"></div></div>';
        try {
          found = await api.musicSearch(q);
        } catch (err) {
          results.innerHTML = `<div class="empty">Search is unavailable right now (${esc(err.message)})</div>`;
          return;
        }
        if (mine !== seq) return;
        results.innerHTML = (found.artists.length ? `<div class="row-title">${icon('users', 22)} Artists</div>
            <div class="shelf mu-search-artists" data-group="artists" data-scroll="x">${found.artists.map((a) => card(a, 'search')).join('')}</div>` : '')
          + (found.tracks.length ? `<div class="row-title">${icon('music', 22)} Songs</div>
            <div class="mu-search-songs" data-group="songs">${found.tracks.map((t) => card(t, 'search')).join('')}</div>` : '')
          || `<div class="empty">Nothing found for “${esc(q)}”</div>`;
        if (focusResults) focus(results.querySelector('.mu-card'), { silent: true });
      };
      input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => run(input.value), 400);
      });
      input.addEventListener('submit-input', () => {
        input.blur();
        run(input.value, true);
      });
      input.addEventListener('click', async () => {
        if (lastSource !== 'gamepad') return input.focus();
        const text = await keyboardPrompt({ title: 'Search music', value: input.value, placeholder: 'Daft Punk' });
        if (text) {
          input.value = text;
          run(text, true);
        }
      });
      results.addEventListener('click', (e) => {
        const c = e.target.closest('.mu-card');
        if (!c) return;
        closeOverlay(layer, { silent: true });
        const artist = found.artists.find((a) => a.id === c.dataset.id);
        if (artist) return onArtist(artist);
        const index = found.tracks.findIndex((t) => t.id === c.dataset.id);
        onSong(found.tracks, index);
      });
      if (lastSource !== 'gamepad') setTimeout(() => input.focus(), 80);
    },
  });
}

export default {
  hue: [155, 195],
  async mount(el, params = {}) {
    const pid = store.profile.id;
    const friend = friendOf(pid);
    const ctx = { rows: store.musicRows, picks: store.musicPicks, artistRows: [], current: null, currentRow: null, ratings: {} };
    el.innerHTML = `
      <div class="mu-hero">
        <div class="mu-cover"></div>
        <div class="mu-info"></div>
      </div>
      <button class="chip-btn nf-search-btn" data-focus data-act="search">${icon('search', 22)} Search</button>
      <div class="mu-now"></div>
      <div class="nf-rows mu-rows" data-scroll="y-start" data-scroll-pad="52"></div>
      ${hints([['a', 'Play'], ['x', 'Like song'], ['y', "Claude's mix"], ['lb', 'Prev'], ['rb', 'Next'], ['b', 'Back']])}`;
    const cleanup = mountTopbar(el, 'Music');
    const coverEl = el.querySelector('.mu-cover');
    const info = el.querySelector('.mu-info');
    const nowEl = el.querySelector('.mu-now');
    const rowsEl = el.querySelector('.mu-rows');

    const queueRow = () => (music.endless && music.upNext.length
      ? [{ id: 'queue', title: `Up next · ${music.album.title}`, icon: 'layers', items: music.upNext }] : []);
    const picksRows = () => (ctx.picks?.tracks?.length
      ? [{ id: 'picks', title: `Claude's mix · ${ctx.picks.headline}`, icon: 'sparkles', items: ctx.picks.tracks }] : []);
    const allRows = () => [...queueRow(), ...ctx.artistRows, ...picksRows(), ...ctx.rows];
    const rowById = (id) => allRows().find((r) => r.id === id);
    const rating = (item) => ctx.ratings[item.id] ?? item.rating_given ?? 0;

    // ----- left: the focused song, artist or album -----
    const renderInfo = () => {
      const item = ctx.current;
      if (!item) return;
      const hadFocus = info.contains(getFocused()) ? getFocused().dataset.act : null;
      coverEl.innerHTML = cover(item, 'square');
      coverEl.classList.toggle('round', item.kind === 'artist');
      let kicker;
      let meta;
      let buttons;
      if (item.kind === 'artist') {
        kicker = 'Artist';
        meta = [`${fmtFans(item.fans)} fans on Deezer`];
        buttons = `<button class="btn primary" data-focus data-act="radio">${icon('radio', 24)} Artist radio</button>
          <button class="btn" data-focus data-act="artist">${icon('star', 22)} Top songs</button>`;
      } else if (item.kind === 'album') {
        kicker = [item.genre, item.mood].filter(Boolean).join(' · ') || 'Album';
        meta = [item.artist, item.year, `${item.tracks?.length || 0} tracks`, 'On your Pi'];
        buttons = `<button class="btn primary" data-focus data-act="play">${icon('play', 24)} Play album</button>
          ${friend ? `<button class="btn" data-focus data-act="share">${icon('share', 22)} Share with ${esc(friend.name)}</button>` : ''}`;
      } else {
        const r = rating(item);
        const playing = music.track?.id === item.id;
        kicker = item.reason ? "Claude's pick" : ctx.currentRow?.title || 'Song';
        meta = [item.artist, item.album, fmtTime(item.duration), item.explicit ? 'Explicit' : ''];
        buttons = `<button class="btn primary" data-focus data-act="play">${icon(playing && music.playing ? 'pause' : 'play', 24)} ${playing ? (music.playing ? 'Pause' : 'Resume') : 'Play'}</button>
          ${playing ? '' : `<button class="btn" data-focus data-act="next">${icon('layers', 22)} Play next</button>`}
          <button class="btn" data-focus data-act="radio">${icon('radio', 22)} Song radio</button>
          <button class="icon-btn ${r === 1 ? 'on' : ''}" data-focus data-act="like" title="Like">${icon('thumbUp', 24)}</button>
          <button class="icon-btn ${r === -1 ? 'on' : ''}" data-focus data-act="dislike" title="Not for me">${icon('thumbDown', 24)}</button>`;
      }
      info.innerHTML = `
        <div class="kicker">${esc(kicker)}</div>
        <h1 class="title-xl">${esc(item.title)}</h1>
        <div class="meta-line">${meta.filter(Boolean).map((m) => `<span>${esc(String(m))}</span>`).join('')}</div>
        ${item.reason ? `<div class="nf-reason">${icon('sparkles', 20)} ${esc(item.reason)}</div>` : ''}
        <div class="btn-row" data-group="actions" data-enter="first">${buttons}</div>`;
      if (hadFocus) focus(info.querySelector(`[data-act="${hadFocus}"]`) || focusables(info)[0], { silent: true, scroll: false });
    };

    const show = (item, rowId) => {
      if (!item) return;
      ctx.current = item;
      ctx.currentRow = rowById(rowId) || null;
      renderInfo();
    };

    // ----- right: what is playing -----
    const renderNow = () => {
      const t = music.track;
      const a = music.album;
      if (!a) {
        nowEl.innerHTML = `<div class="mu-screen mu-idle">${icon('music', 60, 1.4)}<b>Nothing playing</b>
          <span>Press ${glyph('y')} for Claude's mix, or pick any song</span></div>`;
        return;
      }
      const song = t?.kind === 'track';
      nowEl.innerHTML = `
        <div class="mu-screen ${music.engine === 'youtube' ? 'video' : ''}">${music.engine === 'youtube' ? '' : cover(song ? { ...t, poster_fit: 'contain' } : a, 'wide')}</div>
        <div class="kicker">${music.playing ? 'Now playing' : 'Paused'} · ${esc(a.title)}</div>
        <div class="mu-now-title">${esc(t?.title || a.title)}</div>
        <div class="mu-now-artist">${esc(song ? t.artist : a.artist)}</div>
        <div class="mu-progress"><i></i></div>
        <div class="mu-times num"><span class="mu-elapsed"></span><span class="mu-total"></span></div>
        <div class="mu-source">${sourceNote()}</div>`;
      tick();
    };
    const tick = () => {
      const d = music.duration();
      const bar = nowEl.querySelector('.mu-progress i');
      if (!bar) return;
      bar.style.transform = `scaleX(${d ? Math.min(music.elapsed() / d, 1) : 0})`;
      nowEl.querySelector('.mu-elapsed').textContent = fmtTime(music.elapsed()) || '0:00';
      nowEl.querySelector('.mu-total').textContent = fmtTime(d);
    };

    // ----- rows -----
    let queueSig = '';
    const renderRows = () => {
      const f = getFocused();
      const keep = f && rowsEl.contains(f) ? { row: f.dataset.row, id: f.dataset.id } : null;
      queueSig = queueRow().flatMap((r) => r.items.map((t) => t.id)).join();
      rowsEl.innerHTML = [...queueRow(), ...ctx.artistRows].map(rowHtml).join('')
        + (ctx.picks === null ? skeletonRow('Claude is making your mix…') : picksRows().map(rowHtml).join(''))
        + ctx.rows.map(rowHtml).join('');
      if (keep) {
        const again = rowsEl.querySelector(`.mu-card[data-row="${CSS.escape(keep.row)}"][data-id="${CSS.escape(keep.id)}"]`)
          || rowsEl.querySelector(`.mu-card[data-row="${CSS.escape(keep.row)}"]`) || rowsEl.querySelector('.mu-card');
        if (again) focus(again, { silent: true });
      }
    };

    const loadRows = async () => {
      try {
        const data = await api.musicHome(pid);
        ctx.rows = data.rows;
        store.musicRows = data.rows;
        store.fullSongs = data.full_songs;
      } catch (err) {
        if (!ctx.rows.length) toast({ icon: 'x', title: 'Music catalog unavailable', text: err.message, tone: 'error' });
      }
      renderRows();
    };

    const loadPicks = async (refresh = false) => {
      if (refresh) {
        ctx.picks = null;
        renderRows();
      }
      try {
        ctx.picks = await api.musicPicks(pid, refresh);
        store.musicPicks = ctx.picks;
      } catch {
        ctx.picks = { tracks: [] };
      }
      renderRows();
      return ctx.picks;
    };

    const openArtist = async (artist) => {
      let data;
      try {
        data = await api.musicArtist(artist.artist_id);
      } catch (err) {
        toast({ icon: 'x', title: `Could not open ${artist.title}`, text: err.message, tone: 'error' });
        return;
      }
      ctx.artistRows = [
        { id: 'artist-top', title: `${artist.title} · top songs`, icon: 'star', items: data.top },
        { id: 'artist-related', title: `Fans of ${artist.title} also like`, icon: 'users', items: data.related },
      ].filter((r) => r.items.length);
      renderRows();
      const first = rowsEl.querySelector('.mu-card[data-row="artist-top"]');
      if (first) focus(first);
    };

    const playClaudeMix = async () => {
      let picks = ctx.picks;
      if (music.album?.id === CLAUDE_MIX || !picks?.tracks?.length) {
        toast({ icon: 'sparkles', title: 'Claude is making a new mix…', duration: 2500 });
        picks = await loadPicks(music.album?.id === CLAUDE_MIX);
      }
      if (!picks?.tracks?.length) return toast({ icon: 'x', title: 'No mix right now', text: 'Claude and the charts are unreachable.', tone: 'error' });
      playSongs(picks.tracks, 0, picks.headline || "Claude's mix", CLAUDE_MIX);
    };

    const rate = async (item, value) => {
      const next = rating(item) === value ? 0 : value;
      ctx.ratings[item.id] = next;
      item.rating_given = next;
      renderInfo();
      try {
        await api.musicRate(pid, item, next);
      } catch (err) {
        toast({ icon: 'x', title: 'Could not save that', text: err.message, tone: 'error' });
        return;
      }
      if (next === 1) toast({ icon: 'heart', title: `Liked ${item.title}`, text: 'Claude and the radio will play more like it.', duration: 2200 });
      if (next === -1) {
        toast({ icon: 'thumbDown', title: `Not for you: ${item.title}`, text: 'It will be skipped from now on.', duration: 2200 });
        if (music.track?.id === item.id) music.next();
      }
      loadRows();
    };

    const activate = (item, rowId) => {
      if (item.kind === 'album') return playItem(item);
      if (item.kind === 'artist') return openArtist(item);
      if (rowId === 'queue') return music.jumpTo(item.id);
      if (music.track?.id === item.id) return music.toggle();
      const row = rowById(rowId);
      const items = row ? row.items : [item];
      const index = Math.max(items.findIndex((t) => t.id === item.id), 0);
      return playSongs(items, index, row ? row.title.replace(/ · .*/, '') : 'Endless radio');
    };

    // ----- events -----
    el.addEventListener('focused', (e) => {
      const c = e.target.closest('.mu-card');
      if (!c || !rowsEl.contains(c)) return;
      show(rowById(c.dataset.row)?.items.find((it) => it.id === c.dataset.id), c.dataset.row);
    });

    el.addEventListener('click', (e) => {
      const c = e.target.closest('.mu-card');
      if (c && rowsEl.contains(c)) {
        const item = rowById(c.dataset.row)?.items.find((it) => it.id === c.dataset.id);
        if (item) activate(item, c.dataset.row);
        return;
      }
      const act = e.target.closest('[data-act]')?.dataset.act;
      const item = ctx.current;
      if (act === 'search') {
        return openSearch((songs, index) => playSongs(songs, index, 'Search'), openArtist);
      }
      if (!item) return;
      if (act === 'play') activate(item, ctx.currentRow?.id);
      if (act === 'next') {
        music.playNext(item);
        toast({ icon: 'layers', title: `${item.title} plays next`, duration: 1800 });
      }
      if (act === 'radio') {
        if (item.kind === 'artist') playArtistRadio(item);
        else playSongs([item], 0, `${item.title} radio`);
      }
      if (act === 'artist') openArtist(item);
      if (act === 'like') rate(item, 1);
      if (act === 'dislike') rate(item, -1);
      if (act === 'share') openShare(item);
    });

    const offs = [
      on('music', () => {
        renderNow();
        if (queueRow().flatMap((r) => r.items.map((t) => t.id)).join() !== queueSig) renderRows();
        rowsEl.querySelectorAll('.mu-card').forEach((c) => c.classList.toggle('now', c.dataset.id === music.track?.id));
        if (ctx.current?.kind === 'track') renderInfo();
      }),
    ];
    const ticker = setInterval(tick, 500);

    // ----- start -----
    renderNow();
    renderRows();
    const first = rowsEl.querySelector('.mu-card');
    if (first) focus(first, { silent: true });
    else info.innerHTML = '<div class="empty"><div class="spinner"></div></div>';
    await loadRows();
    if (!ctx.current) {
      const c = rowsEl.querySelector('.mu-card');
      if (c) focus(c, { silent: true });
    }
    if (!ctx.picks?.tracks) loadPicks();
    if (params.search) setTimeout(() => el.querySelector('[data-act="search"]').click(), 300);
    if (params.mix) playClaudeMix();

    return {
      onButton(action) {
        if (action === 'y') {
          playClaudeMix();
          return true;
        }
        if (action === 'x') {
          const target = music.track?.kind === 'track' ? music.track : ctx.current?.kind === 'track' ? ctx.current : null;
          if (target) rate(target, 1);
          return !!target;
        }
        return false;
      },
      unmount() {
        cleanup();
        offs.forEach((off) => off());
        clearInterval(ticker);
      },
    };
  },
};
