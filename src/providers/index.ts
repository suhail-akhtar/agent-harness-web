import type { ProviderId } from '../core/types.ts';
import { MODELS, type ModelSpec } from '../core/models.ts';
import type { Provider } from './types.ts';
import { AnthropicProvider, anthropicKey } from './anthropic.ts';
import { OpenAIProvider } from './openai.ts';
import { DeepSeekProvider } from './deepseek.ts';

// Keys live in the server's environment only; the browser never sees them.

function keyFor(p: ProviderId): string | undefined {
  if (p === 'anthropic') return anthropicKey();
  if (p === 'openai') return process.env.OPENAI_API_KEY || undefined;
  return process.env.DEEPSEEK_API_KEY || undefined;
}

const cache = new Map<ProviderId, Provider>();

export function providerFor(model: ModelSpec): Provider {
  const hit = cache.get(model.provider);
  if (hit) return hit;
  const key = keyFor(model.provider);
  if (!key) throw new Error(`No API key for ${model.provider}. Set ${model.provider === 'anthropic' ? 'ANTHROPIC_API_KEY (or GW_ANTHROPIC_API_KEY)' : model.provider === 'openai' ? 'OPENAI_API_KEY' : 'DEEPSEEK_API_KEY'} on the server.`);
  const p: Provider = model.provider === 'anthropic' ? new AnthropicProvider(key)
    : model.provider === 'openai' ? new OpenAIProvider(key)
    : new DeepSeekProvider(key);
  cache.set(model.provider, p);
  return p;
}

/** Test seam: install a fake provider for a provider id. */
export function setProvider(id: ProviderId, p: Provider | undefined): void {
  if (p) cache.set(id, p); else cache.delete(id);
}

export function availableModels(): (ModelSpec & { available: boolean })[] {
  return MODELS.map((m) => ({ ...m, available: Boolean(keyFor(m.provider)) || cache.has(m.provider) }));
}
