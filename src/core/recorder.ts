// The run recorder (docs/swarm/SWARM.md, phase 6): what a session did, kept so it can be checked later. Every event
// that matters (what the person asked, each tool call and its result, the agents' answers, the person's decisions)
// is stored as a content-addressed blob, and a line for it goes into a hash-chained log: each line's hash covers the
// one before it, so a changed, removed or reordered line breaks the chain from there on. A replay shows the record
// as it happened without running anything (a re-run is a different thing: it runs again, live). An export bundle
// carries the log and its blobs, and verifies on its own.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { HarnessEvent } from './types.ts';

/** What the recorder keeps: the events a later reader needs to know what was done and on whose word. */
export const RECORDED = new Set<HarnessEvent['kind']>(['user_message', 'assistant_message', 'tool_call', 'tool_result', 'permission_request', 'question', 'request_resolved', 'plan_proposed', 'approval_request', 'workflow', 'swarm', 'acceptance', 'notice'] as HarnessEvent['kind'][]);

export interface RecordLine { n: number; at: number; kind: string; agent?: string; name?: string; blob: string; prev: string; hash: string }
export interface Bundle { format: 'harness-record/1'; session: string; exportedAt: number; lines: RecordLine[]; blobs: Record<string, string> }

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
/** The hash of a line: everything in it but its own hash, in a fixed order. */
const lineHash = (l: Omit<RecordLine, 'hash'>) => sha(JSON.stringify([l.n, l.at, l.kind, l.agent ?? null, l.name ?? null, l.blob, l.prev]));
const GENESIS = '0'.repeat(64);

export class Recorder {
  private dir: string;
  private queue: Promise<unknown> = Promise.resolve();
  private last?: { n: number; hash: string };
  constructor(dir: string) { this.dir = dir; }

  private get log() { return path.join(this.dir, 'record.jsonl'); }
  private blobPath(h: string) { return path.join(this.dir, 'blobs', h.slice(0, 2), `${h}.json`); }

  /** Appends an event (already redacted), in order; writes are queued, so the chain never forks. */
  record(event: HarnessEvent, at = Date.now()): Promise<void> {
    if (!RECORDED.has(event.kind)) return Promise.resolve();
    const next = this.queue.catch(() => {}).then(async () => {
      if (!this.last) this.last = await this.tail();
      const body = JSON.stringify(event);
      const blob = sha(body);
      const file = this.blobPath(blob);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, body, { flag: 'wx' }).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e; });
      const e = event as { agent?: string; name?: string; tool?: string };
      const l = { n: this.last.n + 1, at, kind: event.kind, ...(e.agent ? { agent: e.agent } : {}), ...(e.name ?? e.tool ? { name: e.name ?? e.tool } : {}), blob, prev: this.last.hash };
      const line: RecordLine = { ...l, hash: lineHash(l) };
      await fs.appendFile(this.log, `${JSON.stringify(line)}\n`);
      this.last = { n: line.n, hash: line.hash };
    });
    this.queue = next;
    return next as Promise<void>;
  }

  /** Waits for every write so far. */
  async flush(): Promise<void> { await this.queue.catch(() => {}); }

  private async lines(): Promise<RecordLine[]> {
    const text = await fs.readFile(this.log, 'utf8').catch(() => '');
    return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as RecordLine);
  }
  private async tail(): Promise<{ n: number; hash: string }> {
    const ls = await this.lines();
    const t = ls.at(-1);
    return t ? { n: t.n, hash: t.hash } : { n: 0, hash: GENESIS };
  }

  /** The log and its blobs, as one bundle that verifies on its own. */
  async export(session: string): Promise<Bundle> {
    await this.flush();
    const lines = await this.lines();
    const blobs: Record<string, string> = {};
    for (const l of lines) if (!blobs[l.blob]) blobs[l.blob] = await fs.readFile(this.blobPath(l.blob), 'utf8').catch(() => '');
    return { format: 'harness-record/1', session, exportedAt: Date.now(), lines, blobs };
  }

  async verify(): Promise<VerifyResult> { return verifyBundle(await this.export('')); }
}

export interface VerifyResult { ok: boolean; lines: number; problems: string[]; head?: string }

/** Checks a bundle: every line's hash, the chain from the first line, every blob against its hash. */
export function verifyBundle(b: Bundle): VerifyResult {
  const problems: string[] = [];
  let prev = GENESIS;
  b.lines.forEach((l, i) => {
    if (l.n !== i + 1) problems.push(`line ${i + 1}: numbered ${l.n} (a line is missing or out of order)`);
    if (l.prev !== prev) problems.push(`line ${i + 1}: does not follow line ${i} (the chain is broken here)`);
    const { hash, ...rest } = l;
    if (lineHash(rest) !== hash) problems.push(`line ${i + 1}: its hash does not match its contents (changed)`);
    const body = b.blobs[l.blob];
    if (body === undefined || body === '') problems.push(`line ${i + 1}: its content (${l.blob.slice(0, 12)}) is missing`);
    else if (sha(body) !== l.blob) problems.push(`line ${i + 1}: its content does not match its hash (changed)`);
    prev = hash;
  });
  return { ok: !problems.length, lines: b.lines.length, problems, ...(b.lines.length ? { head: b.lines.at(-1)!.hash } : {}) };
}

