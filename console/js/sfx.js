// UI sound design, synthesized with WebAudio (no audio files needed).
import { store, on } from './store.js';

let ctx = null;
let sfxBus = null;
let musicBus = null;

export function audioCtx() {
  if (!ctx) {
    ctx = new AudioContext();
    sfxBus = ctx.createGain();
    sfxBus.gain.value = store.settings.sfx;
    sfxBus.connect(ctx.destination);
    musicBus = ctx.createGain();
    musicBus.gain.value = store.settings.music;
    musicBus.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

export function getMusicBus() {
  audioCtx();
  return musicBus;
}

on('settings', (s) => {
  if (sfxBus) sfxBus.gain.value = s.sfx;
  if (musicBus) musicBus.gain.value = s.music;
});

function tone({ freq, type = 'sine', start = 0, dur = 0.12, vol = 0.3, slide = null, attack = 0.005, dest = null }) {
  const c = audioCtx();
  const t = c.currentTime + start;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slide) osc.frequency.exponentialRampToValueAtTime(slide, t + dur);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.linearRampToValueAtTime(vol, t + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain).connect(dest || sfxBus);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

const muted = () => store.settings.sfx <= 0;

export const sfx = {
  move() {
    if (muted()) return;
    tone({ freq: 1480, dur: 0.045, vol: 0.06 });
    tone({ freq: 2960, dur: 0.03, vol: 0.015 });
  },
  select() {
    if (muted()) return;
    tone({ freq: 660, type: 'triangle', dur: 0.09, vol: 0.16 });
    tone({ freq: 990, type: 'triangle', start: 0.055, dur: 0.14, vol: 0.14 });
  },
  back() {
    if (muted()) return;
    tone({ freq: 560, type: 'triangle', dur: 0.12, vol: 0.13, slide: 340 });
  },
  error() {
    if (muted()) return;
    tone({ freq: 196, type: 'square', dur: 0.12, vol: 0.05 });
    tone({ freq: 147, type: 'square', start: 0.1, dur: 0.18, vol: 0.05 });
  },
  toggle(onState) {
    if (muted()) return;
    tone({ freq: onState ? 880 : 520, type: 'sine', dur: 0.08, vol: 0.14, slide: onState ? 1320 : 360 });
  },
  open() {
    if (muted()) return;
    tone({ freq: 392, type: 'sine', dur: 0.25, vol: 0.1, slide: 784, attack: 0.03 });
  },
  xp() {
    if (muted()) return;
    [1046, 1318, 1568].forEach((f, i) => tone({ freq: f, start: i * 0.05, dur: 0.16, vol: 0.08 }));
  },
  quest() {
    if (muted()) return;
    [784, 988, 1175, 1568].forEach((f, i) => tone({ freq: f, type: 'triangle', start: i * 0.08, dur: 0.25, vol: 0.12 }));
  },
  trophy(tier = 'bronze') {
    if (muted()) return;
    const base = { bronze: 523, silver: 587, gold: 659, platinum: 784 }[tier] || 523;
    [1, 1.25, 1.5, 2].forEach((m, i) => tone({ freq: base * m, type: 'triangle', start: i * 0.07, dur: 0.9, vol: 0.1 }));
    for (let i = 0; i < 6; i++) tone({ freq: base * 4 * (1 + i * 0.12), start: 0.35 + i * 0.05, dur: 0.2, vol: 0.03 });
  },
  levelup() {
    if (muted()) return;
    [523, 659, 784, 1046].forEach((f, i) => tone({ freq: f, type: 'square', start: i * 0.1, dur: 0.14, vol: 0.06 }));
    [523, 659, 784, 1046, 1318].forEach((f) => tone({ freq: f, type: 'triangle', start: 0.45, dur: 1.4, vol: 0.08 }));
  },
  boot() {
    if (muted()) return;
    const c = audioCtx();
    const t = c.currentTime;
    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(300, t);
    filter.frequency.exponentialRampToValueAtTime(4000, t + 1.6);
    filter.connect(sfxBus);
    [130.8, 196, 261.6, 329.6].forEach((f, i) => {
      [-6, 6].forEach((detune) => {
        const osc = c.createOscillator();
        const g = c.createGain();
        osc.type = 'sawtooth';
        osc.frequency.value = f;
        osc.detune.value = detune;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.035, t + 0.8 + i * 0.1);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 3.2);
        osc.connect(g).connect(filter);
        osc.start(t);
        osc.stop(t + 3.3);
      });
    });
    [1046, 1568, 2093].forEach((f, i) => tone({ freq: f, start: 1.2 + i * 0.12, dur: 1.2, vol: 0.05 }));
  },
};
