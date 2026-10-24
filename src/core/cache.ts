import crypto from 'node:crypto';
import type { ToolSpec } from '../providers/types.ts';
import type { Message, Usage } from './types.ts';
import { promptTokens } from './types.ts';

// Why the provider's prompt cache missed. A cache hits when the request's prefix (tools, then
// the system prompt, then the conversation) is byte-identical to one sent before; when a
// request reads much less from the cache than the one before it wrote, something moved.
// Each request's sections are hashed (the tools, the system prompt, and the conversation at
// every message boundary, chained), so a miss names the first section that changed: the tools
// (a group loaded), the system prompt, a message (masked or compacted history), or nothing
// (the entry expired, or the provider dropped it). Hashing only: no model call, no tokens.

export type MissCause =
  /** The tool list changed (a deferred group loaded, a plugin's guide skills changed). */
  | 'tools'
  | 'system'
  /** Another model: another cache. */
  | 'model'
  /** Old tool output masked (non-Anthropic) or cleared on the server (Anthropic context editing). */
  | 'mask'
  /** The context was compacted (here or on the provider's side). */
  | 'compaction'
  /** Another edit of earlier messages (images dropped after a rejection). */
  | 'edit'
  /** Nothing changed and the gap since the last request outlived the cache's TTL. */
  | 'ttl'
  /** Nothing changed that we sent: the provider did not serve the cache (eviction, routing). */
  | 'provider';

export interface CacheShape {
  model: string;
  tools: string;
  system: string;
  /** Chained hash of the conversation through each message. */
  messages: string[];
  /** When the request started. */
  at: number;
  /** Its prompt size, once the response says. */
  prompt?: number;
}

const sha = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
/** One message's hash, kept per message object (masking and compaction make new objects, so a cached hash never goes stale). */
const messageHashes = new WeakMap<Message, string>();
function messageHash(m: Message): string {
  let h = messageHashes.get(m);
  if (!h) { h = sha(JSON.stringify([m.role, m.content, m.raw?.model ?? ''])); messageHashes.set(m, h); }
  return h;
}

/** The hashed sections of one request. */
export function cacheShape(req: { model: { id: string }; tools: readonly ToolSpec[]; system: string; messages: readonly Message[] }, at = Date.now()): CacheShape {
  const messages: string[] = [];
  let chain = '';
  for (const m of req.messages) { chain = sha(chain + messageHash(m)); messages.push(chain); }
  return { model: req.model.id, tools: sha(JSON.stringify(req.tools)), system: sha(req.system), messages, at };
}

/** The first section of `now` that differs from `before`: where the cached prefix ended. */
export function firstChange(before: CacheShape, now: CacheShape): { section: 'model' | 'tools' | 'system' | 'messages' | 'none'; index?: number } {
  if (before.model !== now.model) return { section: 'model' };
  if (before.tools !== now.tools) return { section: 'tools' };
  if (before.system !== now.system) return { section: 'system' };
  const n = Math.min(before.messages.length, now.messages.length);
  for (let i = 0; i < n; i++) if (before.messages[i] !== now.messages[i]) return { section: 'messages', index: i };
  // A shorter conversation than before is a replaced one.
  if (now.messages.length < before.messages.length) return { section: 'messages', index: now.messages.length };
  return { section: 'none' };
}

/** Smallest prompt worth expecting a cache read for (providers do not cache tiny prefixes). */
export const MIN_CACHED_PROMPT = 2048;
/** A read below this share of what the last request cached counts as a miss. */
export const MISS_SHARE = 0.5;

export interface CacheMiss {
  cause: MissCause;
  section: ReturnType<typeof firstChange>['section'];
  /** The first message that differed, for a messages change. */
  index?: number;
  /** What the last request cached (its prompt), and what this one read. */
  expected: number;
  read: number;
  gapMs: number;
}

/**
 * Whether `usage` (this request's) is a miss given the request before, and why. `hint` is what
 * the agent knows it did since (it masked, it compacted, the provider compacted or cleared).
 * `ttlMs`: how long the conversation's cache entry lives (5 minutes, the default ephemeral TTL).
 */
export function attributeMiss(before: CacheShape | undefined, now: CacheShape, usage: Usage, opts: { hint?: MissCause; ttlMs?: number } = {}): CacheMiss | undefined {
  if (!before?.prompt || before.prompt < MIN_CACHED_PROMPT) return undefined;
  // What could have been read: the last prompt, bounded by this one (a shorter prompt reads at most itself).
  const expected = Math.min(before.prompt, promptTokens(usage));
  if (expected < MIN_CACHED_PROMPT || usage.cacheRead >= expected * MISS_SHARE) return undefined;
  const change = firstChange(before, now);
  const gapMs = now.at - before.at;
  let cause: MissCause;
  if (change.section === 'model') cause = 'model';
  else if (change.section === 'tools') cause = 'tools';
  else if (change.section === 'system') cause = 'system';
  else if (change.section === 'messages') cause = opts.hint === 'compaction' || opts.hint === 'mask' ? opts.hint : 'edit';
  else if (opts.hint) cause = opts.hint;
  else cause = gapMs > (opts.ttlMs ?? 5 * 60_000) ? 'ttl' : 'provider';
  return { cause, section: change.section, ...(change.index !== undefined ? { index: change.index } : {}), expected, read: usage.cacheRead, gapMs };
}
