import type { Usage } from './types.ts';
import { promptTokens } from './types.ts';

// The catalog is deliberately small: the models this harness is tuned and
// tested for. Prices are USD per million tokens, from each provider's
// published pricing page (checked 2026-10-19); override them with
// HARNESS_PRICING_JSON if they change.

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** cacheWrite1h: a cache write with the 1-hour TTL (Anthropic: 2x input); absent, twice the input rate. */
interface Rate { input: number; cacheRead: number; cacheWrite: number; cacheWrite1h?: number; output: number }

export interface ModelSpec {
  id: string;
  label: string;
  /** Registered provider id: 'anthropic' | 'openai' | 'deepseek' | 'moonshot' | 'zai' | a plugin's. */
  provider: string;
  /** Accepts images (screenshots, renders) in its input. */
  vision: boolean;
  /** Shown in the UI when a capability is weak or untested. */
  notes?: string;
  /** A few words on what it is good for, in the catalogue agents pick delegates from. */
  strengths?: string;
  /** false: every tool goes in from the first request (a provider that cannot take tools later in a conversation, where a load would rewrite the cached prefix). */
  deferTools?: boolean;
  /** The model picker's group (src/providers/catalog.ts); without it, from the output price. */
  tier?: 'frontier' | 'balanced' | 'fast';
  contextWindow: number;
  /** max_tokens sent per request (a cap, not a reservation). */
  maxOutput: number;
  /**
   * Compact the context once a request's prompt passes this many tokens.
   * Chosen per model for cost as much as for fit: Haiku 5.5 bills a prompt
   * over 100K at 5x the rate, so its context is compacted before it gets there.
   */
  compactAt: number;
  effort: Effort;
  efforts: Effort[];
  /** Returns the rate card for one request. */
  rate(promptSize: number, at: Date): Rate;
}

