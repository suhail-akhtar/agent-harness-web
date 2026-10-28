// WAV files and their measures: 16-bit PCM encoding; decoding PCM 8/16/24/32-bit and
// float; peak, RMS, clipping, silence; integrated loudness (ITU-R BS.1770, LUFS) and
// normalization to a target loudness with a peak ceiling.

/** 16-bit PCM WAV from channels of samples in [-1, 1] (one Float32Array per channel). */
export function encodeWav(channels, sampleRate = 44100) {
  const ch = Array.isArray(channels) ? channels : [channels];
  const n = ch[0].length, nc = ch.length;
  const buf = Buffer.alloc(44 + n * nc * 2);
  buf.write('RIFF', 0, 'latin1'); buf.writeUInt32LE(36 + n * nc * 2, 4); buf.write('WAVE', 8, 'latin1');
  buf.write('fmt ', 12, 'latin1'); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(nc, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * nc * 2, 28); buf.writeUInt16LE(nc * 2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'latin1'); buf.writeUInt32LE(n * nc * 2, 40);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) { buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(ch[c][i] * 32767))), o); o += 2; }
  return buf;
}

/** Decodes a WAV: { sampleRate, channels: Float32Array[], bitsPerSample, format, duration }. Throws on anything else. */
export function decodeWav(buf) {
  buf = Buffer.from(buf);
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') throw new Error('not a WAV file (no RIFF/WAVE header)');
  let fmt = null, data = null;
  for (let o = 12; o + 8 <= buf.length;) {
    const id = buf.toString('latin1', o, o + 4), len = buf.readUInt32LE(o + 4);
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(o + 8), channels: buf.readUInt16LE(o + 10), sampleRate: buf.readUInt32LE(o + 12), bits: buf.readUInt16LE(o + 22) };
    if (id === 'data') data = buf.subarray(o + 8, Math.min(buf.length, o + 8 + len));
    o += 8 + len + (len & 1);
  }
  if (!fmt) throw new Error('WAV without a fmt chunk');
  if (!data) throw new Error('WAV without a data chunk');
  let { format } = fmt;
  if (format === 0xfffe) format = fmt.bits === 32 && data.length % 4 === 0 ? 1 : 1; // extensible: PCM in practice
  const bytes = fmt.bits / 8, nc = fmt.channels;
  if (![1, 3].includes(format) || ![8, 16, 24, 32].includes(fmt.bits) || !nc) throw new Error(`unsupported WAV encoding (format ${fmt.format}, ${fmt.bits} bits)`);
  const n = Math.floor(data.length / (bytes * nc));
  const channels = Array.from({ length: nc }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) {
    const o = (i * nc + c) * bytes;
    let v;
    if (format === 3) v = fmt.bits === 32 ? data.readFloatLE(o) : 0;
    else if (fmt.bits === 8) v = (data[o] - 128) / 128;
    else if (fmt.bits === 16) v = data.readInt16LE(o) / 32768;
    else if (fmt.bits === 24) v = data.readIntLE(o, 3) / 8388608;
    else v = data.readInt32LE(o) / 2147483648;
    channels[c][i] = v;
  }
  return { sampleRate: fmt.sampleRate, channels, bitsPerSample: fmt.bits, format: format === 3 ? 'float' : 'pcm', duration: n / fmt.sampleRate };
}

/** Removes DC offset (a one-pole high pass near 20 Hz); loop: runs twice so the end flows into the start. */
export function dcBlock(samples, sampleRate = 44100, { loop = false } = {}) {
  const R = 1 - (2 * Math.PI * 20) / sampleRate;
  const out = new Float32Array(samples.length);
  let x1 = 0, y1 = 0;
  for (let pass = 0; pass < (loop ? 2 : 1); pass++) {
    for (let i = 0; i < samples.length; i++) { const y = samples[i] - x1 + R * y1; x1 = samples[i]; y1 = y; out[i] = y; }
  }
  return out;
}

const db = (v) =>(v > 0 ? 20 * Math.log10(v) : -Infinity);

