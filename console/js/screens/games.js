import { deleteGame } from '../gamestore.js';
import { icon } from '../icons.js';
import { playItem } from '../playback.js';
import { go } from '../router.js';
import { on, store } from '../store.js';
import { browseScreen } from './browse.js';

// Re-open the screen once a delete went through so the shelf matches the Pi.
async function remove(item) {
  if (!(await deleteGame(item))) return;
  const off = on('library', () => {
    off();
    go('games', {}, { replace: true });
  });
  if (item.source === 'roms') {
    off();
    go('games', {}, { replace: true });
  }
}

export default browseScreen({
  hue: [290, 330],
  crumb: 'Games',
  aspect: 'wide',
  shelfTitle: ['gamepad', 'Your games'],
  items: () => store.games,
  kicker: (g) => g.platform,
  meta: (g) => [g.genre, g.players ? `${icon('users', 18)} ${g.players} players` : null, g.year],
  tags: (g) => [g.launch?.type === 'retroarch' ? 'RetroArch' : g.launch?.type === 'builtin' ? 'Built in' : 'Native', g.web ? 'Browser play' : null].filter(Boolean),
  status: (g) => (g.available || g.web ? { label: `${icon('check', 16)} Ready`, tone: 'ok' } : { label: `${icon('lock', 16)} Setup needed`, tone: 'warn' }),
  description: (g) => g.description,
  askPrompt: (g) => `Give me tips for ${g.title}, and suggest a game we could play together after.`,
  extraButtons: (g) => [
    g.launch?.type === 'retroarch' && g.available && !store.guest
      ? `<button class="btn" data-focus data-act="netplay">${icon('users', 22)} Play online</button>` : '',
    g.source === 'builtin' ? '' : `<button class="icon-btn" data-focus data-act="delete" title="Delete">${icon('trash', 24)}</button>`,
  ].join(''),
  onAct: (act, g) => {
    if (act === 'netplay') playItem(g, 'tv', { netplay: true });
    if (act === 'delete') remove(g);
    if (act === 'store') go('store');
  },
  shelfTail: `<button class="card browse-wide shelf-cta" data-focus data-act="store">
    <span class="cover cover-wide icon-cover" style="--ch:196">${icon('bag', 64, 1.5)}</span>
    <div class="card-label">Get more games</div></button>`,
});
