/**
 * The model first-run setup recommends as the default: Claude Sonnet 5.5 when an Anthropic key is
 * there (quality), else DeepSeek V4.1 Flash (cost), else the first model that has a key. Pure.
 */

export interface ModelLike { id: string; provider: string; available: boolean }

export const RECOMMENDED = { anthropic: 'claude-sonnet-5-5', fallback: 'deepseek-flash' } as const;

export function recommendedModel(models: ModelLike[]): { id: string; why: string } | undefined {
  const has = (id: string) => models.find((m) => m.id === id && m.available);
  if (has(RECOMMENDED.anthropic)) return { id: RECOMMENDED.anthropic, why: 'You have an Anthropic key: Claude Sonnet 5.5 is the best all-round default.' };
  if (has(RECOMMENDED.fallback)) return { id: RECOMMENDED.fallback, why: 'DeepSeek Flash is fast and inexpensive; add an Anthropic key for Claude Sonnet 5.5.' };
  const first = models.find((m) => m.available);
  return first ? { id: first.id, why: 'The first model with a key.' } : undefined;
}
