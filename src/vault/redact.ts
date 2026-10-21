// One function between a session's secrets and everything that leaves the
// session's memory: every value the vault revealed (or the model stored) in a
// session is registered here, and tool results, events, trace spans, hook
// payloads, the saved history and export bundles pass through redact() first.
// It replaces the value itself and the forms a command or a tool is likely to
// print it in - base64 (at any alignment inside a longer base64 text, so
// `user:pass` in a Basic header is caught too), URL-encoding, JSON escaping and
// the single lines of a PEM key or any multi-line value - with `[vault:name]`.

/** Shorter values would redact ordinary words; the vault refuses to store them. */
export const MIN_SECRET_LENGTH = 6;
/** A fragment (a base64 core, a line) must be at least this long to be worth replacing. */
const MIN_FRAGMENT = 8;

/** The texts a value can appear as in output. */
export function secretForms(value: string): string[] {
  const out = new Set<string>();
  const add = (s: string, min = MIN_FRAGMENT) => { if (s.length >= min) out.add(s); };
  add(value, MIN_SECRET_LENGTH);
  add(value.trim(), MIN_SECRET_LENGTH);
  const bytes = Buffer.from(value, 'utf8');
  const b64 = bytes.toString('base64');
  add(b64);
  add(b64.replace(/=+$/, ''));
  add(bytes.toString('base64url'));
  // Inside a longer base64 text the value starts at one of three byte offsets; the
  // groups that hold only its own bytes encode the same way at each.
  for (let k = 0; k < 3; k++) {
    const enc = Buffer.concat([Buffer.alloc(k), bytes]).toString('base64');
    const core = enc.slice(k ? 4 : 0, Math.floor((k + bytes.length) / 3) * 4);
    add(core);
    add(core.replace(/\+/g, '-').replace(/\//g, '_'));
  }
  const uri = encodeURIComponent(value);
  if (uri !== value) { add(uri, MIN_SECRET_LENGTH); add(uri.replace(/%20/g, '+'), MIN_SECRET_LENGTH); }
  const json = JSON.stringify(value).slice(1, -1);
  if (json !== value) add(json, MIN_SECRET_LENGTH);
  // A PEM key (or any multi-line value) printed with other line endings, or one line at a time.
  if (/\r?\n/.test(value.trim())) {
    for (const line of value.split(/\r?\n/)) {
      const l = line.trim();
      if (/^-----(BEGIN|END) /.test(l)) continue;
      add(l);
    }
  }
  return [...out];
}

export class Redactor {
  private forms = new Map<string, string>();
  private ordered: [string, string][] = [];
  private names = new Set<string>();
  /** `onAdd`: told each newly registered name (a session keeps the names, to hide the values again after a restart). */
  private onAdd?: (name: string) => void;
  constructor(onAdd?: (name: string) => void) { this.onAdd = onAdd; }

  /** How many fragments are watched for (0: redact() is a no-op). */
  get size(): number { return this.ordered.length; }
  /** The vault names registered. */
  get registered(): string[] { return [...this.names]; }

  add(name: string, value: string): void {
    if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH) return;
    if (!this.names.has(name)) { this.names.add(name); this.onAdd?.(name); }
    const label = `[vault:${name}]`;
    let changed = false;
    for (const f of secretForms(value)) if (!this.forms.has(f)) { this.forms.set(f, label); changed = true; }
    // Longest first: a value's base64 is replaced before a shorter fragment inside it.
    if (changed) this.ordered = [...this.forms].sort((a, b) => b[0].length - a[0].length);
  }

  redact(text: string): string {
    if (!this.ordered.length || typeof text !== 'string' || !text) return text;
    let out = text;
    for (const [f, label] of this.ordered) if (out.includes(f)) out = out.split(f).join(label);
    return out;
  }

  /**
   * A copy of a JSON-like value with every string redacted; the same object when
   * nothing changed. Images are skipped (base64 pixels), and so are provider blocks
   * that carry a signature or encrypted content: changing one breaks the provider's
   * check, and they are the model's own opaque reasoning.
   */
  redactDeep<T>(v: T): T {
    if (!this.ordered.length) return v;
    return this.walk(v) as T;
  }

  private walk(v: unknown): unknown {
    if (typeof v === 'string') return this.redact(v);
    if (Array.isArray(v)) {
      let changed = false;
      const out = v.map((x) => { const y = this.walk(x); if (y !== x) changed = true; return y; });
      return changed ? out : v;
    }
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if ('signature' in o || 'encrypted_content' in o || o.type === 'image') return v;
      let changed = false;
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(o)) {
        const y = k === 'images' ? x : this.walk(x);
        if (y !== x) changed = true;
        out[k] = y;
      }
      return changed ? out : v;
    }
    return v;
  }

  /** Bytes (a workspace file in an export): each form replaced byte for byte, binary files included. */
  redactBytes(buf: Buffer): Buffer {
    if (!this.ordered.length) return buf;
    const hit = this.ordered.some(([f]) => buf.includes(Buffer.from(f, 'utf8')));
    if (!hit) return buf;
    // latin1 maps each byte to one character, so the replacement keeps every other byte as it was.
    let s = buf.toString('latin1');
    for (const [f, label] of this.ordered) {
      const lf = Buffer.from(f, 'utf8').toString('latin1');
      if (s.includes(lf)) s = s.split(lf).join(label);
    }
    return Buffer.from(s, 'latin1');
  }
}