/** Biquad coefficients (RBJ cookbook) for the K-weighting filters at any sample rate. */
function kFilters(fs) {
  // Stage 1: a high shelf (+4 dB above about 1.5 kHz); stage 2: a high pass at about 38 Hz.
  const shelf = (() => {
    const f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
    const K = Math.tan((Math.PI * f0) / fs), Vh = 10 ** (G / 20), Vb = Vh ** 0.4996667741545416;
    const a0 = 1 + K / Q + K * K;
    return { b: [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0], a: [(2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0] };
  })();
  const hp = (() => {
    const f0 = 38.13547087602444, Q = 0.5003270373238773, K = Math.tan((Math.PI * f0) / fs);
    const a0 = 1 + K / Q + K * K;
    return { b: [1, -2, 1], a: [(2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0] };
  })();
  return [shelf, hp];
}

function filter(x, { b, a }) {
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

/** Integrated loudness in LUFS (BS.1770-4: K-weighting, 400 ms blocks, absolute and relative gates). */
export function loudness(channels, sampleRate) {
  const ch = Array.isArray(channels) ? channels : [channels];
  const [f1, f2] = kFilters(sampleRate);
  const weighted = ch.map((c) => filter(filter(c, f1), f2));
  const block = Math.round(0.4 * sampleRate), hop = Math.round(0.1 * sampleRate);
  const n = ch[0].length;
  const z = [];
  if (n < block) {
    let s = 0;
    for (const w of weighted) for (let i = 0; i < n; i++) s += w[i] * w[i];
    z.push(s / Math.max(1, n));
  } else {
    for (let st = 0; st + block <= n; st += hop) {
      let s = 0;
      for (const w of weighted) for (let i = st; i < st + block; i++) s += w[i] * w[i];
      z.push(s / block);
    }
  }
  const L = (p) => -0.691 + 10 * Math.log10(p);
  const abs = z.filter((p) => L(p) > -70);
  if (!abs.length) return -Infinity;
  const relGate = L(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const rel = abs.filter((p) => L(p) > relGate);
  return L(rel.reduce((a, b) => a + b, 0) / (rel.length || 1));
}

/** Peak and RMS (dBFS), clipped samples, DC offset, length, and integrated loudness. */
export function analyze(channels, sampleRate) {
  const ch = Array.isArray(channels) ? channels : [channels];
  let peak = 0, sum = 0, clipped = 0, dc = 0, count = 0;
  for (const c of ch) for (let i = 0; i < c.length; i++) {
    const v = c[i], a = Math.abs(v);
    if (a > peak) peak = a;
    if (a >= 0.9995) clipped++;
    sum += v * v; dc += v; count++;
  }
  const rms = Math.sqrt(sum / (count || 1));
  return { duration: ch[0].length / sampleRate, sampleRate, channels: ch.length, peakDb: Math.round(db(peak) * 10) / 10, rmsDb: Math.round(db(rms) * 10) / 10, lufs: Math.round(loudness(ch, sampleRate) * 10) / 10, clipped, clippedRatio: clipped / (count || 1), dcOffset: dc / (count || 1) };
}

/**
 * Scales to a target integrated loudness (default -16 LUFS: games and streaming), never past
 * a sample-peak ceiling (default -1 dBFS); mode 'peak' scales the peak to the ceiling instead.
 */
export function normalize(channels, sampleRate, { target = -16, ceiling = -1, mode = 'loudness' } = {}) {
  const ch = Array.isArray(channels) ? channels : [channels];
  const a = analyze(ch, sampleRate);
  const peak = 10 ** (a.peakDb / 20);
  if (!peak) return { channels: ch, gainDb: 0, before: a, after: a, limited: false };
  let gainDb = mode === 'peak' || !Number.isFinite(a.lufs) ? ceiling - a.peakDb : target - a.lufs;
  let limited = false;
  if (a.peakDb + gainDb > ceiling) { gainDb = ceiling - a.peakDb; limited = true; }
  const g = 10 ** (gainDb / 20);
  const out = ch.map((c) => c.map((v) => v * g));
  return { channels: out, gainDb: Math.round(gainDb * 10) / 10, before: a, after: analyze(out, sampleRate), limited };
}
