// Background music player: synthesized demo albums, real streams (Navidrome), and songs from the internet
// catalog (Deezer) played in full on YouTube or as 30-second previews. Songs run as an endless queue: when it
// gets short, the hub's radio adds songs like the one playing.
import { api } from './api.js';
import { SynthTrack } from './synth.js';
import { emit, store } from './store.js';
import { onYoutube, youtube, YT_STATE } from './youtube.js';

const TRACK_SECONDS = 90;
const REFILL_AT = 4; // songs left in the queue before asking for more

const host = () => document.getElementById('yt-host');

export const music = {
  album: null, // what is playing: an album, or a mix ({ kind: 'mix', title }) for songs
  tracks: [],
  index: 0,
  playing: false,
  startedAt: 0,
  elapsedBefore: 0,
  synth: null,
  audio: null,
  timer: null,
  // songs
  endless: false,
  engine: null, // 'youtube' | 'preview' | 'loading' while a song is being looked up
  source: null, // { videos, preview } for the current song
  videoIndex: 0,
  played: new Set(),
  refilling: null,
  logged: false,
  ticker: null,
  token: 0,
  following: false, // listening together: the host's player decides what plays next

  async play(album, tracks = null, index = 0) {
    this.stopEngines();
    this.album = album;
    this.endless = false;
    this.tracks = tracks?.length ? tracks : (album.tracks || []).map((title) => ({ title }));
    this.index = Math.max(0, Math.min(index, this.tracks.length - 1));
    this.start();
  },

  /** Songs from the catalog, continuing forever with similar songs. */
  playSongs(mix, songs, index = 0) {
    this.stopEngines();
    this.album = { kind: 'mix', artist: '', ...mix };
    this.endless = true;
    this.tracks = songs.slice();
    this.index = Math.max(0, Math.min(index, songs.length - 1));
    this.played = new Set();
    this.start();
  },

  /** Put a song right after the current one (or start it when nothing is playing). */
  playNext(song) {
    if (!this.endless) return this.playSongs({ title: 'Your queue' }, [song]);
    this.tracks.splice(this.index + 1, 0, song);
    emit('music', this);
  },

  /** Skip ahead to a song in the queue. */
  jumpTo(id) {
    const i = this.tracks.findIndex((t, k) => k > this.index && t.id === id);
    if (i < 0) return;
    this.stopEngines();
    this.index = i;
    this.start();
  },

  get upNext() {
    return this.tracks.slice(this.index + 1, this.index + 6);
  },

  start() {
    const track = this.tracks[this.index];
    this.playing = true;
    this.startedAt = performance.now();
    this.elapsedBefore = 0;
    if (track?.kind === 'track') {
      this.startSong(track);
      return;
    }
    if (track?.url) {
      this.audio = new Audio(track.url);
      this.audio.volume = store.settings.music;
      this.audio.addEventListener('ended', () => this.next());
      this.audio.play().catch(() => {});
    } else {
      this.synth = new SynthTrack(this.album, this.index);
      this.synth.start();
      this.timer = setTimeout(() => this.next(), TRACK_SECONDS * 1000);
    }
    emit('music', this);
  },

  async startSong(track) {
    const token = ++this.token;
    this.engine = 'loading';
    this.source = null;
    this.logged = false;
    this.played.add(track.id);
    emit('music', this);
    this.refill();
    let src = {};
    try {
      src = await api.musicSource(store.profile.id, track.id);
    } catch { /* offline: skip below */ }
    if (token !== this.token) return; // skipped while looking it up
    this.source = src;
    track.rating_given = src.rating_given ?? track.rating_given;
    this.videoIndex = 0;
    clearInterval(this.ticker);
    this.ticker = setInterval(() => this.checkListened(), 4000);
    if (src.videos?.length && await youtube()) {
      if (token === this.token) this.playVideo();
    } else {
      this.playPreview();
    }
  },

  playVideo() {
    youtube().then((yt) => {
      const id = this.source.videos[this.videoIndex];
      this.engine = 'youtube';
      ytNow.time = 0;
      ytNow.duration = 0;
      yt.setVolume(Math.round(store.settings.music * 100));
      yt.loadVideoById({ videoId: id });
      if (!this.playing) yt.pauseVideo();
      host().classList.add('on');
      emit('music', this);
    });
  },

  playPreview() {
    host()?.classList.remove('on');
    if (!this.source?.preview) {
      this.engine = null;
      emit('music', this);
      // Nothing playable for this song: move on so the queue never stalls.
      this.timer = setTimeout(() => this.next(), 1200);
      return;
    }
    this.engine = 'preview';
    this.audio = new Audio(this.source.preview);
    this.audio.volume = store.settings.music;
    this.audio.addEventListener('ended', () => this.next());
    if (this.playing) this.audio.play().catch(() => {});
    emit('music', this);
  },

  /** Counts a song as listened once it has played for a while (history, Claude's picks, radio). */
  checkListened() {
    const t = this.track;
    if (this.logged || !t || t.kind !== 'track') return;
    const d = this.duration();
    if (this.elapsed() >= Math.min(30, (d || 60) * 0.5)) {
      this.logged = true;
      api.musicPlayed(store.profile.id, t).catch(() => {});
    }
  },

  /** Keeps the endless queue topped up with songs like the current one. */
  refill(force = false) {
    if (!this.endless || this.following || this.refilling) return this.refilling;
    if (!force && this.tracks.length - this.index > REFILL_AT) return null;
    const seed = this.tracks[this.index] || this.tracks[this.tracks.length - 1];
    if (!seed || !store.profile) return null;
    const queued = new Set(this.tracks.map((t) => t.id));
    this.refilling = api.musicRadio(store.profile.id, seed.id, [...new Set([...this.played, ...queued])])
      .then((more) => {
        this.tracks.push(...more.filter((t) => !queued.has(t.id)));
        emit('music', this);
      })
      .catch(() => {})
      .finally(() => { this.refilling = null; });
    return this.refilling;
  },

  stopEngines() {
    this.checkListened();
    this.token++;
    clearTimeout(this.timer);
    clearInterval(this.ticker);
    this.synth?.stop();
    this.synth = null;
    if (this.audio) {
      this.audio.pause();
      this.audio = null;
    }
    if (this.engine === 'youtube') youtube().then((yt) => yt?.stopVideo());
    host()?.classList.remove('on');
    this.engine = null;
  },

  toggle() {
    if (!this.album) return;
    if (this.playing) {
      this.elapsedBefore = this.elapsed();
      clearTimeout(this.timer);
      this.synth?.stop();
      this.synth = null;
      this.audio?.pause();
      if (this.engine === 'youtube') youtube().then((yt) => yt.pauseVideo());
      this.playing = false;
    } else {
      if (this.engine === 'youtube') youtube().then((yt) => yt.playVideo());
      else if (this.audio) this.audio.play();
      else if (this.track?.kind === 'track') this.startSong(this.track);
      else {
        this.synth = new SynthTrack(this.album, this.index);
        this.synth.start();
        this.timer = setTimeout(() => this.next(), (TRACK_SECONDS - this.elapsedBefore) * 1000);
      }
      this.startedAt = performance.now();
      this.playing = true;
    }
    emit('music', this);
  },

  next() {
    if (!this.album) return;
    this.stopEngines();
    if (this.following) {
      // Listening together: wait for the host's next song.
      this.playing = false;
      emit('music', this);
      return;
    }
    if (!this.endless) {
      this.index = (this.index + 1) % this.tracks.length;
      this.start();
      return;
    }
    if (this.index + 1 < this.tracks.length) {
      this.index++;
      this.start();
      return;
    }
    // The queue ran out before the radio answered: wait for it, then carry on.
    this.engine = 'loading';
    emit('music', this);
    Promise.resolve(this.refill(true)).then(() => {
      if (this.index + 1 < this.tracks.length) {
        this.index++;
        this.start();
      } else {
        this.stop();
      }
    });
  },

  prev() {
    if (!this.album) return;
    if (this.endless && (this.elapsed() > 5 || this.index === 0)) {
      this.stopEngines();
      this.start();
      return;
    }
    this.stopEngines();
    this.index = (this.index - 1 + this.tracks.length) % this.tracks.length;
    this.start();
  },

  /** Jump to a position in the current song (listening together keeps everyone in sync). */
  seek(seconds) {
    if (this.engine === 'youtube') youtube().then((yt) => yt?.seekTo(seconds, true));
    else if (this.audio) this.audio.currentTime = Math.min(seconds, (this.audio.duration || 30) - 0.5);
  },

  stop() {
    this.stopEngines();
    this.album = null;
    this.endless = false;
    this.following = false;
    this.playing = false;
    emit('music', this);
  },

  elapsed() {
    if (this.engine === 'youtube') return ytNow.time;
    if (this.audio) return this.audio.currentTime;
    if (this.track?.kind === 'track') return 0;
    return this.elapsedBefore + (this.playing ? (performance.now() - this.startedAt) / 1000 : 0);
  },

  duration() {
    if (this.engine === 'youtube') return ytNow.duration || this.track?.duration || 0;
    if (this.audio) return this.audio.duration || this.tracks[this.index]?.duration || 0;
    if (this.track?.kind === 'track') return this.track.duration || 0;
    return TRACK_SECONDS;
  },

  levels(n = 16) {
    if (this.synth) return this.synth.levels(n);
    const t = performance.now() / 1000;
    return Array.from({ length: n }, (_, i) => (this.playing ? 0.3 + 0.3 * Math.abs(Math.sin(t * 3 + i * 0.7)) : 0.05));
  },

  get track() {
    return this.tracks[this.index] || null;
  },
};

// The IFrame API has no events for time, so the current position is polled (cheap, and only while a video plays).
const ytNow = { time: 0, duration: 0 };
setInterval(() => {
  if (music.engine !== 'youtube') return;
  youtube().then((yt) => {
    ytNow.time = yt.getCurrentTime?.() || 0;
    ytNow.duration = yt.getDuration?.() || 0;
  });
}, 500);

onYoutube(
  (state) => {
    if (music.engine !== 'youtube') return;
    if (state === YT_STATE.ended) music.next();
  },
  () => {
    if (music.engine !== 'youtube') return;
    // 101/150: the owner blocks playback outside YouTube; 100: removed. Try the next match, then the preview.
    music.videoIndex++;
    if (music.videoIndex < music.source.videos.length) music.playVideo();
    else {
      music.engine = null;
      music.playPreview();
    }
  },
);
