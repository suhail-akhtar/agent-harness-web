// xAI (Grok) over its Responses API (https://docs.x.ai: Chat Completions is its legacy surface, and drops the
// encrypted reasoning a tool loop needs to stay cached). The same code as OpenAI's (src/providers/openai.ts)
// with xAI's flavor: efforts low / medium / high / xhigh (no max), no strict field on tools, the sampling xAI
// recommends, reasoning tokens billed as output when reported apart, and prompt_cache_key always set (xAI
// "highly recommends" it: a request without it often lands on a cold server). Its model list comes with prices.
// Checked against the docs and its OpenAPI spec (2026-10-26); not yet against the live API.

import type { Effort } from '../core/models.ts';
import { ResponsesProvider, type ResponsesFlavor } from './openai.ts';
import type { LiveModel } from './catalog.ts';

export const XAI_BASE = 'https://api.x.ai/v1';

export const XAI_FLAVOR: ResponsesFlavor = {
  provider: 'xai',
  summaries: false,
  // Not documented for xAI's Responses API yet: off until checked.
  midTools: false,
  serverCompaction: false,
  sampling: { temperature: 0.7, top_p: 0.95 },
  reasoningApart: true,
  effort: (e: Effort) => (e === 'max' ? 'xhigh' : e),
};

export class XaiProvider extends ResponsesProvider {
  constructor(apiKey: string, baseUrl = process.env.XAI_BASE_URL || XAI_BASE) {
    super(apiKey, baseUrl, XAI_FLAVOR);
  }
}

/** GET /v1/language-models: the models with their modalities and prices. */
export async function xaiModels(key: string, baseUrl: string, signal: AbortSignal): Promise<LiveModel[]> {
  const r = await fetch(`${baseUrl.replace(/\/+$/, '')}/language-models`, { headers: { authorization: `Bearer ${key}` }, signal });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
  const j = await r.json() as { models?: Array<{ id: string; aliases?: string[]; created?: number }> };
  return (j.models ?? []).map((m) => ({ id: m.id, ...(m.created ? { created: m.created * 1000 } : {}) }));
}
