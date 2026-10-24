// studio_audio: sound effects from the sfxr-style synth, music loops from a chord
// progression, loudness normalization, and measurements of any WAV.

import { readIn, relIn, writeIn } from '../lib-engines.mjs';
import { guarded, int, num, save, seedIn, unknownAction } from './common.mjs';
import { music, SCALES } from './audio/music.mjs';
import { defaults, preset, SFX_PRESETS, synth } from './audio/sfxr.mjs';
import { analyze, decodeWav, encodeWav, normalize } from './audio/wav.mjs';
import { Image } from './raster/image.mjs';
import { preview } from './common.mjs';

/** A waveform picture (peak envelope per column), so the agent can see the sound's shape. */
export function waveform(samples, { width = 480, height = 96 } = {}) {
  const img = new Image(width, height, '#1e1e2a');
  const per = Math.max(1, Math.floor(samples.length / width));
  img.rect(0, height / 2, width, 1, '#3a3a50');
  for (let x = 0; x < width; x++) {
    let lo = 0, hi = 0;
    for (let i = x * per; i < Math.min(samples.length, (x + 1) * per); i++) { if (samples[i] < lo) lo = samples[i]; if (samples[i] > hi) hi = samples[i]; }
    img.rect(x, Math.round(height / 2 - hi * (height / 2 - 2)), 1, Math.max(1, Math.round((hi - lo) * (height / 2 - 2))), Math.max(-lo, hi) > 0.99 ? '#e84a4a' : '#6ac8f0');
  }
  return img;
}

const fmt = (s) => `${s.duration.toFixed(2)} s, peak ${s.peakDb} dBFS, RMS ${s.rmsDb} dBFS, ${s.lufs} LUFS${s.clipped ? `, ${s.clipped} clipped samples` : ''}`;
const ACTIONS = ['sfx', 'music', 'normalize', 'info'];

