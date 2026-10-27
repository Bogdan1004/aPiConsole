// Movies, Netflix style: Claude's picks from every film ever made, search, My List, a Watched library that
// outlives deleted files, and downloads limited to films that are legal to share (public domain / CC).
import { api } from '../api.js';
import { art, cover } from '../art.js';
import { mountTopbar } from '../chrome.js';
import { focus, focusables, getFocused } from '../focus.js';
import { fmtSize } from '../gamestore.js';
import { icon } from '../icons.js';
import { lastSource } from '../input.js';
import { playItem } from '../playback.js';
import { emit, findItem, loadLibrary, on, store } from '../store.js';
import { celebrate, closeOverlay, esc, hints, keyboardPrompt, openOverlay, timeAgo, toast } from '../ui.js';

const isActive = (job) => job && (job.state === 'queued' || job.state === 'running');
const kiosk = () => document.body.classList.contains('kiosk');
const filmId = (item) => item.imdb_id || (item.kind === 'film' ? item.id : null);

// ---------- download jobs (keep running when you leave the screen) ----------
let jobTimer = null;
const announced = new Set();

function watchFilmJobs() {
  if (jobTimer) return;
  const tick = async () => {
    let jobs;
    try { jobs = await api.filmJobs(); } catch { return; }
    emit('film-jobs', jobs);
    for (const job of jobs) {
      const key = `${job.id}:${job.started}`;
      if (isActive(job) || announced.has(key)) continue;
      announced.add(key);
      if (job.state === 'done') {
        await loadLibrary().catch(() => {});
        toast({ icon: 'download', title: `${job.title} downloaded`, text: 'Now in On your Pi', tone: 'xp' });
      } else {
        toast({ icon: 'x', title: `${job.title}: download failed`, text: job.message, tone: 'error', duration: 6000 });
      }
    }
    if (!jobs.some(isActive)) {
      clearInterval(jobTimer);
      jobTimer = null;
    }
  };
  jobTimer = setInterval(tick, 1500);
  tick();
}

// ---------- pieces ----------
function badge(item, jobs) {
  const job = jobs[filmId(item) || item.id];
  if (isActive(job)) return `${icon('download', 14)} ${Math.round(job.progress * 100)}%`;
  if (item.rating_given === 1) return `${icon('thumbUp', 14)} Liked`;
  if (item.rating_given === -1) return `${icon('thumbDown', 14)} Disliked`;
  if (item.kind === 'movie') return item.source === 'download' ? `${icon('check', 14)} On Pi` : 'Demo';
  if (item.reason) return `${icon('sparkles', 14)} Pick`;
  if (item.license) return `${icon('download', 14)} Free`;
  return '';
}

function card(item, rowId, jobs) {
  const b = badge(item, jobs);
  return `<button class="card nf-card" data-focus data-row="${esc(rowId)}" data-id="${esc(item.id)}">
    ${b ? `<span class="badge-corner">${b}</span>` : ''}
    ${cover(item, 'poster')}
    <div class="card-label">${esc(item.title)}</div>
    <div class="card-sub">${esc([item.year, timeAgo(item.watched_at)].filter(Boolean).join(' · '))}</div>
  </button>`;
}

function rowHtml(row, jobs) {
  return `<section class="nf-row" data-row-id="${esc(row.id)}">
    <div class="row-title">${icon(row.icon || 'film', 24)} ${esc(row.title)} <small>${row.items.length}</small></div>
    <div class="shelf" data-group="row-${esc(row.id)}" data-scroll="x">${row.items.map((it) => card(it, row.id, jobs)).join('')}</div>
  </section>`;
}

function skeletonRow(text) {
  return `<section class="nf-row nf-loading" data-row-id="picks-loading">
    <div class="row-title">${icon('sparkles', 24)} ${esc(text)}</div>
    <div class="shelf">${'<div class="nf-skeleton"></div>'.repeat(8)}</div>
  </section>`;
}

// ---------- overlays ----------
function openTrailer(ytId, title) {
  if (!/^[\w-]{11}$/.test(ytId)) return;
  openOverlay({
    className: 'full-panel trailer-overlay',
    render(body, layer) {
      body.innerHTML = `
        <div class="trailer">
          <iframe src="https://www.youtube-nocookie.com/embed/${ytId}?autoplay=1&rel=0&modestbranding=1"
            allow="autoplay; encrypted-media; fullscreen" allowfullscreen title="${esc(title)} trailer"></iframe>
          <div class="trailer-bar"><b>${esc(title)}</b><span class="dim">Trailer · YouTube</span>
            <button class="btn small" data-focus data-autofocus data-act="close">${icon('x', 20)} Close</button></div>
        </div>`;
      body.querySelector('[data-act="close"]').addEventListener('click', () => closeOverlay(layer));
      layer.onButton = (action) => {
        if (['a', 'b', 'quit'].includes(action)) closeOverlay(layer);
        return true;
      };
    },
  });
}

