// aPi Wrapped: a player's week, month or all time on the console, like Spotify Wrapped but for everything:
// a persona written by Claude, a leaderboard against the other player, numbers, charts, top lists, this week's
// challenges, and a full-screen story to step through.
import { api } from '../api.js';
import { mountTopbar } from '../chrome.js';
import { barList, columnChart, attachTooltips, heatmap, rampLegend, versus } from '../charts.js';
import { focus } from '../focus.js';
import { icon } from '../icons.js';
import { store } from '../store.js';
import { celebrate, closeOverlay, esc, hints, openOverlay } from '../ui.js';

const PERIODS = [['week', 'This week'], ['month', 'This month'], ['all', 'All time']];
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
let period = 'week';

const fmtMinutes = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);

function tile(ic, label, value) {
  return `<div class="stat-tile"><span class="stat-label">${icon(ic, 20)} ${esc(label)}</span><b class="stat-value">${esc(String(value))}</b></div>`;
}

function openStory(data, story) {
  const k = data.kpis;
  const artist = data.top_artists[0];
  const game = data.top_games[0];
  const label = PERIODS.find(([id]) => id === period)[1].toLowerCase();
  const slides = [
    `<div class="kicker">aPi Wrapped · ${esc(label)}</div><h1 class="story-big">${esc(store.profile.name)},<br>here's your ${esc(label === 'all time' ? 'story' : label)}.</h1>`,
    `<div class="kicker">${icon('music', 18)} Music</div><h1 class="story-big"><span class="grad num">${esc(fmtMinutes(k.music_minutes))}</span><br>of music</h1>
      ${artist ? `<div class="story-feature">${artist.poster ? `<img src="${esc(artist.poster)}" alt="">` : ''}<span>Your top artist<b>${esc(artist.name)}</b>${artist.plays} plays</span></div>` : '<p class="muted">Play some songs and this page fills up.</p>'}`,
    `<div class="kicker">${icon('film', 18)} Films</div><h1 class="story-big"><span class="grad num">${k.films}</span> film${k.films === 1 ? '' : 's'} watched</h1>
      <div class="story-posters">${data.films.slice(0, 5).map((f) => `<img src="https://images.metahub.space/poster/small/${esc(f.id)}/img" alt="" onerror="this.remove()">`).join('')}</div>`,
    `<div class="kicker">${icon('gamepad', 18)} Games</div><h1 class="story-big"><span class="grad num">${k.games}</span> game session${k.games === 1 ? '' : 's'}</h1>
      ${game ? `<p class="story-sub">Your favourite: <b>${esc(game.title)}</b> (${game.plays}×)</p>` : ''}`,
    `<div class="kicker">${icon('trophy', 18)} Progress</div><h1 class="story-big"><span class="grad num">${k.xp}</span> XP</h1>
      <p class="story-sub">${k.trophies} trophies unlocked · ${k.active_days} active days</p>`,
    `<div class="kicker">${icon('sparkles', 18)} Your persona${story.source === 'claude' ? ' · by Claude' : ''}</div>
      <h1 class="story-big grad">${esc(story.persona)}</h1><p class="story-sub">${esc(story.summary)}</p>`,
  ];
  let i = 0;
  openOverlay({
    className: 'full-panel story-overlay',
    render(body, layer) {
      const paint = () => {
        body.innerHTML = `<div class="story">
          <div class="story-bars">${slides.map((_, n) => `<i class="${n < i ? 'done' : n === i ? 'now' : ''}"></i>`).join('')}</div>
          <div class="story-slide">${slides[i]}</div>
          ${hints([['←', 'Back'], ['a', 'Next'], ['b', 'Close']])}</div>`;
      };
      let timer = null;
      const go = (d) => {
        i += d;
        if (i >= slides.length) return closeOverlay(layer, { silent: true });
        i = Math.max(0, i);
        paint();
        clearTimeout(timer);
        timer = setTimeout(() => go(1), 6500);
        return null;
      };
      layer.onButton = (action) => {
        if (action === 'a' || action === 'right') { go(1); return true; }
        if (action === 'left') { go(-1); return true; }
        return false;
      };
      body.addEventListener('click', () => go(1));
      layer.onClose = () => clearTimeout(timer);
      go(0);
    },
  });
}

