// What each provider offers right now (its own list-models endpoint), and the tier a model is shown
// under in the model picker. A model the provider lists that the harness has no spec for (prices,
// context) is shown but not offered: a run on it could not be costed or limited.

import type { ModelSpec } from '../core/models.ts';

export interface LiveModel { id: string; name?: string; created?: number }

/** The picker's groups: the strongest first. */
export type ModelTier = 'frontier' | 'balanced' | 'fast';
export const TIER_LABEL: Record<ModelTier, string> = { frontier: 'Most capable', balanced: 'Balanced', fast: 'Fast & low cost' };

/** A model's tier: its own, else from its output price (what a long answer costs, the clearest signal of its class). */
export function tierOf(m: Pick<ModelSpec, 'tier' | 'rate'>): ModelTier {
  if (m.tier) return m.tier;
  const out = m.rate(0, new Date()).output;
  return out >= 12 ? 'frontier' : out >= 3 ? 'balanced' : 'fast';
}

const json = async (url: string, headers: Record<string, string>, signal: AbortSignal): Promise<unknown> => {
  const r = await fetch(url, { headers, signal });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
  return r.json();
};
const trimBase = (b: string) => b.replace(/\/+$/, '');

/** GET /v1/models on the Anthropic API, every page. */
export async function anthropicModels(key: string, baseUrl: string, signal: AbortSignal): Promise<LiveModel[]> {
  const out: LiveModel[] = [];
  let after: string | undefined;
  for (let page = 0; page < 10; page++) {
    const j = await json(`${trimBase(baseUrl)}/v1/models?limit=100${after ? `&after_id=${encodeURIComponent(after)}` : ''}`, { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, signal) as { data?: Array<{ id: string; display_name?: string; created_at?: string }>; has_more?: boolean; last_id?: string };
    for (const m of j.data ?? []) out.push({ id: m.id, ...(m.display_name ? { name: m.display_name } : {}), ...(m.created_at ? { created: Date.parse(m.created_at) } : {}) });
    if (!j.has_more || !j.last_id) break;
    after = j.last_id;
  }
  return out;
}

/** GET <base>/models on an OpenAI-compatible API (OpenAI, DeepSeek, Moonshot, Z.ai); `keep` drops what is not a chat model. */
export async function openAiCompatibleModels(key: string, baseUrl: string, signal: AbortSignal, keep: (id: string) => boolean = () => true): Promise<LiveModel[]> {
  const j = await json(`${trimBase(baseUrl)}/models`, { authorization: `Bearer ${key}` }, signal) as { data?: Array<{ id: string; created?: number; name?: string }> };
  return (j.data ?? []).filter((m) => typeof m.id === 'string' && keep(m.id)).map((m) => ({ id: m.id, ...(m.name ? { name: m.name } : {}), ...(m.created ? { created: m.created * 1000 } : {}) }));
}

/** OpenAI lists embeddings, speech, image and moderation models too: only the chat and reasoning families. */
export const openAiChatModel = (id: string) => /^(gpt-|o\d|chatgpt-)/.test(id) && !/(audio|realtime|tts|transcribe|search|image|embedding|moderation)/.test(id);
