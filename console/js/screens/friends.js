// Friends: the other console's player, shares they sent you, and a live activity feed.
import { api } from '../api.js';
import { avatar, cover } from '../art.js';
import { mountTopbar, openShare, ring } from '../chrome.js';
import { icon } from '../icons.js';
import { music } from '../music.js';
import { playItem } from '../playback.js';
import { findItem, friendOf, refreshProfile, store } from '../store.js';
import { closeOverlay, esc, hints, medal, openOverlay, timeAgo } from '../ui.js';

const VERB = { watch: 'watched', listen: 'listened to', play: 'played', home: 'switched', ai: 'asked the assistant', share: 'shared', score: 'scored in', login: 'signed in', upload: 'uploaded', install: 'installed', rate: 'rated' };
const TIERS = ['bronze', 'silver', 'gold', 'platinum'];

function feedLine(a) {
  if (a.kind === 'score') return `scored <b>${a.meta.score}</b> in ${esc(a.title)}`;
  if (a.kind === 'login') return 'signed in';
  if (a.kind === 'ai') return 'asked the assistant for advice';
  return `${VERB[a.kind] || a.kind} <b>${esc(a.title || '')}</b>`;
}

function presence(p) {
  const last = p.last_activity;
  if (!last) return { online: false, text: 'No activity yet' };
  const minutes = (Date.now() - new Date(last.ts.replace(' ', 'T')).getTime()) / 60000;
  const doing = last.kind === 'ai' ? 'talking to the assistant' : `${VERB[last.kind] || ''} ${last.title || ''}`.trim();
  return minutes < 15 ? { online: true, text: `Online · ${doing}` } : { online: false, text: `Last seen ${timeAgo(last.ts)} · ${doing}` };
}

export default {
  hue: [330, 285],
  async mount(el) {
    const me = store.profile;
    const friend = friendOf(me.id);
    const [inbox, feed] = await Promise.all([api.inbox(me.id), api.feed(30)]);
    store.inbox = inbox;
    const pres = friend ? presence(friend) : null;

    el.innerHTML = `
      <div class="friends-layout">
        <div class="panel friend-card">
          ${friend ? `
            ${ring(friend, 190)}
            <h2 class="title-lg">${esc(friend.name)}</h2>
            <div class="muted">Level ${friend.level} · ${esc(friend.title)}</div>
            <div class="presence ${pres.online ? 'on' : ''}"><span class="dot ${pres.online ? '' : 'off'}"></span>${esc(pres.text)}</div>
            <div class="friend-stats">
              <span>${icon('flame', 22)} ${friend.streak} day streak</span>
              <span>${icon('trophy', 22)} ${friend.trophies.total} trophies</span>
            </div>
            <div class="friend-actions" data-group="friend">
              <button class="btn primary" data-focus data-act="compare">${icon('trophy', 22)} Compare trophies</button>
              ${music.album ? `<button class="btn" data-focus data-act="share-music">${icon('music', 22)} Share what's playing</button>` : ''}
            </div>` : '<div class="empty">No other players yet</div>'}
        </div>
        <div class="friends-col">
          <div class="row-title">${icon('inbox', 26)} Shared with you <small>${inbox.length}</small></div>
          <div class="inbox-list" data-group="inbox" data-scroll="y" data-scroll-pad="20">
            ${inbox.map((s) => {
              const item = findItem(s.kind, s.item_id);
              return item ? `<button class="inbox-item ${s.seen ? '' : 'new'}" data-focus data-kind="${s.kind}" data-id="${esc(s.item_id)}">
                ${cover(item, s.kind === 'game' ? 'wide' : 'square')}
                <span class="inbox-body">
                  <span class="inbox-from">${avatar({ id: s.from_profile, hue: s.from_hue }, 28)} ${esc(s.from_name)} · ${timeAgo(s.ts)}</span>
                  <span class="inbox-title">${esc(item.title)}</span>
                  ${s.message ? `<span class="inbox-msg">“${esc(s.message)}”</span>` : ''}
                </span>
                <span class="pick-play">${icon('play', 22)}</span>
              </button>` : '';
            }).join('') || '<div class="empty">Nothing yet. Shares from friends land here.</div>'}
          </div>
        </div>
        <div class="friends-col">
          <div class="row-title">${icon('zap', 26)} Activity</div>
          <div class="feed" data-group="feed" data-scroll="y" data-scroll-pad="20">
            ${feed.map((a) => `<div class="feed-row" data-focus>
              ${avatar({ id: a.profile_id, hue: a.profile_hue }, 44)}
              <span class="feed-text"><span><b>${esc(a.profile_name)}</b> ${feedLine(a)}</span><small>${timeAgo(a.ts)}</small></span>
              ${a.xp ? `<span class="feed-xp num">+${a.xp}</span>` : ''}
            </div>`).join('')}
          </div>
        </div>
      </div>
      ${hints([['a', 'Select'], ['b', 'Back']])}`;
    const cleanup = mountTopbar(el, 'Friends');

    el.addEventListener('click', async (e) => {
      const item = e.target.closest('.inbox-item');
      if (item) return playItem(findItem(item.dataset.kind, item.dataset.id));
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'share-music' && music.album) openShare(music.album);
      if (act === 'compare') openCompare(me, friend);
    });

    if (inbox.some((s) => !s.seen)) {
      api.inboxSeen(me.id).then(refreshProfile).catch(() => {});
    }
    return { unmount: cleanup };
  },
};

function openCompare(me, friend) {
  openOverlay({
    className: 'center-panel',
    render(body, layer) {
      const col = (p) => `<div class="cmp-col">
        ${ring(p, 150)}
        <h2 class="title-lg">${esc(p.name)}</h2>
        <div class="muted">Level ${p.level} · ${esc(p.title)}</div>
        <div class="cmp-tiers">${TIERS.map((t) => `<div>${medal(t, 'trophy', 54)}<b class="num">${p.trophies[t]}</b></div>`).join('')}</div>
        <div class="cmp-stats num">${p.xp} XP · ${p.streak} day streak</div>
      </div>`;
      const diff = me.trophies.total - friend.trophies.total;
      const verdict = diff === 0 ? "It's a tie!" : diff > 0 ? `${me.name} leads by ${diff} ${diff === 1 ? 'trophy' : 'trophies'}` : `${friend.name} leads by ${-diff} ${diff === -1 ? 'trophy' : 'trophies'}`;
      body.innerHTML = `<div class="panel compare-panel">
        <div class="kicker">Trophy battle</div>
        <div class="cmp-row">${col(me)}<div class="cmp-vs">VS</div>${col(friend)}</div>
        <div class="cmp-verdict">${esc(verdict)}</div>
        <div class="btn-row"><button class="btn" data-focus data-autofocus>${icon('check', 22)} Nice</button></div>
      </div>`;
      body.querySelector('.btn').addEventListener('click', () => closeOverlay(layer));
    },
  });
}
