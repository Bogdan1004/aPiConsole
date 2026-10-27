// Thin client for the aPiStation Hub. The console is served by the hub, so paths are same-origin.
const BASE = (window.APISTATION_HUB || '').replace(/\/$/, '');

async function request(method, path, body) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = res.statusText;
    let code = null;
    try { ({ detail = detail, code = null } = await res.json()); } catch { /* not JSON */ }
    // Signed out (expired session) or a guest trying to change something: main.js tells the person.
    if (code) window.dispatchEvent(new CustomEvent('apistation:auth', { detail: { code, message: detail } }));
    const err = new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** The free assistant: calls onDelta(text) while the local model writes, resolves with the final result. */
async function chat(profile_id, message, history, onDelta) {
  const res = await fetch(`${BASE}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile_id, message, chat: history }),
  });
  if (!res.ok) throw new Error(res.statusText);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.done) result = msg;
      else onDelta(msg.delta);
    }
  }
  if (!result) throw new Error('The assistant stopped answering');
  return result;
}

/** Uploads one file into a Cloud Drive folder; XHR because fetch can't report upload progress. */
function driveUpload(pid, folder, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `${BASE}/api/drive/upload?profile_id=${pid}&path=${encodeURIComponent(folder)}&name=${encodeURIComponent(file.name)}`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body?.detail || xhr.statusText || 'Upload failed'));
    };
    xhr.onerror = () => reject(new Error('Connection lost'));
    xhr.send(file);
  });
}

const trackBody = (t) => ({
  id: t.id, title: t.title, artist: t.artist, artist_id: t.artist_id, album: t.album, poster: t.poster, duration: t.duration,
});

export const api = {
  health: () => request('GET', '/health'),
  system: () => request('GET', '/system'),

  profiles: () => request('GET', '/profiles'),
  login: (pid, pin = '', remember = true) => request('POST', `/profiles/${pid}/login`, { pin, remember }),
  setPin: (pid, pin, old_pin = '') => request('POST', `/profiles/${pid}/pin`, { pin, old_pin }),
  session: () => request('GET', '/session'),
  logout: () => request('POST', '/session/logout'),
  profile: (pid) => request('GET', `/profiles/${pid}`),
  trophies: (pid) => request('GET', `/profiles/${pid}/trophies`),
  activity: (pid, limit = 30) => request('GET', `/profiles/${pid}/activity?limit=${limit}`),
  feed: (limit = 30) => request('GET', `/feed?limit=${limit}`),
  inbox: (pid) => request('GET', `/profiles/${pid}/inbox`),
  inboxSeen: (pid) => request('POST', `/profiles/${pid}/inbox/seen`),

  movies: () => request('GET', '/library/movies'),
  albums: () => request('GET', '/library/albums'),
  games: () => request('GET', '/library/games'),
  play: (profile_id, kind, item_id, target = 'tv') => request('POST', '/play', { profile_id, kind, item_id, target }),
  score: (profile_id, game_id, score) => request('POST', '/games/score', { profile_id, game_id, score }),
  deleteRom: (id) => request('POST', `/library/games/${id}/delete`),
  launcher: () => request('GET', '/launcher'),

  filmsHome: (pid) => request('GET', `/films/home?profile_id=${pid}`),
  filmPicks: (pid, refresh = false) => request('GET', `/films/picks?profile_id=${pid}&refresh=${refresh}`),
  filmSearch: (q) => request('GET', `/films/search?q=${encodeURIComponent(q)}`),
  filmDetails: (pid, id) => request('GET', `/films/${id}?profile_id=${pid}`),
  filmRate: (pid, id, rating) => request('POST', `/films/${id}/watched`, { profile_id: pid, rating }),
  filmUnwatch: (pid, id) => request('DELETE', `/films/${id}/watched?profile_id=${pid}`),
  filmList: (pid, id) => request('POST', `/films/${id}/list`, { profile_id: pid }),
  filmDownload: (pid, id) => request('POST', `/films/${id}/download`, { profile_id: pid }),
  filmJobs: () => request('GET', '/films/jobs'),
  filmDeleteFile: (id) => request('POST', `/films/${id}/delete-file`),

  musicHome: (pid) => request('GET', `/music/home?profile_id=${pid}`),
  musicPicks: (pid, refresh = false) => request('GET', `/music/picks?profile_id=${pid}&refresh=${refresh}`),
  musicSearch: (q) => request('GET', `/music/search?q=${encodeURIComponent(q)}`),
  musicArtist: (artistId) => request('GET', `/music/artist/${artistId}`),
  musicRadio: (pid, seed, exclude = []) =>
    request('GET', `/music/radio?profile_id=${pid}&seed=${seed}&exclude=${exclude.slice(-300).join(',')}`),
  musicSource: (pid, id) => request('GET', `/music/source/${id}?profile_id=${pid}`),
  musicStart: (pid, track) => request('POST', '/music/start', { profile_id: pid, track: trackBody(track) }),
  musicPlayed: (pid, track) => request('POST', '/music/played', { profile_id: pid, track: trackBody(track) }),
  musicRate: (pid, track, rating) => request('POST', '/music/rate', { profile_id: pid, track: trackBody(track), rating }),

  drive: (pid, path = '') => request('GET', `/drive?profile_id=${pid}&path=${encodeURIComponent(path)}`),
  driveRecent: (pid) => request('GET', `/drive/recent?profile_id=${pid}`),
  driveAction: (action, pid, body) => request('POST', `/drive/${action}`, { profile_id: pid, ...body }),
  driveLink: (pid, path) => request('POST', '/drive/link', { profile_id: pid, path }),
  driveUpload,

  storeCatalog: () => request('GET', '/store'),
  storeJobs: () => request('GET', '/store/jobs'),
  storeInstall: (profile_id, id) => request('POST', `/store/${id}/install`, { profile_id }),
  storeUninstall: (profile_id, id) => request('POST', `/store/${id}/uninstall`, { profile_id }),
  stopLauncher: () => request('POST', '/launcher/stop'),

  home: () => request('GET', '/home'),
  setDevice: (profile_id, id, change) => request('POST', `/home/devices/${id}`, { profile_id, ...change }),
  scene: (profile_id, id) => request('POST', `/home/scenes/${id}`, { profile_id }),

  share: (from_profile, to_profile, kind, item_id, message = '') =>
    request('POST', '/share', { from_profile, to_profile, kind, item_id, message }),

  recommendations: (profile_id, refresh = false) =>
    request('GET', `/ai/recommendations?profile_id=${profile_id}&refresh=${refresh}`),
  assistant: (profile_id, message, chat) => request('POST', '/ai/assistant', { profile_id, message, chat }),
  chat,
};