function openSearch(jobs, onPick) {
  openOverlay({
    className: 'full-panel search-overlay',
    render(body, layer) {
      body.innerHTML = `
        <div class="nf-search-panel">
          <div class="nf-search-bar">${icon('search', 32)}
            <input class="field" data-focus data-autofocus placeholder="Search any movie…" maxlength="80">
          </div>
          <div class="nf-search-results" data-group="results" data-scroll="y" data-scroll-pad="40">
            <div class="empty">Type a title: every film on IMDb can be found, rated and added to My List.</div>
          </div>
          ${hints([['a', 'Open'], ['b', 'Close']])}
        </div>`;
      const input = body.querySelector('input');
      const results = body.querySelector('.nf-search-results');
      let found = [];
      let timer = null;
      let seq = 0;
      const run = async (q, focusResults = false) => {
        if (q.trim().length < 2) return;
        const mine = ++seq;
        results.innerHTML = '<div class="empty"><div class="spinner"></div></div>';
        try {
          found = await api.filmSearch(q);
        } catch (err) {
          results.innerHTML = `<div class="empty">Search is unavailable right now (${esc(err.message)})</div>`;
          return;
        }
        if (mine !== seq) return;
        results.innerHTML = found.map((f) => card(f, 'search', jobs)).join('') || `<div class="empty">No movies found for “${esc(q)}”</div>`;
        if (focusResults && results.querySelector('.nf-card')) focus(results.querySelector('.nf-card'), { silent: true });
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
        const text = await keyboardPrompt({ title: 'Search movies', value: input.value, placeholder: 'Interstellar' });
        if (text) {
          input.value = text;
          run(text, true);
        }
      });
      results.addEventListener('click', (e) => {
        const c = e.target.closest('.nf-card');
        if (!c) return;
        const film = found.find((f) => f.id === c.dataset.id);
        closeOverlay(layer, { silent: true });
        onPick(film);
      });
      if (lastSource !== 'gamepad') setTimeout(() => input.focus(), 80);
    },
  });
}

function confirmDeleteFile(item) {
  return new Promise((resolve) => {
    let done = false;
    openOverlay({
      className: 'center-panel',
      render(body, layer) {
        body.innerHTML = `
          <div class="panel confirm-panel">
            <div class="confirm-head">${cover(item, 'poster')}
              <div><div class="kicker">Delete download</div><h2 class="title-lg">${esc(item.title)}</h2>
              <p class="muted">The file is removed from the Pi. The film stays in your Watched library and you can download it again.</p></div>
            </div>
            <div class="btn-row">
              <button class="btn" data-focus data-autofocus data-act="keep">${icon('back', 22)} Keep it</button>
              <button class="btn danger" data-focus data-act="delete">${icon('trash', 22)} Delete file</button>
            </div>
          </div>`;
        body.addEventListener('click', (e) => {
          const act = e.target.closest('[data-act]')?.dataset.act;
          if (!act) return;
          done = true;
          resolve(act === 'delete');
          closeOverlay(layer, { silent: true });
        });
        layer.onClose = () => { if (!done) resolve(false); };
      },
    });
  });
}

