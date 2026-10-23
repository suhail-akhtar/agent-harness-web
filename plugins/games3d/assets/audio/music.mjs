// Procedural music loops from a chord progression: chiptune (square lead and arpeggio,
// triangle bass, noise drums) or ambient (slow pads, a sparse bell melody, sub bass and
// echoes). Notes that ring past the end wrap to the start, so the loop is seamless.

import { rng } from '../util/rng.mjs';
import { dcBlock } from './wav.mjs';

const NOTE = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
export const SCALES = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10], dorian: [0, 2, 3, 5, 7, 9, 10], mixolydian: [0, 2, 4, 5, 7, 9, 10], pentatonic: [0, 2, 4, 7, 9], harmonic: [0, 2, 3, 5, 7, 8, 11] };
const ROMAN = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii'];

const midiHz = (m) => 440 * 2 ** ((m - 69) / 12);

/** A key name (C, F#, Bb, a) as a MIDI note in octave 4. */
export function keyRoot(key = 'C') {
  const m = /^([a-g])([#b]?)/i.exec(String(key).trim());
  if (!m) throw new Error(`not a key: ${key}`);
  return 60 + NOTE[m[1].toLowerCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}

/**
 * Chords from a progression: roman numerals in the key ("I V vi IV", "i VI III VII") or
 * chord names ("Am F C G", "Dm7 G7 Cmaj7"). Each chord is a list of MIDI notes from its root.
 */
export function parseProgression(progression, key = 'C', scale = 'major') {
  const root = keyRoot(key);
  const steps = SCALES[scale] ?? SCALES.major;
  return String(progression).trim().split(/[\s,|-]+/).filter(Boolean).map((tok) => {
    const roman = /^(b|#)?(vii|vi|v|iv|iii|ii|i)(°|o|dim|7|maj7|sus4)?$/i.exec(tok);
    if (roman) {
      const deg = ROMAN.indexOf(roman[2].toLowerCase());
      const minor = roman[2] === roman[2].toLowerCase();
      const shift = roman[1] === 'b' ? -1 : roman[1] === '#' ? 1 : 0;
      const r = root + (SCALES.major[deg] ?? 0) + shift + (scale !== 'major' && steps.length === 7 ? steps[deg] - SCALES.major[deg] : 0);
      const q = roman[3]?.toLowerCase();
      const third = q === 'sus4' ? 5 : minor || q === '°' || q === 'o' || q === 'dim' ? 3 : 4;
      const fifth = q === '°' || q === 'o' || q === 'dim' ? 6 : 7;
      const notes = [r, r + third, r + fifth];
      if (q === '7') notes.push(r + (minor ? 10 : 10));
      if (q === 'maj7') notes.push(r + 11);
      return { name: tok, notes };
    }
    const named = /^([a-g])([#b]?)(m(?!aj)|min|dim|°)?(maj7|7|sus4|sus2)?$/i.exec(tok);
    if (!named) throw new Error(`not a chord: ${tok} (use roman numerals like "I V vi IV" or names like "C G Am F")`);
    let r = 60 + NOTE[named[1].toLowerCase()] + (named[2] === '#' ? 1 : named[2] === 'b' ? -1 : 0);
    if (r - root > 6) r -= 12;
    const minor = !!named[3] && named[3] !== 'dim' && named[3] !== '°';
    const dim = named[3] === 'dim' || named[3] === '°';
    const ext = named[4]?.toLowerCase();
    const notes = [r, r + (ext === 'sus4' ? 5 : ext === 'sus2' ? 2 : minor || dim ? 3 : 4), r + (dim ? 6 : 7)];
    if (ext === '7') notes.push(r + 10);
    if (ext === 'maj7') notes.push(r + 11);
    return { name: tok, notes };
  });
}

// ---------- voices ----------

function adsr(t, dur, { a = 0.005, d = 0.08, s = 0.6, r = 0.08 }) {
  if (t < a) return t / a;
  if (t < a + d) return 1 - (1 - s) * ((t - a) / d);
  if (t < dur) return s;
  return Math.max(0, s * (1 - (t - dur) / r));
}

/** Adds a note into a looping buffer (wrapping at the end). */
function addNote(buf, sr, start, dur, hz, voice, gain) {
  const env = voice.env ?? {};
  const len = Math.ceil((dur + (env.r ?? 0.08)) * sr);
  const s0 = Math.round(start * sr);
  let ph = 0, lp = 0;
  const nr = voice.wave === 'noise' ? rng(`${start}:${hz}`) : null;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const vib = voice.vibrato ? 1 + Math.sin(t * 2 * Math.PI * 5.5) * voice.vibrato * Math.min(1, t * 4) : 1;
    const f = (voice.drop ? hz * (1 + voice.drop * Math.exp(-t * 40)) : hz) * vib;
    ph = (ph + f / sr) % 1;
    let v;
    switch (voice.wave) {
      case 'square': v = ph < (voice.duty ?? 0.5) ? 0.5 : -0.5; break;
      case 'triangle': v = 1 - 4 * Math.abs(ph - 0.5); v = Math.round(v * 8) / 8; break;
      case 'saw': v = 1 - 2 * ph; break;
      case 'noise': v = nr.next() * 2 - 1; break;
      case 'bell': v = Math.sin(ph * 2 * Math.PI) * 0.7 + Math.sin(ph * 2 * Math.PI * 2.76) * 0.3 * Math.exp(-t * 6); break;
      case 'pad': { const p2 = (ph * 1.004) % 1, p3 = (ph * 0.996) % 1; v = (Math.sin(ph * 2 * Math.PI) + 0.5 * (1 - 2 * p2) + 0.5 * (1 - 2 * p3)) / 2; break; }
      default: v = Math.sin(ph * 2 * Math.PI);
    }
    if (voice.lowpass) { lp += (v - lp) * voice.lowpass; v = lp; }
    const e = voice.decay ? Math.exp(-t * voice.decay) * Math.min(1, t / 0.002) : adsr(t, dur, env);
    const k = (s0 + i) % buf.length;
    buf[k] += v * e * gain;
  }
}

function drum(buf, sr, start, kind, gain) {
  if (kind === 'kick') addNote(buf, sr, start, 0.12, 52, { wave: 'sine', drop: 2.2, decay: 18 }, gain);
  else if (kind === 'snare') { addNote(buf, sr, start, 0.12, 1, { wave: 'noise', decay: 22, lowpass: 0.6 }, gain * 0.7); addNote(buf, sr, start, 0.08, 185, { wave: 'triangle', decay: 30 }, gain * 0.5); }
  else addNote(buf, sr, start, 0.03, 1, { wave: 'noise', decay: 90 }, gain * 0.35);
}

/** A feedback echo over the loop (wraps, so the loop stays seamless). */
function echo(buf, sr, seconds, feedback, mix) {
  const d = Math.round(seconds * sr), out = Float32Array.from(buf);
  for (let pass = 0; pass < 2; pass++) for (let i = 0; i < buf.length; i++) out[i] += out[(i - d + buf.length * 4) % buf.length] * feedback * (pass ? 0.5 : 1) * mix;
  return out;
}

/**
 * A loop: { samples, sampleRate, duration, bars, chords, bpm }. style chiptune | ambient;
 * barsPerChord (1), repeats of the progression (2), bpm (chiptune 120, ambient 70).
 */
export function music({ style = 'chiptune', progression, key = 'C', scale, bpm, barsPerChord = 1, repeats = 2, seed = 0, sampleRate = 44100 } = {}) {
  const sc = scale ?? (style === 'ambient' ? 'major' : 'major');
  const chords = parseProgression(progression ?? (style === 'ambient' ? 'I vi IV V' : 'I V vi IV'), key, sc);
  const tempo = bpm ?? (style === 'ambient' ? 70 : 120);
  const beat = 60 / tempo, bar = beat * 4, step16 = beat / 4;
  const bars = chords.length * barsPerChord * repeats;
  const duration = bars * bar;
  const buf = new Float32Array(Math.round(duration * sampleRate));
  const r = rng(`${seed}:${style}`);
  const steps = SCALES[sc] ?? SCALES.major;
  const root = keyRoot(key);
  const scaleNotes = [];
  for (let o = -2; o <= 2; o++) for (const s of steps) scaleNotes.push(root + o * 12 + s);
  const chordAt = (b) => chords[Math.floor(b / barsPerChord) % chords.length];
  // A melody: two-bar phrases, repeated with variations (A A' B A'').
  const phrase = (len) => {
    const notes = [];
    let cur = root + 12 + steps[r.int(0, 2) * 2 % steps.length];
    for (let s = 0; s < len * 16; s += 2) {
      if (r.chance(style === 'ambient' ? 0.7 : 0.22)) { notes.push(null); continue; }
      const strong = s % 8 === 0;
      const ch = chordAt(Math.floor(s / 16));
      if (strong) {
        const tones = ch.notes.flatMap((n) => [n + 12, n + 24]).filter((n) => Math.abs(n - cur) <= 7);
        cur = tones.length ? r.pick(tones) : ch.notes[0] + 12;
      } else {
        const i = scaleNotes.indexOf(scaleNotes.reduce((a, b) => (Math.abs(b - cur) < Math.abs(a - cur) ? b : a)));
        cur = scaleNotes[Math.max(0, Math.min(scaleNotes.length - 1, i + r.pick([-2, -1, -1, 1, 1, 2])))];
      }
      notes.push({ s, midi: Math.max(root + 5, Math.min(root + 28, cur)), len: r.chance(0.3) ? 4 : 2 });
    }
    return notes;
  };
  const a = phrase(2), b = phrase(2);
  const variation = (p) => p.map((n) => (n && r.chance(0.25) ? { ...n, midi: n.midi + r.pick([-2, 2, 0]) } : n));
  const melody = [a, variation(a), b, variation(a)];

  for (let bi = 0; bi < bars; bi++) {
    const t0 = bi * bar;
    const ch = chordAt(bi);
    const mel = melody[Math.floor(bi / 2) % 4];
    if (style === 'ambient') {
      if (bi % barsPerChord === 0) for (const n of ch.notes) addNote(buf, sampleRate, t0, bar * barsPerChord - 0.2, midiHz(n), { wave: 'pad', lowpass: 0.06, env: { a: 1.2, d: 0.5, s: 0.8, r: 1.6 } }, 0.16);
      addNote(buf, sampleRate, t0, bar - 0.1, midiHz(ch.notes[0] - 24), { wave: 'sine', env: { a: 0.3, d: 0.2, s: 0.9, r: 0.6 } }, 0.3);
      for (const n of mel) if (n && Math.floor(n.s / 16) === bi % 2 && r.chance(0.6)) addNote(buf, sampleRate, t0 + (n.s % 16) * step16, n.len * step16, midiHz(n.midi + 12), { wave: 'bell', decay: 2.2 }, 0.16);
    } else {
      // Bass: root and fifth in eighths, an octave jump on the last.
      for (let e = 0; e < 8; e++) {
        const n = e === 7 ? ch.notes[0] - 12 : e % 4 === 2 ? ch.notes[2] - 24 : ch.notes[0] - 24;
        addNote(buf, sampleRate, t0 + e * beat / 2, beat / 2 * 0.85, midiHz(n), { wave: 'triangle', env: { a: 0.003, d: 0.05, s: 0.8, r: 0.03 } }, 0.42);
      }
      // Arpeggio: chord tones in sixteenths, an octave up, quiet.
      for (let s = 0; s < 16; s++) addNote(buf, sampleRate, t0 + s * step16, step16 * 0.7, midiHz(ch.notes[s % ch.notes.length] + 12), { wave: 'square', duty: 0.125, env: { a: 0.002, d: 0.04, s: 0.3, r: 0.02 } }, 0.07);
      for (const n of mel) if (n && Math.floor(n.s / 16) === bi % 2) addNote(buf, sampleRate, t0 + (n.s % 16) * step16, n.len * step16 * 0.9, midiHz(n.midi), { wave: 'square', duty: 0.25, vibrato: 0.006, env: { a: 0.004, d: 0.1, s: 0.55, r: 0.05 } }, 0.15);
      for (let s = 0; s < 16; s++) {
        if (s % 8 === 0 || (s === 10 && r.chance(0.5))) drum(buf, sampleRate, t0 + s * step16, 'kick', 0.7);
        if (s % 8 === 4) drum(buf, sampleRate, t0 + s * step16, 'snare', 0.6);
        if (s % 2 === 0) drum(buf, sampleRate, t0 + s * step16, 'hat', 0.5);
      }
    }
  }
  const out = style === 'ambient' ? echo(buf, sampleRate, beat * 0.75, 0.45, 0.6) : echo(buf, sampleRate, beat * 0.75, 0.2, 0.25);
  return { samples: dcBlock(out, sampleRate, { loop: true }), sampleRate, duration, bars, bpm: tempo, chords: chords.map((c) => c.name), style, key, scale: sc };
}
