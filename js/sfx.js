// Tiny Web Audio sound effects (no audio files needed).
import { state } from './state.js';

let ctx;
// Never make noise while the page is in the background / another tab.
const silent = () => state.muted || document.hidden;
document.addEventListener('visibilitychange', () => { if (ctx) (document.hidden ? ctx.suspend() : ctx.resume()).catch(() => {}); });
function ac() {
  if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; } }
  if (ctx.state === 'suspended' && !document.hidden) ctx.resume();
  return ctx;
}

function tone(freq, dur, { type = 'sine', gain = 0.06, at = 0, slide } = {}) {
  if (silent()) return;
  const a = ac(); if (!a) return;
  const t = a.currentTime + at;
  const o = a.createOscillator(); const g = a.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
  g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination); o.start(t); o.stop(t + dur + 0.02);
}

// ---- noise-based sounds (explosion, clicks) ----------------------------------------------------
let noiseBuf;
function getNoise(a) {
  if (!noiseBuf) {
    const len = a.sampleRate * 2;
    noiseBuf = a.createBuffer(1, len, a.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }
  return noiseBuf;
}

function noiseBurst(a, dest, t, dur, { type = 'lowpass', freq = 1000, q = 0.7, gain = 0.3, attack = 0.005, sweepTo } = {}) {
  const src = a.createBufferSource(); src.buffer = getNoise(a); src.loop = true;
  const f = a.createBiquadFilter(); f.type = type; f.Q.value = q;
  f.frequency.setValueAtTime(freq, t);
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(dest);
  src.start(t, Math.random() * 1.5); src.stop(t + dur + 0.05);
}

/** Layered landmine blast: sharp crack + broadband body + low rumble + sub thump + falling debris. */
function explosion() {
  if (silent()) return;
  const a = ac(); if (!a) return;
  const t = a.currentTime + 0.01;
  const comp = a.createDynamicsCompressor();
  comp.threshold.value = -20; comp.knee.value = 10; comp.ratio.value = 8; comp.attack.value = 0.002; comp.release.value = 0.3;
  const master = a.createGain(); master.gain.value = 0.85;
  master.connect(comp).connect(a.destination);

  noiseBurst(a, master, t, 0.09, { type: 'highpass', freq: 1800, gain: 0.7, attack: 0.001 });          // crack
  noiseBurst(a, master, t, 1.6, { type: 'lowpass', freq: 6000, sweepTo: 160, gain: 1, attack: 0.004 });  // body
  noiseBurst(a, master, t + 0.04, 2.6, { type: 'lowpass', freq: 220, sweepTo: 60, q: 1.2, gain: 0.9, attack: 0.05 }); // rumble

  const o = a.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(30, t + 0.6);
  const og = a.createGain();
  og.gain.setValueAtTime(0.0001, t); og.gain.exponentialRampToValueAtTime(1.1, t + 0.006); og.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
  o.connect(og).connect(master); o.start(t); o.stop(t + 0.85);                                          // sub thump

  for (let i = 0; i < 9; i++) {                                                                          // debris
    noiseBurst(a, master, t + 0.18 + Math.random() * 0.9, 0.03 + Math.random() * 0.05,
      { type: 'bandpass', freq: 1500 + Math.random() * 3500, q: 3, gain: 0.08 + Math.random() * 0.1, attack: 0.002 });
  }
}

function press() {
  if (silent()) return;
  const a = ac(); if (!a) return;
  noiseBurst(a, a.destination, a.currentTime, 0.05, { type: 'bandpass', freq: 900, q: 2, gain: 0.12, attack: 0.002 });
}

/** Crystal chime that climbs in pitch with each gem found. */
function gemChime(step = 0) {
  const base = 660 * Math.pow(2, Math.min(step, 14) / 12 * 1.5);
  tone(base, 0.35, { type: 'sine', gain: 0.07 });
  tone(base * 2.76, 0.18, { type: 'sine', gain: 0.025 });
  tone(base * 1.5, 0.3, { type: 'triangle', gain: 0.04, at: 0.06 });
  if (!silent()) { const a = ac(); if (a) noiseBurst(a, a.destination, a.currentTime, 0.2, { type: 'highpass', freq: 7000, gain: 0.03, attack: 0.01 }); }
}

// ---- coinflip suspense sounds --------------------------------------------------------------------
function whoosh() {
  if (silent()) return; const a = ac(); if (!a) return;
  noiseBurst(a, a.destination, a.currentTime, 0.5, { type: 'bandpass', freq: 400, sweepTo: 2600, q: 1.4, gain: 0.18, attack: 0.08 });
}
function heartbeat(intensity = 0) {
  if (silent()) return;
  tone(62 + intensity * 10, 0.16, { type: 'sine', gain: 0.22 });
  tone(55 + intensity * 10, 0.14, { type: 'sine', gain: 0.16, at: 0.16 });
}
function flick(pitch = 0) { tone(900 + pitch * 900, 0.04, { type: 'triangle', gain: 0.035 }); }
function thud() {
  if (silent()) return; const a = ac(); if (!a) return;
  tone(110, 0.35, { type: 'sine', gain: 0.35, slide: 40 });
  noiseBurst(a, a.destination, a.currentTime, 0.18, { type: 'lowpass', freq: 900, sweepTo: 120, gain: 0.3, attack: 0.002 });
}

export const sfx = {
  whoosh, heartbeat, flick, thud,
  explosion, press, gemChime,
  tick: () => tone(1500, 0.03, { type: 'square', gain: 0.025 }),
  click: () => tone(700, 0.05, { type: 'triangle', gain: 0.05 }),
  gem: () => { tone(880, 0.1, { type: 'triangle' }); tone(1320, 0.15, { type: 'triangle', at: 0.06 }); },
  win: () => [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.22, { type: 'triangle', gain: 0.07, at: i * 0.08 })),
  big: () => [523, 659, 784, 1046, 1318, 1568].forEach((f, i) => tone(f, 0.3, { type: 'square', gain: 0.04, at: i * 0.07 })),
  lose: () => tone(300, 0.4, { type: 'sawtooth', gain: 0.05, slide: 90 }),
  boom: () => tone(160, 0.5, { type: 'sawtooth', gain: 0.08, slide: 40 }),
};