// ---------- screen ----------
export default {
  hue: [8, 330],
  async mount(el, params = {}) {
    const pid = store.profile.id;
    const ctx = { rows: [], picks: null, jobs: {}, details: {}, current: null };
    el.innerHTML = `
      <div class="nf-hero"><div class="nf-backdrop"></div><div class="nf-shade"></div><div class="nf-info"></div></div>
      <button class="chip-btn nf-search-btn" data-focus data-act="search">${icon('search', 22)} Search</button>
      <div class="nf-rows" data-scroll="y-start" data-scroll-pad="52"></div>
      ${hints([['a', 'Select'], ['x', 'My List'], ['y', 'New picks'], ['b', 'Back']])}`;
    const cleanup = mountTopbar(el, 'Movies');
    const backdrop = el.querySelector('.nf-backdrop');
    const info = el.querySelector('.nf-info');
    const rowsEl = el.querySelector('.nf-rows');
    let detailTimer = null;
    let userMoved = false;

    const allItems = () => [...(ctx.picks ? [...ctx.picks.top, ...(ctx.picks.because?.items || [])] : []), ...ctx.rows.flatMap((r) => r.items)];
    const itemFor = (rowId, id) => {
      const rows = rowId === 'picks' || rowId === 'because' ? pickRows() : ctx.rows;
      return rows.find((r) => r.id === rowId)?.items.find((it) => it.id === id) || allItems().find((it) => it.id === id);
    };
    const pickRows = () => (ctx.picks ? [
      { id: 'picks', title: `Top picks for ${store.profile.name}`, icon: 'sparkles', items: ctx.picks.top },
      ...(ctx.picks.because?.items?.length ? [{ id: 'because', title: ctx.picks.because.title, icon: 'heart', items: ctx.picks.because.items }] : []),
    ] : []);

    // ----- hero -----
    const actions = (item, d) => {
      const fid = filmId(item);
      const local = item.kind === 'movie' ? item : (d?.status?.local ? findItem('movie', item.id) : null);
      const job = ctx.jobs[fid] || d?.status?.job;
      const out = [];
      if (local) {
        if (local.imdb_id && !kiosk()) {
          out.push(`<button class="btn primary" data-focus data-act="play-here">${icon('play', 24)} Play here</button>`,
            `<button class="btn" data-focus data-act="play-tv">${icon('tv', 22)} Play on TV</button>`);
        } else {
          out.push(`<button class="btn primary" data-focus data-act="play">${icon('play', 24)} Play</button>`);
        }
      } else if (isActive(job)) {
        out.push(`<div class="install-progress"><div class="bar"><i style="width:${job.progress * 100}%"></i></div>
          <span class="num">${Math.round(job.progress * 100)}%</span><span class="dim">${esc(job.message || '')}</span></div>`);
      } else if (d?.free) {
        out.push(`<button class="btn primary" data-focus data-act="download">${icon('download', 24)} Download · ${fmtSize(d.free.size / 1_048_576)}</button>`);
      }
      if (fid) {
        if (d?.trailers?.length) out.push(`<button class="btn" data-focus data-act="trailer">${icon('film', 22)} Trailer</button>`);
        const listed = d?.status?.in_list;
        out.push(`<button class="btn" data-focus data-act="list">${icon(listed ? 'check' : 'plus', 22)} ${listed ? 'In My List' : 'My List'}</button>`);
        const r = d?.status?.watched?.rating ?? item.rating_given;
        out.push(`<button class="icon-btn ${r === 1 ? 'on' : ''}" data-focus data-act="like" title="Watched it, liked it">${icon('thumbUp', 24)}</button>`,
          `<button class="icon-btn ${r === -1 ? 'on' : ''}" data-focus data-act="dislike" title="Watched it, not for me">${icon('thumbDown', 24)}</button>`);
        if (local?.imdb_id) out.push(`<button class="icon-btn" data-focus data-act="delete-file" title="Delete download">${icon('trash', 24)}</button>`);
      }
      return out.join('');
    };

    const legalNote = (item, d) => {
      if (item.kind === 'movie' && item.source !== 'download') return 'Demo film: plays a simulated stream. Download the real one from Free & legal.';
      if (d?.free) return `${esc(d.free.license)}${d.free.note && !String(d.free.note).startsWith('http') ? ` · ${esc(d.free.note)}` : ''} · via Internet Archive`;
      if (d && !d.status.local) return 'Not free to download legally here. Rate it, add it to My List or watch the trailer.';
      return '';
    };

    const renderHero = (item) => {
      const d = ctx.details[filmId(item)];
      const genres = (d?.genres || item.genres || []).slice(0, 3);
      const runtime = d?.runtime || item.runtime || (item.minutes ? `${item.minutes} min` : '');
      const rating = d?.rating || item.rating;
      const credits = d ? [d.director?.length ? `Directed by ${d.director.join(', ')}` : '', d.cast?.length ? `Starring ${d.cast.slice(0, 3).join(', ')}` : '']
        .filter(Boolean).join(' · ') : '';
      const hadFocus = info.contains(getFocused()) ? getFocused().dataset.act : null;
      info.innerHTML = `
        ${d?.logo ? `<img class="nf-logo" hidden alt="" src="${esc(d.logo)}">` : ''}
        <h1 class="title-xl">${esc(item.title)}</h1>
        <div class="meta-line">${[item.year, runtime, rating ? `${icon('star', 18)} ${rating}` : '', genres.join(' · ')].filter(Boolean).map((m) => `<span>${m}</span>`).join('')}</div>
        ${item.reason ? `<div class="nf-reason">${icon('sparkles', 20)} ${esc(item.reason)}</div>` : ''}
        <p class="nf-desc muted">${esc(d?.description || item.synopsis || '')}</p>
        ${credits ? `<div class="nf-credits dim">${esc(credits)}</div>` : ''}
        <div class="btn-row nf-actions" data-group="actions" data-enter="first">${actions(item, d)}</div>
        <div class="nf-legal dim">${legalNote(item, d)}</div>`;
      // Show the film's logo instead of the title text once it has actually loaded.
      const logo = info.querySelector('.nf-logo');
      const heading = info.querySelector('h1');
      logo?.addEventListener('load', () => {
        if (logo.isConnected && logo.naturalWidth > 1) {
          logo.hidden = false;
          heading.hidden = true;
        }
      });
      if (hadFocus) {
        const again = info.querySelector(`[data-act="${hadFocus}"]`) || focusables(info)[0];
        if (again) focus(again, { silent: true, scroll: false });
      }
    };

    const show = (item) => {
      if (!item) return;
      const changed = ctx.current?.id !== item.id;
      ctx.current = item;
      if (changed) {
        backdrop.innerHTML = item.backdrop
          ? `<img class="fade-in" src="${esc(item.backdrop)}" alt="" onerror="this.remove()">`
          : `<div class="fade-in nf-art">${art(item, 'wide')}</div>`;
      }
      renderHero(item);
      const fid = filmId(item);
      clearTimeout(detailTimer);
      if (fid && !ctx.details[fid]) {
        detailTimer = setTimeout(async () => {
          try {
            ctx.details[fid] = await api.filmDetails(pid, fid);
            if (ctx.details[fid].status?.job) ctx.jobs[fid] = ctx.details[fid].status.job;
          } catch { return; }
          if (ctx.current === item) renderHero(item);
        }, 350);
      }
    };

    // ----- rows -----
    const renderRows = () => {
      const f = getFocused();
      const keep = f && rowsEl.contains(f) ? { row: f.dataset.row, id: f.dataset.id } : null;
      rowsEl.innerHTML = (ctx.picks ? pickRows().map((r) => rowHtml(r, ctx.jobs)).join('') : skeletonRow('Claude is picking films for you…'))
        + ctx.rows.map((r) => rowHtml(r, ctx.jobs)).join('');
      if (keep) {
        const again = rowsEl.querySelector(`.nf-card[data-row="${CSS.escape(keep.row)}"][data-id="${CSS.escape(keep.id)}"]`)
          || rowsEl.querySelector(`.nf-card[data-row="${CSS.escape(keep.row)}"]`) || rowsEl.querySelector('.nf-card');
        if (again) focus(again, { silent: true });
      }
    };

    const loadRows = async () => {
      const data = await api.filmsHome(pid);
      ctx.rows = data.rows;
      store.filmRows = data.rows; // Home's Library shelf (watch history) stays current
      for (const j of data.jobs) ctx.jobs[j.id] = j;
      if (data.jobs.some(isActive)) watchFilmJobs();
      renderRows();
    };

    const loadPicks = async (refresh = false) => {
      try {
        ctx.picks = await api.filmPicks(pid, refresh);
        store.filmPicks = ctx.picks;
      } catch {
        ctx.picks = { top: [], because: null };
      }
      renderRows();
      if (!userMoved && ctx.picks.top[0]) {
        show(ctx.picks.top[0]);
        focus(rowsEl.querySelector('.nf-card[data-row="picks"]'), { silent: true });
      }
    };

    // ----- events -----
    el.addEventListener('focused', (e) => {
      const c = e.target.closest('.nf-card');
      if (!c || !rowsEl.contains(c)) return;
      show(itemFor(c.dataset.row, c.dataset.id));
    });

    const refreshAfterChange = async () => {
      delete ctx.details[filmId(ctx.current)];
      await loadRows();
      show(ctx.current);
    };

    el.addEventListener('click', async (e) => {
      const c = e.target.closest('.nf-card');
      if (c && rowsEl.contains(c)) {
        const first = focusables(info)[0];
        if (first) focus(first);
        return;
      }
      const act = e.target.closest('[data-act]')?.dataset.act;
      const item = ctx.current;
      if (act === 'search') {
        return openSearch(ctx.jobs, (film) => {
          userMoved = true;
          show(film);
          setTimeout(() => focusables(info)[0] && focus(focusables(info)[0], { silent: true }), 400);
        });
      }
      if (!act || !item) return;
      const fid = filmId(item);
      const d = ctx.details[fid];
      try {
        if (act === 'play') return playItem(item.kind === 'movie' ? item : findItem('movie', item.id));
        if (act === 'play-here' || act === 'play-tv') {
          const local = item.kind === 'movie' ? item : findItem('movie', item.id);
          return playItem(local, act === 'play-here' ? 'here' : 'tv');
        }
        if (act === 'trailer' && d?.trailers?.[0]) return openTrailer(d.trailers[0], item.title);
        if (act === 'download') {
          const job = await api.filmDownload(pid, fid);
          ctx.jobs[fid] = job;
          toast({ icon: 'download', title: `Downloading ${item.title}`, text: fmtSize(job.size / 1_048_576), duration: 2500 });
          watchFilmJobs();
          return renderHero(item);
        }
        if (act === 'list') {
          const res = await api.filmList(pid, fid);
          toast({ icon: res.in_list ? 'plus' : 'x', title: res.in_list ? `Added to My List` : 'Removed from My List', text: item.title, tone: 'info', duration: 2000 });
          return refreshAfterChange();
        }
        if (act === 'like' || act === 'dislike') {
          const want = act === 'like' ? 1 : -1;
          const current = d?.status?.watched?.rating ?? item.rating_given;
          if (current === want) await api.filmUnwatch(pid, fid);
          else {
            const res = await api.filmRate(pid, fid, want);
            celebrate(res.event, res.event?.xp ? `Rated ${item.title}` : '');
          }
          return refreshAfterChange();
        }
        if (act === 'delete-file' && (await confirmDeleteFile(item))) {
          await api.filmDeleteFile(fid);
          await loadLibrary();
          toast({ icon: 'trash', title: `${item.title} deleted from the Pi`, text: 'Still in your Watched library', tone: 'muted' });
          return refreshAfterChange();
        }
      } catch (err) {
        toast({ icon: 'x', title: 'Something went wrong', text: err.message, tone: 'error' });
      }
    });

    const offJobs = on('film-jobs', (jobs) => {
      let finished = false;
      for (const job of jobs) {
        const was = ctx.jobs[job.id];
        ctx.jobs[job.id] = job;
        if (isActive(was) && !isActive(job)) finished = true;
        rowsEl.querySelectorAll(`.nf-card[data-id="${CSS.escape(job.id)}"] .badge-corner`).forEach((b) => {
          b.innerHTML = isActive(job) ? `${icon('download', 14)} ${Math.round(job.progress * 100)}%` : `${icon('check', 14)} On Pi`;
        });
        if (filmId(ctx.current || {}) === job.id && isActive(job)) {
          const bar = info.querySelector('.install-progress');
          if (bar) {
            bar.querySelector('.bar i').style.width = `${job.progress * 100}%`;
            bar.querySelector('.num').textContent = `${Math.round(job.progress * 100)}%`;
            bar.querySelector('.dim').textContent = job.message || '';
          } else renderHero(ctx.current);
        }
      }
      if (finished) setTimeout(refreshAfterChange, 600);
    });

    // A film chosen on Home: its card when it is in a row, otherwise its details with the hero's actions focused.
    const focusFilm = async (id) => {
      const found = rowsEl.querySelector(`.nf-card[data-id="${CSS.escape(id)}"]`);
      if (found) {
        focus(found, { silent: true });
        return true;
      }
      try {
        ctx.details[id] = ctx.details[id] || await api.filmDetails(pid, id);
      } catch {
        return false;
      }
      show(ctx.details[id]);
      focus(focusables(info)[0], { silent: true });
      return true;
    };

    // ----- start -----
    rowsEl.innerHTML = skeletonRow('Loading movies…');
    await loadRows();
    const wanted = params.focus;
    // Home only shows picks the hub already has cached, so waiting for them is quick.
    const wantedPick = wanted && store.filmPicks?.top.some((f) => f.id === wanted);
    if (wanted) userMoved = true;
    if (wantedPick) await loadPicks();
    if (!(wanted && await focusFilm(wanted))) {
      const first = ctx.rows[0]?.items[0];
      if (first) {
        show(first);
        focus(rowsEl.querySelector('.nf-card'), { silent: true });
      }
      userMoved = false;
    }
    if (!wantedPick) loadPicks();
    if (params.search) setTimeout(() => el.querySelector('[data-act="search"]').click(), 300);

    return {
      onButton(action) {
        if (['up', 'down', 'left', 'right'].includes(action)) userMoved = true;
        if (action === 'y') {
          ctx.picks = null;
          renderRows();
          loadPicks(true);
          toast({ icon: 'sparkles', title: 'Asking Claude for new picks…', duration: 2000 });
          return true;
        }
        if (action === 'x' && ctx.current && filmId(ctx.current)) {
          info.querySelector('[data-act="list"]')?.click();
          return true;
        }
        return false;
      },
      unmount() {
        cleanup();
        offJobs();
        clearTimeout(detailTimer);
      },
    };
  },
};