/**
 * A replay of a bundle: the steps as they happened, from the record alone (nothing runs again). Each step says who
 * did it and what it was: the person's words, a call and its input, a result, an answer, a decision.
 */
export function replay(b: Bundle): { n: number; at: string; who: string; what: string }[] {
  return b.lines.map((l) => {
    let e: Record<string, unknown> = {};
    try { e = JSON.parse(b.blobs[l.blob] ?? '{}'); } catch { /* shown as missing */ }
    const who = l.agent ?? (l.kind === 'user_message' || l.kind === 'request_resolved' ? 'person' : 'main');
    const cut = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').slice(0, 200);
    const what = l.kind === 'user_message' ? `asked: ${cut(e.text)}`
      : l.kind === 'tool_call' ? `called ${e.name} ${cut(JSON.stringify(e.input))}`
      : l.kind === 'tool_result' ? `${e.name} ${e.is_error ? 'failed' : 'returned'}: ${cut(e.content)}`
      : l.kind === 'assistant_message' ? `answered: ${cut(((e.message as { content?: { type: string; text?: string }[] })?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join(' '))}`
      : l.kind === 'request_resolved' ? `decided: ${cut(e.answer ?? e.decision)}`
      : `${l.kind}${l.name ? ` ${l.name}` : ''}`;
    return { n: l.n, at: new Date(l.at).toISOString(), who, what };
  });
}

// ---------- the server's signature on an exported bundle ----------

/**
 * The server's record-signing key (Ed25519), made once in its data directory (owner-only). A bundle it exports is
 * signed over its session, its length and its head hash: the chain proves nothing was changed inside it, the
 * signature that this server produced it (GET /api/record-key gives the public key to check against).
 */
export async function recordKey(dataDir: string): Promise<{ privateKey: string; publicKey: string }> {
  const file = path.join(dataDir, 'record-signing-key.pem');
  let privateKey = await fs.readFile(file, 'utf8').catch(() => '');
  try { crypto.createPrivateKey(privateKey); } catch {
    privateKey = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(file, privateKey, { mode: 0o600, flag: 'wx' }).catch(async (e: NodeJS.ErrnoException) => { if (e.code === 'EEXIST') privateKey = await fs.readFile(file, 'utf8'); else throw e; });
  }
  return { privateKey, publicKey: crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString() };
}

const signedPart = (b: Bundle) => `harness-record/1\n${b.session}\n${b.lines.length}\n${b.lines.at(-1)?.hash ?? GENESIS}`;

/** The bundle with the server's signature (and its public key) on it. */
export function signBundle(b: Bundle, key: { privateKey: string; publicKey: string }): Bundle & { signature: { alg: 'ed25519'; publicKey: string; value: string } } {
  return { ...b, signature: { alg: 'ed25519', publicKey: key.publicKey, value: crypto.sign(null, Buffer.from(signedPart(b)), crypto.createPrivateKey(key.privateKey)).toString('base64') } };
}

/**
 * A signed bundle checked: its chain and contents (verifyBundle), and its signature, against `trusted` (the server's
 * public key, as GET /api/record-key gives it) when one is given, else against the key it carries.
 */
export function verifySignedBundle(b: Bundle & { signature?: { publicKey?: string; value?: string } }, trusted?: string): VerifyResult & { signed: boolean; signer?: string } {
  const v = verifyBundle(b);
  const s = b.signature;
  if (!s?.value || !s.publicKey) return { ...v, ok: false, signed: false, problems: [...v.problems, 'not signed'] };
  const key = trusted ?? s.publicKey;
  const norm = (k: string) => crypto.createPublicKey(k).export({ type: 'spki', format: 'pem' }).toString();
  let good = false;
  try { good = (!trusted || norm(trusted) === norm(s.publicKey)) && crypto.verify(null, Buffer.from(signedPart(b)), crypto.createPublicKey(key), Buffer.from(s.value, 'base64')); } catch { good = false; }
  return { ...v, ok: v.ok && good, signed: good, ...(good ? { signer: crypto.createHash('sha256').update(norm(key)).digest('hex').slice(0, 16) } : {}), problems: good ? v.problems : [...v.problems, trusted && norm(trusted) !== norm(s.publicKey) ? 'signed by another key than the one trusted' : 'its signature does not match it'] };
}
