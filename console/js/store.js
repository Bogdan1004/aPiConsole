// Shared console state with a tiny event bus.
import { api } from './api.js';

const listeners = new Map();

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}

export function emit(event, data) {
  (listeners.get(event) || []).forEach((fn) => fn(data));
}

const SETTINGS_KEY = 'apistation.settings';
const DEFAULT_SETTINGS = { sfx: 0.6, music: 0.5, performance: false, language: 'en' };

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export const store = {
  health: null,
  profiles: [],
  profile: null,
  quests: [],
  movies: [],
  albums: [],
  games: [],
  storeGames: [],
  filmRows: [],
  filmPicks: null,
  musicRows: [],
  musicPicks: null,
  fullSongs: false,
  driveRecent: null,
  session: null, // what /api/session said at boot (a remembered device skips the PIN)
  presence: {}, // profile id → { online, devices, activity } from the real-time link
  phones: 0, // phones paired with this console
  online: false, // real-time link up
  guest: false,
  home: null,
  recs: null,
  inbox: [],
  settings: loadSettings(),
};

export function saveSettings(patch) {
  Object.assign(store.settings, patch);
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(store.settings)); } catch { /* private mode */ }
  emit('settings', store.settings);
}

export function setProfile(profile) {
  store.profile = { ...store.profile, ...profile };
  const i = store.profiles.findIndex((p) => p.id === profile.id);
  if (i >= 0) store.profiles[i] = { ...store.profiles[i], ...profile };
  emit('profile', store.profile);
}

/** The other player (never the Guest; a guest has no friend here). */
export function friendOf(pid) {
  if (pid === 'guest') return null;
  return store.profiles.find((p) => p.id !== pid && !p.guest) || null;
}

export async function refreshProfile() {
  if (!store.profile) return;
  const data = await api.profile(store.profile.id);
  store.quests = data.quests;
  setProfile(data);
  emit('quests', store.quests);
}

export async function loadLibrary() {
  const [movies, albums, games, home, shop] = await Promise.all([api.movies(), api.albums(), api.games(), api.home(), api.storeCatalog()]);
  Object.assign(store, { movies, albums, games, home, storeGames: shop.games });
  emit('library', store);
}

/** Newest files in the Cloud Drive (Shared + own folder), with image thumbnails, for For You and Home. */
export async function loadDrive() {
  if (!store.profile) return;
  try {
    const files = await api.driveRecent(store.profile.id);
    store.driveRecent = files.map((f) => ({
      ...f, thumb: f.kind === 'image' ? `/api/drive/file?profile_id=${store.profile.id}&path=${encodeURIComponent(f.path)}` : null,
    }));
    emit('drive', store);
  } catch { /* drive unavailable */ }
}

/** Music rows (recently played, charts...) and Claude's playlist, for Home and the Music screen. */
export async function loadMusic() {
  if (!store.profile) return;
  const pid = store.profile.id;
  store.musicRows = [];
  store.musicPicks = null;
  try {
    const data = await api.musicHome(pid);
    store.musicRows = data.rows;
    store.fullSongs = data.full_songs;
    emit('music-data', store);
  } catch { /* offline: Home keeps the albums on the Pi */ }
  try {
    store.musicPicks = await api.musicPicks(pid);
    emit('music-data', store);
  } catch { /* Claude unavailable */ }
}

/** Movies rows (watch history, popular...) and Claude's film picks, for Home and the Movies screen. */
export async function loadFilms() {
  if (!store.profile) return;
  const pid = store.profile.id;
  store.filmRows = [];
  store.filmPicks = null;
  try {
    store.filmRows = (await api.filmsHome(pid)).rows;
    emit('films', store);
  } catch { /* offline: Home keeps the local shelf */ }
  try {
    store.filmPicks = await api.filmPicks(pid);
    emit('films', store);
  } catch { /* Claude unavailable */ }
}

export async function loadRecs(refresh = false) {
  if (!store.profile) return null;
  store.recs = await api.recommendations(store.profile.id, refresh);
  emit('recs', store.recs);
  return store.recs;
}

export async function loadInbox() {
  if (!store.profile) return [];
  store.inbox = await api.inbox(store.profile.id);
  emit('inbox', store.inbox);
  return store.inbox;
}

export function findItem(kind, id) {
  const list = { movie: store.movies, album: store.albums, game: store.games }[kind] || [];
  return list.find((it) => it.id === id) || null;
}