export default {
  hue: [262, 310],
  async mount(el) {
    const pid = store.profile.id;
    el.innerHTML = `
      <div class="stats-page" data-scroll="y-start" data-scroll-pad="40">
        <div class="stats-filters chips" data-group="periods">${PERIODS.map(([id, label]) => `<button class="chip-btn ${id === period ? 'active' : ''}" data-focus data-period="${id}">${esc(label)}</button>`).join('')}</div>
        <div class="stats-body"><div class="empty"><div class="spinner"></div></div></div>
      </div>
      ${hints([['a', 'Select'], ['b', 'Back']])}`;
    const cleanup = mountTopbar(el, 'aPi Wrapped');
    const page = el.querySelector('.stats-page');
    const bodyEl = el.querySelector('.stats-body');
    attachTooltips(page);
    let data = null;
    let story = null;

    const paintStory = () => {
      const s = story;
      el.querySelector('.persona-card').innerHTML = s ? `
        <div class="kicker">${icon('sparkles', 18)} Your persona${s.source === 'claude' ? ' · written by Claude' : ''}</div>
        <h1 class="persona">${esc(s.persona)}</h1>
        <p class="persona-headline">${esc(s.headline)}</p>
        <p class="muted">${esc(s.summary)}</p>
        <ul class="persona-facts">${s.facts.map((f) => `<li>${icon('star', 16)} ${esc(f)}</li>`).join('')}</ul>
        <button class="btn primary" data-focus data-act="story">${icon('play', 22)} Play the story</button>`
        : '<div class="kicker">Your persona</div><div class="empty"><div class="spinner"></div> Writing your story…</div>';
    };

    const paint = () => {
      const k = data.kpis;
      const me = data.leaderboard.find((p) => p.id === pid);
      const rivals = data.leaderboard.filter((p) => p.id !== pid);
      const players = [me, ...rivals.slice(0, 1)].filter(Boolean);
      const metrics = [['XP', 'xp', ''], ['Music', 'music_minutes', ' min'], ['Films', 'films', ''], ['Games', 'games', ''], ['Trophies', 'trophies', '']]
        .map(([label, key, unit]) => ({ label, unit, values: players.map((p) => p[key]) }));
      const daily = data.daily.map((d) => {
        const dt = new Date(`${d.date}T12:00`);
        return { label: period === 'week' ? DAY[dt.getDay()] : `${dt.getDate()}`, value: d.xp, tip: `${DAY[dt.getDay()]} ${dt.getDate()}.${dt.getMonth() + 1}: ${d.xp} XP` };
      });
      bodyEl.innerHTML = `
        <div class="stats-top">
          <div class="panel persona-card" data-focus></div>
          <div class="panel viz-panel" data-focus>
            <div class="viz-title">${icon('users', 20)} ${players.length > 1 ? `You vs ${esc(players[1].name)}` : 'Your numbers'} · ${esc(PERIODS.find(([id]) => id === period)[1].toLowerCase())}</div>
            ${versus(players, metrics)}
          </div>
        </div>
        <div class="stat-row">
          ${tile('trophy', 'XP earned', k.xp)}${tile('clock', 'Active days', k.active_days)}${tile('music', 'Music', fmtMinutes(k.music_minutes))}
          ${tile('film', 'Films', k.films)}${tile('gamepad', 'Game sessions', k.games)}${tile('star', 'Trophies', k.trophies)}
        </div>
        <div class="stats-grid">
          <div class="panel viz-panel" data-focus>
            <div class="viz-title">${icon('zap', 20)} XP per day</div>
            ${columnChart(daily, { width: 820, height: 230, unit: ' XP' })}
          </div>
          <div class="panel viz-panel" data-focus>
            <div class="viz-title">${icon('clock', 20)} When you use aPiStation ${rampLegend()}</div>
            ${heatmap(data.heat, { width: 820 })}
          </div>
        </div>
        <div class="stats-grid three">
          <div class="panel viz-panel" data-focus><div class="viz-title">${icon('music', 20)} Top artists</div>
            ${data.top_artists.length ? barList(data.top_artists.map((a) => ({ label: a.name, value: a.plays, thumb: a.poster, tip: `${a.name}: ${a.plays} plays` }))) : '<div class="viz-empty">No songs yet in this period</div>'}
            ${data.top_songs.length ? `<div class="viz-sub">Top song: <b>${esc(data.top_songs[0].title)}</b> · ${esc(data.top_songs[0].artist)}</div>` : ''}</div>
          <div class="panel viz-panel" data-focus><div class="viz-title">${icon('gamepad', 20)} Top games</div>
            ${data.top_games.length ? barList(data.top_games.map((g) => ({ label: g.title, value: g.plays, tip: `${g.title}: ${g.plays} sessions` }))) : '<div class="viz-empty">No games yet in this period</div>'}</div>
          <div class="panel viz-panel" data-focus><div class="viz-title">${icon('film', 20)} Films watched</div>
            ${data.films.length ? `<div class="stats-films">${data.films.map((f) => `<div class="stats-film"><img src="https://images.metahub.space/poster/small/${esc(f.id)}/img" alt="" loading="lazy" onerror="this.remove()"><span>${esc(f.title)}${f.rating === 1 ? ` ${icon('thumbUp', 14)}` : ''}</span></div>`).join('')}</div>` : '<div class="viz-empty">No films yet in this period</div>'}</div>
        </div>
        <div class="panel challenges-panel" data-focus>
          <div class="viz-title">${icon('target', 20)} This week's challenges <small class="dim">new ones every Monday · +${data.challenges[0]?.xp || 100} XP each</small></div>
          <div class="challenges">${data.challenges.map((c) => `<div class="challenge ${c.done ? 'done' : ''}">
            <span class="challenge-title">${c.done ? icon('check', 18) : ''} ${esc(c.title)}</span>
            <span class="meter"><i style="width:${Math.round((c.progress / c.target) * 100)}%"></i></span>
            <span class="num challenge-count">${c.done ? 'Done' : `${c.progress} / ${c.target}`}</span></div>`).join('')}</div>
        </div>`;
      paintStory();
    };

    const load = async () => {
      bodyEl.innerHTML = '<div class="empty"><div class="spinner"></div></div>';
      story = null;
      try {
        data = await api.stats(pid, period);
      } catch (err) {
        bodyEl.innerHTML = `<div class="empty">Stats are unavailable (${esc(err.message)})</div>`;
        return;
      }
      paint();
      data.events.forEach((ev) => celebrate(ev, 'Weekly challenge complete!'));
      const wanted = period;
      api.statsStory(pid, period).then((s) => {
        if (wanted !== period) return;
        story = s;
        paintStory();
      }).catch(() => {});
    };

    el.addEventListener('click', (e) => {
      const p = e.target.closest('[data-period]')?.dataset.period;
      if (p && p !== period) {
        period = p;
        el.querySelectorAll('[data-period]').forEach((b) => b.classList.toggle('active', b.dataset.period === period));
        load();
      }
      if (e.target.closest('[data-act="story"]') && data && story) openStory(data, story);
    });

    await load();
    focus(el.querySelector('.chip-btn.active'), { silent: true });
    return { unmount: cleanup };
  },
};
