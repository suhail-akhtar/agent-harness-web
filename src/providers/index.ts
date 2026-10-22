import type { ProviderDef } from '../plugins/api.ts';
import { AnthropicProvider } from './anthropic.ts';
import { DeepSeekProvider } from './deepseek.ts';
import { OpenAIProvider } from './openai.ts';

// The built-in providers. Keys are read from the server's environment, else from a key an
// administrator set through the API (kept in the key vault; see Registry.keyInfo); the
// browser never sees them. Plugins register more the same way.

export const BUILTIN_PROVIDERS: Record<string, ProviderDef> = {
  anthropic: { label: 'Anthropic', defaultBaseUrl: 'https://api.anthropic.com', baseUrlEnv: 'HARNESS_ANTHROPIC_BASE_URL', keyEnv: ['ANTHROPIC_API_KEY', 'GW_ANTHROPIC_API_KEY'], create: (key, o) => new AnthropicProvider(key, o?.baseUrl) },
  openai: { label: 'OpenAI', defaultBaseUrl: 'https://api.openai.com/v1', baseUrlEnv: 'HARNESS_OPENAI_BASE_URL', keyEnv: ['OPENAI_API_KEY'], create: (key, o) => new OpenAIProvider(key, o?.baseUrl) },
  deepseek: { label: 'DeepSeek', defaultBaseUrl: 'https://api.deepseek.com', baseUrlEnv: 'HARNESS_DEEPSEEK_BASE_URL', keyEnv: ['DEEPSEEK_API_KEY'], create: (key, o) => new DeepSeekProvider(key, o?.baseUrl) },
};
