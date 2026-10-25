import type { ModelSpec } from './models.ts';
import type { Delegation } from './settings.ts';

// Delegation to other models: a sub-agent, a linked session or a workflow node on another
// model sends this session's data to that model's company, so it happens only for models
// the person allowed (account setting delegation.allowedModels, within the operator's cap).
// The allowed models are listed once in the agent and start_session descriptions (part of
// the cached prefix), so the model can pick well without a lookup.

/** Short notes on what each built-in model is good for (a plugin's model can say so in ModelSpec.strengths). */
const STRENGTHS: Record<string, string> = {
  'claude-opus-5-5': 'strongest: planning, hard reasoning, long agentic work',
  'claude-sonnet-5-5': 'strong reasoning, review, hard code',
  'claude-haiku-5-5': 'fast, cheap, solid tool use',
  'deepseek-flash': 'very cheap, good coding',
  'gpt-6-luna': 'cheap, broad knowledge',
  'kimi-k3.1-pro': 'long agentic coding, cheaper than K3',
  'kimi-k3': 'long agentic coding',
  'kimi-k2.7-code': 'coding',
  'kimi-k2.6': 'general, cheap at low effort',
  'glm-5.3-flash': 'cheap, long context',
};

/** $ to $$$$ by output price per million tokens (at a fixed date, so the line never changes with the hour). */
export function costTier(m: ModelSpec): string {
  const out = m.rate(100_000, new Date(Date.UTC(2026, 0, 3))).output;
  return out <= 1 ? '$' : out <= 5 ? '$$' : out <= 20 ? '$$$' : '$$$$';
}

const ctx = (n: number) => (n >= 1_000_000 ? `${Math.round(n / 1_000_000)}M` : `${Math.round(n / 1000)}K`);

/** The models an agent may delegate to besides the session's own, in a stable order. */
export function delegableModels(d: Delegation | undefined, own: ModelSpec, all: (ModelSpec & { available: boolean })[]): ModelSpec[] {
  const allowed = d?.allowedModels ?? [];
  return all.filter((m) => m.available && m.id !== own.id && (allowed === '*' || allowed.includes(m.id))).sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** One line per model for a tool description (empty when only the session's own model is allowed). */
export function modelCatalogue(models: ModelSpec[], own: ModelSpec): string {
  if (!models.length) return '';
  const one = (m: ModelSpec) => `${m.id} (${m.provider}, ${costTier(m)}, ${ctx(m.contextWindow)}${m.strengths ?? STRENGTHS[m.id] ? `: ${m.strengths ?? STRENGTHS[m.id]}` : ''})`;
  return `Other models (model param; default ${own.id}):\n${models.map((m) => `- ${one(m)}`).join('\n')}`;
}

/** Why `wanted` may not be delegated to, or undefined when it may. */
export function delegationRefusal(d: Delegation | undefined, own: string, wanted: string, known: (id: string) => (ModelSpec & { available: boolean }) | undefined): string | undefined {
  if (wanted === own) return undefined;
  const m = known(wanted);
  if (!m) return `There is no model "${wanted}".`;
  const allowed = d?.allowedModels ?? [];
  if (allowed !== '*' && !allowed.includes(wanted)) {
    return `Delegating to ${wanted} (${m.provider}) is not allowed: the person has not allowed it in the account setting delegation.allowedModels (now ${allowed.length ? allowed.join(', ') : 'only the session\'s own model'}; /api/me/settings, within the operator's cap). Use ${own}, or ask the person to allow ${wanted}.`;
  }
  if (!m.available) return `${wanted} has no API key on this server.`;
  return undefined;
}
