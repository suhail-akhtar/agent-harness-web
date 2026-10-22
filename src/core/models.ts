import type { Usage } from './types.ts';
import { promptTokens } from './types.ts';

// The catalog is deliberately small: the models this harness is tuned and
// tested for. Prices are USD per million tokens, from each provider's
// published pricing page (checked 2026-10-19); override them with
// HARNESS_PRICING_JSON if they change.

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

interface Rate { input: number; cacheRead: number; cacheWrite: number; output: number }

export interface ModelSpec {
  id: string;
  label: string;
  /** Registered provider id: 'anthropic' | 'openai' | 'deepseek' | 'moonshot' | 'zai' | a plugin's. */
  provider: string;
  /** Accepts images (screenshots, renders) in its input. */
  vision: boolean;
  /** Shown in the UI when a capability is weak or untested. */
  notes?: string;
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
    id: 'claude-haiku-5-5',
    label: 'Claude Haiku 5.5',
    provider: 'anthropic',
    vision: true,
    contextWindow: 1_000_000,
    maxOutput: 64_000,
    compactAt: 92_000,
    effort: 'medium',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    rate: (size) => size <= 100_000
      ? { input: 0.10, cacheRead: 0.01, cacheWrite: 0.125, output: 0.50 }
      : { input: 0.50, cacheRead: 0.05, cacheWrite: 0.625, output: 2.50 },
  },
  {
    id: 'deepseek-flash',
    label: 'DeepSeek V4.1 Flash',
    provider: 'deepseek',
    vision: true,
    contextWindow: 1_048_576,
    maxOutput: 64_000,
    compactAt: 160_000,
    effort: 'high',
    efforts: ['low', 'high', 'max'],
    rate: (_size, at) => deepseekPeak(at)
      ? { input: 0.30, cacheRead: 0.006, cacheWrite: 0, output: 1.20 }
      : { input: 0.15, cacheRead: 0.003, cacheWrite: 0, output: 0.60 },
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
    maxOutput: 64_000,
    compactAt: 160_000,
    effort: 'medium',
    efforts: ['low', 'medium', 'high', 'xhigh'],
    rate: () => ({ input: 0.10, cacheRead: 0.01, cacheWrite: 0, output: 0.50 }),
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
    maxOutput: 64_000,
    // Cached input is $0.30/M: each step over a 120K prompt costs about 3.6 cents.
    compactAt: 120_000,
    effort: 'high',
    efforts: ['low', 'high', 'max'],
    // Cache writes are billed per TTL tier: $3 (5 minutes, the default) or $6 (1 hour, HARNESS_MOONSHOT_CACHE_TTL=1h).
    rate: () => ({ input: 3.00, cacheRead: 0.30, cacheWrite: process.env.HARNESS_MOONSHOT_CACHE_TTL === '1h' ? 6.00 : 3.00, output: 15.00 }),
  },
  {
    id: 'kimi-k2.7-code',
    label: 'Kimi K2.7 Code',
    provider: 'moonshot',
    vision: true,
    notes: 'Kimi\'s coding model. Always thinks, with no effort control.',
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
    notes: 'Effort low turns thinking off (faster, cheaper); high thinks.',
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
    maxOutput: 64_000,
    // Cached input is $0.03/M, so a long context is cheap; compacting at 200K keeps steps fast.
    compactAt: 200_000,
    effort: 'high',
    efforts: ['low', 'high', 'max'],
    // Implicit caching; cache storage is free for a limited time (no write charge).
    rate: () => ({ input: 0.15, cacheRead: 0.03, cacheWrite: 0.15, output: 0.50 }),
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
  return (u.input * r.input + u.cacheRead * r.cacheRead + u.cacheWrite * r.cacheWrite + u.output * r.output) / 1_000_000;
}

