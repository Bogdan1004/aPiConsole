// Seeded chiptune generator: every demo album gets its own little soundtrack.
import { audioCtx, getMusicBus } from './sfx.js';
import { rng } from './art.js';

const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
};
const PROGRESSIONS = [[0, 5, 3, 4], [0, 3, 4, 3], [0, 4, 5, 3], [5, 3, 0, 4], [0, 6, 5, 4], [0, 2, 3, 4]];
const PRESETS = {
  Chiptune: { lead: 'square', bass: 'triangle', drums: 'full', density: 0.7, swing: 0, cutoff: 7000, leadVol: 0.07 },
  'Lo-Fi': { lead: 'triangle', bass: 'sine', drums: 'soft', density: 0.32, swing: 0.14, cutoff: 1600, leadVol: 0.12 },
  Synthwave: { lead: 'sawtooth', bass: 'sawtooth', drums: 'full', density: 0.42, swing: 0, cutoff: 2400, leadVol: 0.06 },
  Ambient: { lead: 'sine', bass: 'sine', drums: null, density: 0.16, swing: 0, cutoff: 1800, leadVol: 0.12, pad: true },
  Funk: { lead: 'square', bass: 'square', drums: 'full', density: 0.5, swing: 0.08, cutoff: 2800, leadVol: 0.05, busyBass: true },
  Jazz: { lead: 'triangle', bass: 'triangle', drums: 'soft', density: 0.38, swing: 0.22, cutoff: 2600, leadVol: 0.1 },
};

const midi = (n) => 440 * 2 ** ((n - 69) / 12);

let noise = null;
function noiseBuffer(c) {
  if (!noise) {
    noise = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  return noise;
}

function compose(album, trackIndex) {
  const r = rng(`${album.id}:${trackIndex}`);
  const scale = SCALES[album.scale] || SCALES.major;
  const root = (album.root || 60) + (trackIndex % 2 ? -2 : 0);
  const prog = PROGRESSIONS[Math.floor(r() * PROGRESSIONS.length)];
  const preset = PRESETS[album.genre] || PRESETS.Chiptune;
  const degree = (d) => root + scale[((d % 7) + 7) % 7] + 12 * Math.floor(d / 7);

  const motif = () => {
    const notes = [];
    let pos = Math.floor(r() * 5);
    for (let s = 0; s < 32; s++) {
      if (r() < preset.density * (s % 4 === 0 ? 1.4 : s % 2 === 0 ? 1 : 0.6)) {
        pos = Math.max(-2, Math.min(9, pos + Math.floor(r() * 5) - 2));
        notes.push({ step: s, deg: pos, len: r() < 0.3 ? 2 : 1 });
      }
    }
    return notes;
  };
  return { preset, prog, degree, motifs: [motif(), motif()], bpm: album.bpm || 110 };
}

export class SynthTrack {
  constructor(album, trackIndex) {
    this.song = compose(album, trackIndex);
    this.c = audioCtx();
    this.out = this.c.createBiquadFilter();
    this.out.type = 'lowpass';
    this.out.frequency.value = this.song.preset.cutoff;
    this.analyser = this.c.createAnalyser();
    this.analyser.fftSize = 64;
    this.gain = this.c.createGain();
    this.gain.gain.value = 0.9;
    this.out.connect(this.analyser).connect(this.gain).connect(getMusicBus());
    this.step = 0;
    this.timer = null;
  }

  start() {
    this.nextTime = this.c.currentTime + 0.08;
    this.timer = setInterval(() => this.tick(), 25);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    const t = this.c.currentTime;
    this.gain.gain.setTargetAtTime(0, t, 0.05);
    setTimeout(() => this.gain.disconnect(), 400);
  }

  get stepDur() {
    return 60 / this.song.bpm / 4;
  }

  tick() {
    while (this.nextTime < this.c.currentTime + 0.15) {
      const swing = this.step % 2 ? this.song.preset.swing * this.stepDur : 0;
      this.schedule(this.step, this.nextTime + swing);
      this.nextTime += this.stepDur;
      this.step++;
    }
  }

  schedule(step, t) {
    const { preset, prog, degree, motifs } = this.song;
    const bar = Math.floor(step / 16) % 8;
    const s = step % 16;
    const chord = prog[bar % 4];
    const sd = this.stepDur;

    // Bass
    const bassSteps = preset.busyBass ? [0, 3, 6, 8, 10, 14] : [0, 8];
    if (bassSteps.includes(s)) {
      const n = degree(chord) - 24 + (s === 8 && preset.busyBass ? 12 : 0);
      this.note(midi(n), t, sd * (preset.busyBass ? 1.5 : 6), preset.bass, 0.16);
    }
    // Pad / chord stabs
    if (preset.pad && s === 0 && bar % 2 === 0) {
      [0, 2, 4].forEach((i) => this.note(midi(degree(chord + i) - 12), t, sd * 30, 'sine', 0.05, 0.8));
    } else if (!preset.pad && s === 0) {
      [0, 2, 4].forEach((i) => this.note(midi(degree(chord + i)), t, sd * 3, 'triangle', 0.025));
    }
    // Lead: motif A twice, then motif B twice
    const motif = motifs[bar < 4 ? 0 : 1];
    const local = ((bar % 2) * 16) + s;
    for (const n of motif) {
      if (n.step === local) this.note(midi(degree(n.deg + chord) + 12), t, sd * n.len * 0.95, preset.lead, preset.leadVol);
    }
    // Drums
    if (preset.drums) {
      const full = preset.drums === 'full';
      if (s === 0 || s === 8 || (full && s === 10 && bar % 2)) this.kick(t, full ? 0.5 : 0.35);
      if (s === 4 || s === 12) this.snare(t, full ? 0.18 : 0.1);
      if (s % 2 === 0 || (full && s % 4 === 3)) this.hat(t, s % 4 === 2 ? 0.05 : 0.03);
    }
  }

  note(freq, t, dur, type, vol, attack = 0.005) {
    const osc = this.c.createOscillator();
    const g = this.c.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.setTargetAtTime(0.0001, t + Math.max(dur - 0.02, attack), dur * 0.25 + 0.02);
    osc.connect(g).connect(this.out);
    osc.start(t);
    osc.stop(t + dur + 0.5);
  }

  kick(t, vol) {
    const osc = this.c.createOscillator();
    const g = this.c.createGain();
    osc.frequency.setValueAtTime(150, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    osc.connect(g).connect(this.out);
    osc.start(t);
    osc.stop(t + 0.25);
  }

  noiseHit(t, vol, freq, dur) {
    const src = this.c.createBufferSource();
    src.buffer = noiseBuffer(this.c);
    const hp = this.c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = freq;
    const g = this.c.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(hp).connect(g).connect(this.out);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
  }

  snare(t, vol) {
    this.noiseHit(t, vol, 1400, 0.16);
    this.note(190, t, 0.06, 'triangle', vol * 0.5);
  }

  hat(t, vol) {
    this.noiseHit(t, vol, 7500, 0.04);
  }

  levels(n = 16) {
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(data);
    return Array.from({ length: n }, (_, i) => data[Math.floor((i / n) * data.length * 0.8)] / 255);
  }
}
