// Sound: WAV sound effects and a music loop through WebAudio, from Studio audio assets
// (studio_audio: sfx-*/<preset>.wav, music-*/loop.wav) or paths. Never throws: a sound that does
// not load or a browser without audio is silent. M mutes (the game wires the key).
//
//   const sfx = new Sound();
//   await sfx.load({ jump: 'asset:sfx-jump-1', coin: 'asset:sfx-pickup-1' }, { music: 'asset:music-chiptune-1' });
//   sfx.play('jump'); sfx.startMusic();

import { resolve } from './assets.js';

export class Sound {
  constructor() {
    this.buffers = new Map();
    this.muted = false;
    this.volume = 0.6;
    this.played = [];
    try { this.ctx = new (window.AudioContext ?? window.webkitAudioContext)(); } catch { this.ctx = null; }
    if (this.ctx) {
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    }
  }

  async loadOne(name, ref) {
    if (!this.ctx || !ref) return;
    try {
      const r = await resolve(ref);
      const url = r?.main ?? r?.file((f) => /\.wav$/i.test(f.path));
      if (!url) return;
      const data = await (await fetch(url)).arrayBuffer();
      this.buffers.set(name, await this.ctx.decodeAudioData(data));
    } catch (e) { console.warn(`studio sound ${name}: ${e?.message ?? e}`); }
  }

  /** sounds: { name: ref }; music: { music: ref } (looped by startMusic). */
  async load(sounds = {}, music = {}) {
    await Promise.all([...Object.entries(sounds), ...Object.entries(music)].map(([n, ref]) => this.loadOne(n, ref)));
  }

  play(name, { volume = 1, rate = 1 } = {}) {
    this.played.push(name);
    if (this.played.length > 50) this.played.shift();
    if (!this.ctx || this.muted || !this.buffers.has(name)) return;
    try {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      const src = this.ctx.createBufferSource();
      src.buffer = this.buffers.get(name);
      src.playbackRate.value = rate;
      const g = this.ctx.createGain();
      g.gain.value = volume;
      src.connect(g).connect(this.master);
      src.start();
    } catch { /* no audio here */ }
  }

  startMusic(name = 'music', volume = 0.35) {
    if (!this.ctx || !this.buffers.has(name) || this.musicSrc) return;
    try {
      const src = this.ctx.createBufferSource();
      src.buffer = this.buffers.get(name);
      src.loop = true;
      const g = this.ctx.createGain();
      g.gain.value = volume;
      src.connect(g).connect(this.master);
      src.start();
      this.musicSrc = src;
    } catch { /* no audio here */ }
  }

  stopMusic() { try { this.musicSrc?.stop(); } catch { /* stopped */ } this.musicSrc = null; }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
    return this.muted;
  }
}