/** DeepSeek charges half outside 01:00-04:00 and 06:00-10:00 UTC on weekdays. */
export function deepseekPeak(at: Date): boolean {
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return false;
  const h = at.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

export const BUILTIN_MODELS: ModelSpec[] = [
  {
    id: 'claude-fable-5-1',
    label: 'Claude Fable 5.1',
    provider: 'anthropic',
    vision: true,
    notes: "Anthropic's most capable model, for the most demanding reasoning and long agentic work. Needs an organisation with 30-day data retention (zero data retention is refused).",
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    // At $10 per million input tokens, compact early.
    compactAt: 160_000,
    effort: 'high',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    rate: () => ({ input: 10.00, cacheRead: 0.25, cacheWrite: 12.50, cacheWrite1h: 20.00, output: 50.00 }),
  },
  {
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    provider: 'anthropic',
    vision: true,
    notes: 'The most capable Claude for long agentic coding and knowledge work. Thinking is always on: effort is the control.',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    // At $4 per million input tokens a long prompt is the cost: compact well before the window.
    compactAt: 180_000,
    effort: 'medium',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    // Cache writes: 1.25x input with the default 5-minute TTL, 2x with the 1-hour TTL; reads $0.20.
    rate: () => ({ input: 4.00, cacheRead: 0.20, cacheWrite: 5.00, cacheWrite1h: 8.00, output: 20.00 }),
  },
  {
    id: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    provider: 'anthropic',
    vision: true,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    // At $2 per million input tokens a long prompt is the cost: compact well before the window.
    compactAt: 160_000,
    effort: 'medium',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    // Cache writes: 1.25x input with the default 5-minute TTL, 2x with the 1-hour TTL (promptCaching.prefixTtl).
    rate: () => ({ input: 2.00, cacheRead: 0.20, cacheWrite: 2.50, cacheWrite1h: 4.00, output: 10.00 }),
  },
  {
    id: 'claude-haiku-5-5',
    label: 'Claude Haiku 5.5',
    provider: 'anthropic',
    vision: true,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    compactAt: 92_000,
    effort: 'medium',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    rate: (size) => size <= 100_000
      ? { input: 0.10, cacheRead: 0.01, cacheWrite: 0.125, cacheWrite1h: 0.20, output: 0.50 }
      : { input: 0.50, cacheRead: 0.05, cacheWrite: 0.625, cacheWrite1h: 1.00, output: 2.50 },
  },
  {
    id: 'deepseek-flash',
    label: 'DeepSeek V4.1 Flash',
    provider: 'deepseek',
    vision: true,
    contextWindow: 1_048_576,
    // Up to 393K; DeepSeek's own harness asks for 256K (its default at max effort is 128K, so 64K cut answers off).
    maxOutput: 256_000,
    // A cache hit is $0.003-0.006 per million: a long context costs little, a compaction's fresh prefix much more
    // (DeepSeek's Claude Code guide compacts at 786K). Later than other models, short of the window.
    compactAt: 400_000,
    effort: 'high',
    efforts: ['low', 'high', 'max'],
    // A tool group loaded mid-session would rewrite the tool list at the top of every request (Chat Completions
    // takes no tools later in the history), and every cached token after it: send every tool from the start.
    deferTools: false,
    rate: (_size, at) => deepseekPeak(at)
      ? { input: 0.30, cacheRead: 0.006, cacheWrite: 0, output: 1.20 }
      : { input: 0.15, cacheRead: 0.003, cacheWrite: 0, output: 0.60 },
  },
  {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    provider: 'deepseek',
    vision: false,
    notes: 'Text only (no images). Stronger than Flash at about four times its price.',
    contextWindow: 1_048_576,
    maxOutput: 256_000,
    compactAt: 400_000,
    effort: 'high',
    efforts: ['low', 'high', 'max'],
    deferTools: false,
    // https://api-docs.deepseek.com/quick_start/pricing (checked 2026-10-26).
    rate: (_size, at) => deepseekPeak(at)
      ? { input: 1.32, cacheRead: 0.044, cacheWrite: 0, output: 3.96 }
      : { input: 0.66, cacheRead: 0.022, cacheWrite: 0, output: 1.98 },
  },
  {
    id: 'gpt-6-luna',
    label: 'GPT-6 Luna',
    provider: 'openai',
    vision: true,
    notes: 'Vision was inconsistent in our checks (one simple colour test right, one wrong); confirm visual results another way.',
    // The published rate card covers prompts up to 272K; the harness keeps
    // the context below that so every request stays on it.
    contextWindow: 272_000,
    maxOutput: 128_000,
    compactAt: 160_000,
    effort: 'medium',
    efforts: ['low', 'medium', 'high', 'xhigh'],
    // Cache writes: $0.125 (30 minutes), $0.25 (12 hours), https://developers.openai.com/api/docs/guides/prompt-caching (checked 2026-10-26).
    rate: () => ({ input: 0.10, cacheRead: 0.01, cacheWrite: 0.125, cacheWrite1h: 0.25, output: 0.50 }),
  },
  // Moonshot AI (Kimi Open Platform), pay as you go. Prices from
  // https://platform.kimi.ai/docs/pricing/chat and, for K3's cache tiers,
  // https://platform.kimi.ai/docs/guide/context-caching (checked 2026-10-22).
  // Context windows and parameters: https://platform.kimi.ai/docs/api/models-overview.
  {
    id: 'kimi-k3',
    label: 'Kimi K3',
    provider: 'moonshot',
    vision: true,
    notes: 'Always thinks; effort is K3\'s reasoning_effort (low / high / max). Needs a first top-up of at least $1; a new account (Tier0) is limited to 3 requests a minute.',
    // 1,048,576 tokens, one flat rate at every prompt size.
    contextWindow: 1_048_576,
    maxOutput: 131_072,
    // Cached input is $0.30/M: each step over a 120K prompt costs about 3.6 cents.
    compactAt: 120_000,
    effort: 'high',
    efforts: ['low', 'high', 'max'],
    // Cache writes are billed per TTL tier: $3 (5 minutes) or $6 (1 hour; the provider reports those as cacheWrite1h).
    rate: () => ({ input: 3.00, cacheRead: 0.30, cacheWrite: 3.00, cacheWrite1h: 6.00, output: 15.00 }),
  },
  {
    id: 'kimi-k3.1-pro',
    label: 'Kimi K3.1 Pro',
    provider: 'moonshot',
    // Moonshot's flagship: priced below its class.
    tier: 'frontier',
    vision: true,
    notes: 'K3 post-trained further, cheaper per token. Always thinks; effort is reasoning_effort (low / high / max).',
    contextWindow: 1_048_576,
    // The API's own default for max_completion_tokens.
    maxOutput: 131_072,
    compactAt: 120_000,
    effort: 'high',
    efforts: ['low', 'high', 'max'],
    // Same tiers as K3 (checked 2026-10-25): cache writes $2 (5 minutes) or $4 (1 hour).
    rate: () => ({ input: 2.00, cacheRead: 0.20, cacheWrite: 2.00, cacheWrite1h: 4.00, output: 10.00 }),
  },
  {
    id: 'kimi-k3.1-pro-highspeed',
    label: 'Kimi K3.1 Pro Highspeed',
    provider: 'moonshot',
    vision: true,
    tier: 'frontier',
    notes: 'Kimi K3.1 Pro, 2-3x faster, at twice its input and output price (cache hits cost the same). Always thinks; effort is reasoning_effort.',
    contextWindow: 1_048_576,
    maxOutput: 131_072,
    compactAt: 120_000,
    effort: 'high',
    efforts: ['low', 'high', 'max'],
    rate: () => ({ input: 4.00, cacheRead: 0.20, cacheWrite: 4.00, cacheWrite1h: 8.00, output: 20.00 }),
  },
  {
    id: 'kimi-k2.7-code',
    label: 'Kimi K2.7 Code',
    provider: 'moonshot',
    vision: true,
    notes: 'Retires: new accounts lose the K2 models on 2026-10-31, all accounts by the end of December 2026. Kimi\'s coding model. Always thinks, with no effort control.',
    contextWindow: 262_144,
    maxOutput: 64_000,
    compactAt: 128_000,
    effort: 'high',
    efforts: ['high'],
    // K2 models have no separate cache-write charge; a write is billed as input.
    rate: () => ({ input: 0.95, cacheRead: 0.19, cacheWrite: 0.95, output: 4.00 }),
  },
  {
    id: 'kimi-k2.6',
    label: 'Kimi K2.6',
    provider: 'moonshot',
    vision: true,
    notes: 'Retires: new accounts lose the K2 models on 2026-10-31, all accounts by the end of December 2026. Effort low turns thinking off (faster, cheaper); high thinks.',
    contextWindow: 262_144,
    maxOutput: 64_000,
    compactAt: 128_000,
    effort: 'high',
    efforts: ['low', 'high'],
    rate: () => ({ input: 0.95, cacheRead: 0.16, cacheWrite: 0.95, output: 4.00 }),
  },
  // Z.ai, pay as you go. Prices from https://docs.z.ai/guides/overview/pricing,
  // limits from https://docs.z.ai/guides/vlm/glm-5.3-flash (checked 2026-10-22).
  {
    id: 'glm-5.3-flash',
    label: 'GLM-5.3-Flash',
    provider: 'zai',
    vision: true,
    notes: 'Always thinks; effort is reasoning_effort (low / high / max).',
    contextWindow: 1_000_000,
    // The API's maximum (its default is 64K): a max-effort turn that writes a large file is not cut off.
    maxOutput: 131_072,
    // Cached input is $0.03/M, so a long context is cheap; compacting at 200K keeps steps fast.
    compactAt: 200_000,
    effort: 'high',
    efforts: ['low', 'high', 'max'],
    // Implicit caching; cache storage is free for a limited time (no write charge).
    rate: () => ({ input: 0.15, cacheRead: 0.03, cacheWrite: 0.15, output: 0.50 }),
  },
  {
    id: 'glm-5.3-flashx',
    label: 'GLM-5.3-FlashX',
    provider: 'zai',
    vision: true,
    notes: 'GLM-5.3-Flash at about 200 tokens a second. Always thinks; effort is reasoning_effort (low / high / max).',
    contextWindow: 1_000_000,
    maxOutput: 131_072,
    compactAt: 200_000,
    effort: 'high',
    efforts: ['low', 'high', 'max'],
    // https://docs.z.ai/guides/overview/pricing (checked 2026-10-26).
    rate: () => ({ input: 0.37, cacheRead: 0.075, cacheWrite: 0.37, output: 1.25 }),
  },
  {
    id: 'glm-5.3',
    label: 'GLM-5.3',
    provider: 'zai',
    vision: false,
    notes: 'The stronger GLM coder; text only. Always thinks; effort is reasoning_effort (low / high / max).',
    contextWindow: 1_000_000,
    maxOutput: 131_072,
    compactAt: 200_000,
    effort: 'high',
    efforts: ['low', 'high', 'max'],
    rate: () => ({ input: 1.40, cacheRead: 0.26, cacheWrite: 1.40, output: 4.40 }),
  },
];

const overrides = (() => {
  try { return JSON.parse(process.env.HARNESS_PRICING_JSON ?? '{}') as Record<string, Rate>; } catch { return {}; }
})();

/** Looks up a BUILT-IN model. Sessions resolve models through the registry, which also holds plugins'. */
export function getModel(id: string): ModelSpec {
  const m = BUILTIN_MODELS.find((x) => x.id === id);
  if (!m) throw new Error(`Unknown model "${id}". Available: ${BUILTIN_MODELS.map((x) => x.id).join(', ')}`);
  return m;
}

export function costOf(model: ModelSpec, u: Usage, at = new Date()): number {
  const r = overrides[model.id] ?? model.rate(promptTokens(u), at);
  // The 1-hour share of the writes is billed at its own rate; the rest at the 5-minute one.
  const w1h = Math.min(u.cacheWrite, u.cacheWrite1h ?? 0);
  return (u.input * r.input + u.cacheRead * r.cacheRead + (u.cacheWrite - w1h) * r.cacheWrite + w1h * (r.cacheWrite1h ?? r.input * 2) + u.output * r.output) / 1_000_000;
}

