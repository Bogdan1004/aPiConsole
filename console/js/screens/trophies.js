// Trophies & progress: level, XP, tier counts, daily quests and the full trophy cabinet.
import { api } from '../api.js';
import { mountTopbar, questCard, ring } from '../chrome.js';
import { icon } from '../icons.js';
import { refreshProfile, store } from '../store.js';
import { esc, hints, medal } from '../ui.js';

const TIERS = ['platinum', 'gold', 'silver', 'bronze'];

export default {
  hue: [44, 18],
  async mount(el) {
    await refreshProfile().catch(() => {});
    const p = store.profile;
    const trophies = await api.trophies(p.id);
    const done = trophies.filter((t) => t.unlocked).length;
    trophies.sort((a, b) => Number(b.unlocked) - Number(a.unlocked) || b.progress / b.target - a.progress / a.target);
    const toNext = p.level_ceil - p.xp;

    el.innerHTML = `
      <div class="panel tr-header">
        ${ring(p, 150)}
        <div class="tr-level"><div class="kicker">Level</div><div class="tr-num num">${p.level}</div></div>
        <div class="tr-xp">
          <h2 class="title-lg">${esc(p.title)}</h2>
          <div class="xpbar big"><i style="width:${Math.round(p.progress * 100)}%"></i></div>
          <p class="muted"><span class="num">${p.xp - p.level_floor} / ${p.level_ceil - p.level_floor} XP</span> · ${toNext} XP to level ${p.level + 1}${p.next_title ? ` · “${esc(p.next_title.title)}” at level ${p.next_title.level}` : ''}</p>
        </div>
        <div class="tr-tiers">${TIERS.map((t) => `<div class="tr-tier">${medal(t, 'trophy', 64)}<b class="num">${p.trophies[t]}</b></div>`).join('')}</div>
        <div class="tr-complete"><div class="num">${Math.round((done / trophies.length) * 100)}%</div><span class="dim">${done}/${trophies.length}</span></div>
      </div>
      <div class="tr-quests">
        <div class="row-title">${icon('target', 26)} Daily quests</div>
        <div class="quest-list">${(store.quests || []).map(questCard).join('')}</div>
        <div class="streak-card"><span class="streak-flame">${icon('flame', 46)}</span><div><b class="num">${p.streak} day streak</b><p class="muted">Sign in every day to keep the fire going. 7 days unlocks “Unstoppable”.</p></div></div>
      </div>
      <div class="tr-grid" data-group="trophies" data-scroll="y" data-scroll-pad="24">
        ${trophies.map((t) => `<div class="trophy-card ${t.unlocked ? '' : 'locked'}" data-focus>
          ${medal(t.unlocked ? t.tier : 'locked', t.unlocked ? t.icon : 'lock', 70)}
          <div class="tc-body">
            <div class="tc-name">${esc(t.name)}</div>
            <div class="tc-desc">${esc(t.description)}</div>
            ${t.unlocked
              ? `<div class="tc-date dim">${icon('check', 16)} Unlocked ${esc(t.unlocked_at.slice(0, 10))}</div>`
              : `<div class="tc-progress"><div class="bar"><i style="width:${(t.progress / t.target) * 100}%"></i></div><span class="num dim">${t.progress}/${t.target}</span></div>`}
          </div>
          <span class="tc-tier tier-${t.tier}">${t.tier}</span>
        </div>`).join('')}
      </div>
      ${hints([['a', 'Select'], ['b', 'Back']])}`;
    const cleanup = mountTopbar(el, 'Trophies');
    return { unmount: cleanup };
  },
};