export const audioTool = {
  name: 'studio_audio',
  description: 'Game audio as 16-bit WAV, deterministic by seed. action: "sfx" a sound effect from the sfxr-style synth: preset pickup|laser|explosion|powerup|hit|jump|blip (a seed varies it), or params (wave square|saw|sine|noise, baseFreq, freqRamp, envAttack, envSustain, envDecay, envPunch, duty, vibStrength, arpMod, lpfFreq, hpfFreq, repeatSpeed...: sfxr\'s 0-1 ranges) over the preset; variants N makes N of them; "music" a seamless loop: style chiptune|ambient, progression ("I V vi IV", "i VI III VII" or "Am F C G"), key, scale, bpm, barsPerChord, repeats; "normalize" a WAV to a loudness target (default -16 LUFS, peak ceiling -1 dBFS; mode peak); "info" measures a WAV (length, peak, RMS, LUFS, clipping). Sounds are normalized (sfx -14 LUFS, music -16) and saved as assets; you see the waveform.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ACTIONS },
      preset: { type: 'string', enum: SFX_PRESETS }, params: { type: 'object' }, variants: { type: 'number' },
      seed: { type: ['number', 'string'] },
      style: { type: 'string', enum: ['chiptune', 'ambient'] }, progression: { type: 'string' }, key: { type: 'string' }, scale: { type: 'string', enum: Object.keys(SCALES) },
      bpm: { type: 'number' }, barsPerChord: { type: 'number' }, repeats: { type: 'number' },
      target: { type: 'number', description: 'LUFS target' }, ceiling: { type: 'number', description: 'peak ceiling dBFS' }, mode: { type: 'string', enum: ['loudness', 'peak'] },
      input: { type: 'string', description: 'normalize/info: a WAV in the workspace' }, output: { type: 'string', description: 'normalize: where to write (default over the input)' },
      sampleRate: { type: 'number' },
      id: { type: 'string' }, name: { type: 'string', description: 'What the asset is called on the Assets page (default from the id)' }, project: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, export: { type: 'string' },
    },
    required: ['action'],
  },
  kind: 'edit',
  sendsOut: false,
  summarize: (i) => `${i.action} ${i.preset ?? i.style ?? i.input ?? ''} ${i.seed ?? ''}`.trim(),
  run: guarded('studio_audio', async (input, ctx) => {
    const a = String(input.action ?? '');
    const seed = seedIn(input);
    const sr = int(input.sampleRate, 44100, 8000, 96000);
    if (a === 'sfx') {
      const name = input.preset ?? 'pickup';
      const n = int(input.variants, 1, 1, 16);
      const files = [], lines = [], waves = [];
      for (let v = 0; v < n; v++) {
        const s = v ? `${seed}.${v}` : seed;
        const params = { ...(input.preset || !input.params ? preset(name, s) : defaults()), ...(input.params ?? {}) };
        const raw = synth(params, { sampleRate: sr, seed: s });
        if (!raw.length) throw new Error('the parameters make no sound (the envelope is empty or the frequency limit stops it at once)');
        const norm = normalize([raw], sr, { target: num(input.target, -14, -40, 0), ceiling: num(input.ceiling, -1, -12, 0) });
        const file = n > 1 ? `${name}_${v + 1}.wav` : `${name}.wav`;
        files.push({ path: file, role: v ? 'variant' : 'main', data: encodeWav(norm.channels, sr) });
        lines.push(`${file}: ${fmt(norm.after)}`);
        waves.push(norm.channels[0]);
        if (!v) files.push({ path: 'params.json', role: 'data', data: JSON.stringify(params, null, 1) });
      }
      const r = await save(ctx, input, { id: input.id ?? `sfx-${name}-${seed}`, name: `${name} sound`, kind: 'audio', dimension: '2d', files, meta: { durationS: Math.round((waves[0].length / sr) * 1000) / 1000, sampleRate: sr, variants: n, lufs: num(input.target, -14) }, source: { type: 'procedural', generator: `studio:sfxr:${name}`, seed, params: input.params ?? {} }, tags: ['sfx', name] });
      return { content: `${r.lines.join('\n')}\n${lines.join('\n')}`, images: [preview(waveform(waves[0]))] };
    }
    if (a === 'music') {
      const m = music({ style: input.style ?? 'chiptune', progression: input.progression, key: input.key ?? 'C', scale: input.scale, bpm: input.bpm, barsPerChord: int(input.barsPerChord, 1, 1, 8), repeats: int(input.repeats, 2, 1, 8), seed, sampleRate: sr });
      const norm = normalize([m.samples], sr, { target: num(input.target, -16, -40, 0), ceiling: num(input.ceiling, -1, -12, 0) });
      const r = await save(ctx, input, { id: input.id ?? `music-${m.style}-${seed}`, name: `${m.style} loop`, kind: 'music', dimension: '2d', files: [{ path: 'loop.wav', role: 'main', data: encodeWav(norm.channels, sr) }], meta: { durationS: Math.round(m.duration * 1000) / 1000, bpm: m.bpm, bars: m.bars, chords: m.chords, key: m.key, scale: m.scale, loop: true, sampleRate: sr }, source: { type: 'procedural', generator: `studio:music:${m.style}`, seed, params: { progression: input.progression, key: input.key, bpm: input.bpm } }, tags: ['music', m.style, 'loop'] });
      return { content: `${r.lines.join('\n')}\n${m.bars} bars at ${m.bpm} bpm in ${m.key} ${m.scale} (${m.chords.join(' ')}), seamless loop: ${fmt(norm.after)}`, images: [preview(waveform(norm.channels[0]))] };
    }
    if (a === 'normalize' || a === 'info') {
      if (!input.input) throw new Error(`${a} needs input: a WAV in the workspace`);
      const rel = await relIn(ctx.host, String(input.input));
      const w = decodeWav(await readIn(ctx.host, rel, ctx.signal));
      if (a === 'info') return { content: `${rel}: ${w.channels.length} channel(s), ${w.sampleRate} Hz, ${w.bitsPerSample}-bit ${w.format}: ${fmt(analyze(w.channels, w.sampleRate))}`, images: [preview(waveform(w.channels[0]))] };
      const n = normalize(w.channels, w.sampleRate, { target: num(input.target, -16, -40, 0), ceiling: num(input.ceiling, -1, -12, 0), mode: input.mode ?? 'loudness' });
      const out = input.output ? await relIn(ctx.host, String(input.output)) : rel;
      await writeIn(ctx.host, out, encodeWav(n.channels, w.sampleRate), ctx.signal);
      return `${out}: gain ${n.gainDb} dB${n.limited ? ' (held back by the peak ceiling)' : ''}. Before: ${fmt(n.before)}. After: ${fmt(n.after)}.`;
    }
    return unknownAction('studio_audio', a, ACTIONS);
  }),
};
