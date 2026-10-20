import type { ProviderDef } from '../plugins/api.ts';
import { AnthropicProvider } from './anthropic.ts';
import { DeepSeekProvider } from './deepseek.ts';
import { OpenAIProvider } from './openai.ts';

// The built-in providers. Keys are read from the server's environment only;
// the browser never sees them. Plugins register more the same way.

export const BUILTIN_PROVIDERS: Record<string, ProviderDef> = {
  anthropic: { keyEnv: ['ANTHROPIC_API_KEY', 'GW_ANTHROPIC_API_KEY'], create: (key) => new AnthropicProvider(key) },
  openai: { keyEnv: ['OPENAI_API_KEY'], create: (key) => new OpenAIProvider(key) },
  deepseek: { keyEnv: ['DEEPSEEK_API_KEY'], create: (key) => new DeepSeekProvider(key) },
};
