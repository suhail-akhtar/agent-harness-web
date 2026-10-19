import type { ProviderId, Usage } from './types.ts';
import { promptTokens } from './types.ts';

// The catalog is deliberately small: the three models this harness is tuned
// and tested for. Prices are USD per million tokens, from each provider's
// published pricing page (checked 2026-10-19); override them with
// HARNESS_PRICING_JSON if they change.

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

interface Rate { input: number; cacheRead: number; cacheWrite: number; output: number }

export interface ModelSpec {
  id: string;
  label: string;
  provider: ProviderId;
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

export const MODELS: ModelSpec[] = [
  {
    id: 'claude-haiku-5-5',
    label: 'Claude Haiku 5.5',
    provider: 'anthropic',
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
    // The published rate card covers prompts up to 272K; the harness keeps
    // the context below that so every request stays on it.
    contextWindow: 272_000,
    maxOutput: 64_000,
    compactAt: 160_000,
    effort: 'medium',
    efforts: ['low', 'medium', 'high', 'xhigh'],
    rate: () => ({ input: 0.10, cacheRead: 0.01, cacheWrite: 0, output: 0.50 }),
  },
];

const overrides = (() => {
  try { return JSON.parse(process.env.HARNESS_PRICING_JSON ?? '{}') as Record<string, Rate>; } catch { return {}; }
})();

export function getModel(id: string): ModelSpec {
  const m = MODELS.find((x) => x.id === id);
  if (!m) throw new Error(`Unknown model "${id}". Available: ${MODELS.map((x) => x.id).join(', ')}`);
  return m;
}

export function costOf(model: ModelSpec, u: Usage, at = new Date()): number {
  const r = overrides[model.id] ?? model.rate(promptTokens(u), at);
  return (u.input * r.input + u.cacheRead * r.cacheRead + u.cacheWrite * r.cacheWrite + u.output * r.output) / 1_000_000;
}

/** The model a sub-agent runs on: the same provider's catalog model, so one key covers the session. */
export function subagentModelFor(main: ModelSpec, preferred?: string): ModelSpec {
  if (preferred) return getModel(preferred);
  return main;
}
