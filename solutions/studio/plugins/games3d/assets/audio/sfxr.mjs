// Sound effects with an sfxr-style synthesizer (after DrPetter's sfxr): a square, saw,
// sine or noise oscillator with an attack/sustain/punch/decay envelope, frequency slides,
// vibrato, arpeggio, duty sweep, repeat, a phaser and low/high-pass filters. Presets
// (pickup, laser, explosion, powerup, hit, jump, blip) pick parameters from a seed.

import { rng } from '../util/rng.mjs';
import { dcBlock } from './wav.mjs';

export const SFX_PRESETS = ['pickup', 'laser', 'explosion', 'powerup', 'hit', 'jump', 'blip'];

/** sfxr's defaults: every parameter in its 0..1 (or -1..1) range. */
export function defaults() {
  return {
    wave: 'square', baseFreq: 0.3, freqLimit: 0, freqRamp: 0, freqDramp: 0, duty: 0, dutyRamp: 0,
    vibStrength: 0, vibSpeed: 0, vibDelay: 0, envAttack: 0, envSustain: 0.3, envPunch: 0, envDecay: 0.4,
    lpfResonance: 0, lpfFreq: 1, lpfRamp: 0, hpfFreq: 0, hpfRamp: 0, phaOffset: 0, phaRamp: 0,
    repeatSpeed: 0, arpSpeed: 0, arpMod: 0, volume: 0.5,
  };
}

const WAVES = ['square', 'saw', 'sine', 'noise'];

/** A preset's parameters for a seed (the same seed, the same sound). */
export function preset(name, seed = 0) {
  const r = rng(`${seed}:${name}`);
  const frnd = (x) => r.next() * x, rnd = (n) => r.int(0, n);
  const p = defaults();
  switch (name) {
    case 'pickup':
      p.baseFreq = 0.4 + frnd(0.5); p.envAttack = 0; p.envSustain = frnd(0.1); p.envDecay = 0.1 + frnd(0.4); p.envPunch = 0.3 + frnd(0.3);
      if (rnd(1)) { p.arpSpeed = 0.5 + frnd(0.2); p.arpMod = 0.2 + frnd(0.4); }
      break;
    case 'laser':
      p.wave = WAVES[rnd(2)];
      if (p.wave === 'sine' && rnd(1)) p.wave = WAVES[rnd(1)];
      p.baseFreq = 0.5 + frnd(0.5); p.freqLimit = Math.max(0.2, p.baseFreq - 0.2 - frnd(0.6)); p.freqRamp = -0.15 - frnd(0.2);
      if (rnd(2) === 0) { p.baseFreq = 0.3 + frnd(0.6); p.freqLimit = frnd(0.1); p.freqRamp = -0.35 - frnd(0.3); }
      if (rnd(1)) { p.duty = frnd(0.5); p.dutyRamp = frnd(0.2); } else { p.duty = 0.4 + frnd(0.5); p.dutyRamp = -frnd(0.7); }
      p.envAttack = 0; p.envSustain = 0.1 + frnd(0.2); p.envDecay = frnd(0.4);
      if (rnd(1)) p.envPunch = frnd(0.3);
      if (rnd(2) === 0) { p.phaOffset = frnd(0.2); p.phaRamp = -frnd(0.2); }
      if (rnd(1)) p.hpfFreq = frnd(0.3);
      break;
    case 'explosion':
      p.wave = 'noise';
      if (rnd(1)) { p.baseFreq = 0.1 + frnd(0.4); p.freqRamp = -0.1 + frnd(0.4); } else { p.baseFreq = 0.2 + frnd(0.7); p.freqRamp = -0.2 - frnd(0.2); }
      p.baseFreq *= p.baseFreq;
      if (rnd(4) === 0) p.freqRamp = 0;
      if (rnd(2) === 0) p.repeatSpeed = 0.3 + frnd(0.5);
      p.envAttack = 0; p.envSustain = 0.1 + frnd(0.3); p.envDecay = 0.2 + frnd(0.5);
      if (rnd(1) === 0) { p.phaOffset = -0.3 + frnd(0.9); p.phaRamp = -frnd(0.3); }
      p.envPunch = 0.2 + frnd(0.6);
      if (rnd(1)) { p.vibStrength = frnd(0.7); p.vibSpeed = frnd(0.6); }
      if (rnd(2) === 0) { p.arpSpeed = 0.6 + frnd(0.3); p.arpMod = 0.8 - frnd(1.6); }
      break;
    case 'powerup':
      if (rnd(1)) p.wave = 'saw'; else p.duty = frnd(0.6);
      if (rnd(1)) { p.baseFreq = 0.2 + frnd(0.3); p.freqRamp = 0.1 + frnd(0.4); p.repeatSpeed = 0.4 + frnd(0.4); } else { p.baseFreq = 0.2 + frnd(0.3); p.freqRamp = 0.05 + frnd(0.2); if (rnd(1)) { p.vibStrength = frnd(0.7); p.vibSpeed = frnd(0.6); } }
      p.envAttack = 0; p.envSustain = frnd(0.4); p.envDecay = 0.1 + frnd(0.4);
      break;
    case 'hit':
      p.wave = WAVES[rnd(2)];
      if (p.wave === 'sine') p.wave = 'noise';
      if (p.wave === 'square') p.duty = frnd(0.6);
      p.baseFreq = 0.2 + frnd(0.6); p.freqRamp = -0.3 - frnd(0.4); p.envAttack = 0; p.envSustain = frnd(0.1); p.envDecay = 0.1 + frnd(0.2);
      if (rnd(1)) p.hpfFreq = frnd(0.3);
      break;
    case 'jump':
      p.wave = 'square'; p.duty = frnd(0.6); p.baseFreq = 0.3 + frnd(0.3); p.freqRamp = 0.1 + frnd(0.2); p.envAttack = 0; p.envSustain = 0.1 + frnd(0.3); p.envDecay = 0.1 + frnd(0.2);
      if (rnd(1)) p.hpfFreq = frnd(0.3);
      if (rnd(1)) p.lpfFreq = 1 - frnd(0.6);
      break;
    case 'blip':
      p.wave = WAVES[rnd(1)];
      if (p.wave === 'square') p.duty = frnd(0.6);
      p.baseFreq = 0.2 + frnd(0.4); p.envAttack = 0; p.envSustain = 0.1 + frnd(0.1); p.envDecay = frnd(0.2); p.hpfFreq = 0.1;
      break;
    default: throw new Error(`unknown sound preset ${name}: one of ${SFX_PRESETS.join(', ')}`);
  }
  return p;
}

