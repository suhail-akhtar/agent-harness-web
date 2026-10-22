import type { ProviderDef } from '../plugins/api.ts';
import { AnthropicProvider } from './anthropic.ts';
import { DeepSeekProvider } from './deepseek.ts';
import { MoonshotProvider } from './moonshot.ts';
import { OpenAIProvider } from './openai.ts';
import { ZaiProvider } from './zai.ts';

// The built-in providers. Keys are read from the server's environment, else from a key an
// administrator set through the API (kept in the key vault; see Registry.keyInfo); the
// browser never sees them. Plugins register more the same way.

export const BUILTIN_PROVIDERS: Record<string, ProviderDef> = {
  anthropic: { label: 'Anthropic', defaultBaseUrl: 'https://api.anthropic.com', baseUrlEnv: 'HARNESS_ANTHROPIC_BASE_URL', keyEnv: ['ANTHROPIC_API_KEY', 'GW_ANTHROPIC_API_KEY'], create: (key, o) => new AnthropicProvider(key, o?.baseUrl) },
  openai: { label: 'OpenAI', defaultBaseUrl: 'https://api.openai.com/v1', baseUrlEnv: 'HARNESS_OPENAI_BASE_URL', keyEnv: ['OPENAI_API_KEY'], create: (key, o) => new OpenAIProvider(key, o?.baseUrl) },
  deepseek: { label: 'DeepSeek', defaultBaseUrl: 'https://api.deepseek.com', baseUrlEnv: 'HARNESS_DEEPSEEK_BASE_URL', keyEnv: ['DEEPSEEK_API_KEY'], create: (key, o) => new DeepSeekProvider(key, o?.baseUrl) },
  // Base URLs: MOONSHOT_BASE_URL (China platform: https://api.moonshot.cn/v1), ZAI_BASE_URL (Coding Plan, BigModel).
  moonshot: { label: 'Moonshot AI (Kimi)', defaultBaseUrl: 'https://api.moonshot.ai/v1', baseUrlEnv: 'MOONSHOT_BASE_URL', keyEnv: ['MOONSHOT_API_KEY'], create: (key, o) => new MoonshotProvider(key, o?.baseUrl) },
  zai: { label: 'Z.ai (GLM)', defaultBaseUrl: 'https://api.z.ai/api/paas/v4', baseUrlEnv: 'ZAI_BASE_URL', keyEnv: ['ZAI_API_KEY'], create: (key, o) => new ZaiProvider(key, o?.baseUrl) },
};