/** Renders parameters to mono samples in [-1, 1] at 44.1 kHz (8x supersampled, as sfxr does). */
export function synth(params, { sampleRate = 44100, seed = 0, maxSeconds = 4 } = {}) {
  const p = { ...defaults(), ...params };
  const noiseR = rng(`${seed}:noise`);
  const wave = typeof p.wave === 'number' ? p.wave : Math.max(0, WAVES.indexOf(p.wave));
  let fperiod, fmaxperiod, fslide, fdslide, period, squareDuty, squareSlide, arpMod, arpTime, arpLimit;
  let envStage = 0, envTime = 0, envLength = [0, 0, 0], envVol = 0;
  let fphase, fdphase, iphase, ipp = 0, phase = 0;
  let fltp = 0, fltdp = 0, fltw, fltwd, fltdmp, fltphp = 0, flthp, flthpd;
  let vibPhase = 0, vibSpeed, vibAmp, repTime = 0, repLimit;
  const phaserBuffer = new Float32Array(1024), noiseBuffer = new Float32Array(32);
  const refillNoise = () => { for (let i = 0; i < 32; i++) noiseBuffer[i] = noiseR.next() * 2 - 1; };
  const reset = (restart) => {
    fperiod = 100 / (p.baseFreq * p.baseFreq + 0.001);
    period = Math.floor(fperiod);
    fmaxperiod = 100 / (p.freqLimit * p.freqLimit + 0.001);
    fslide = 1 - p.freqRamp ** 3 * 0.01;
    fdslide = -(p.freqDramp ** 3) * 0.000001;
    squareDuty = 0.5 - p.duty * 0.5;
    squareSlide = -p.dutyRamp * 0.00005;
    arpMod = p.arpMod >= 0 ? 1 - p.arpMod ** 2 * 0.9 : 1 + p.arpMod ** 2 * 10;
    arpTime = 0;
    arpLimit = p.arpSpeed === 1 ? 0 : Math.floor((1 - p.arpSpeed) ** 2 * 20000 + 32);
    if (restart) return;
    fltp = 0; fltdp = 0;
    fltw = p.lpfFreq ** 3 * 0.1; fltwd = 1 + p.lpfRamp * 0.0001;
    fltdmp = Math.min(0.8, (5 / (1 + p.lpfResonance ** 2 * 20)) * (0.01 + fltw));
    fltphp = 0; flthp = p.hpfFreq ** 2 * 0.1; flthpd = 1 + p.hpfRamp * 0.0003;
    vibPhase = 0; vibSpeed = p.vibSpeed ** 2 * 0.01; vibAmp = p.vibStrength * 0.5;
    envVol = 0; envStage = 0; envTime = 0;
    envLength = [p.envAttack ** 2 * 100000, p.envSustain ** 2 * 100000, p.envDecay ** 2 * 100000].map((v) => Math.max(1, Math.floor(v)));
    fphase = p.phaOffset ** 2 * 1020 * Math.sign(p.phaOffset || 1);
    fdphase = p.phaRamp ** 2 * Math.sign(p.phaRamp || 1);
    iphase = Math.abs(Math.floor(fphase));
    ipp = 0;
    phaserBuffer.fill(0);
    refillNoise();
    repTime = 0;
    repLimit = p.repeatSpeed === 0 ? 0 : Math.floor((1 - p.repeatSpeed) ** 2 * 20000 + 32);
  };
  reset(false);
  const out = [];
  const max = Math.floor(sampleRate * maxSeconds);
  // sfxr works at 44.1 kHz; other rates step through it at their own pace.
  const step = 44100 / sampleRate;
  let acc = 0;
  for (let i = 0; i < max * step; i++) {
    repTime++;
    if (repLimit !== 0 && repTime >= repLimit) { repTime = 0; reset(true); }
    arpTime++;
    if (arpLimit !== 0 && arpTime >= arpLimit) { arpLimit = 0; fperiod *= arpMod; }
    fslide += fdslide;
    fperiod *= fslide;
    if (fperiod > fmaxperiod) { fperiod = fmaxperiod; if (p.freqLimit > 0) break; }
    let rfperiod = fperiod;
    if (vibAmp > 0) { vibPhase += vibSpeed; rfperiod = fperiod * (1 + Math.sin(vibPhase) * vibAmp); }
    period = Math.max(8, Math.floor(rfperiod));
    squareDuty = Math.min(0.5, Math.max(0, squareDuty + squareSlide));
    envTime++;
    if (envTime > envLength[envStage]) { envTime = 0; envStage++; if (envStage === 3) break; }
    if (envStage === 0) envVol = envTime / envLength[0];
    else if (envStage === 1) envVol = 1 + (1 - envTime / envLength[1]) * 2 * p.envPunch;
    else envVol = 1 - envTime / envLength[2];
    fphase += fdphase;
    iphase = Math.min(1023, Math.abs(Math.floor(fphase)));
    if (flthpd !== 0) flthp = Math.min(0.1, Math.max(0.00001, flthp * flthpd));
    let ssample = 0;
    for (let si = 0; si < 8; si++) {
      phase++;
      if (phase >= period) { phase %= period; if (wave === 3) refillNoise(); }
      const fp = phase / period;
      let sample = wave === 0 ? (fp < squareDuty ? 0.5 : -0.5) : wave === 1 ? 1 - fp * 2 : wave === 2 ? Math.sin(fp * 2 * Math.PI) : noiseBuffer[Math.floor((phase * 32) / period) % 32];
      const pp = fltp;
      fltw = Math.min(0.1, Math.max(0, fltw * fltwd));
      if (p.lpfFreq !== 1) { fltdp += (sample - fltp) * fltw; fltdp -= fltdp * fltdmp; } else { fltp = sample; fltdp = 0; }
      fltp += fltdp;
      fltphp += fltp - pp;
      fltphp -= fltphp * flthp;
      sample = fltphp;
      phaserBuffer[ipp & 1023] = sample;
      sample += phaserBuffer[(ipp - iphase + 1024) & 1023];
      ipp = (ipp + 1) & 1023;
      ssample += sample * envVol;
    }
    acc += 1;
    if (acc >= step) { acc -= step; out.push(Math.max(-1, Math.min(1, (ssample / 8) * p.volume * 2))); }
  }
  // A 5 ms fade out, so a cut-off tail does not click.
  const s = dcBlock(Float32Array.from(out), sampleRate);
  const fade = Math.min(s.length, Math.round(sampleRate * 0.005));
  for (let i = 0; i < fade; i++) s[s.length - 1 - i] *= i / fade;
  return s;
}
