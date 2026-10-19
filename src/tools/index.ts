import type { ToolSpec } from '../providers/types.ts';
import { bashTool, todoTool } from './exec.ts';
import { editTool, globTool, grepTool, readTool, writeTool } from './files.ts';
import { agentTool, askUserTool, exitPlanTool } from './meta.ts';
import type { Tool } from './types.ts';
import { webFetchTool } from './web.ts';

export const ALL_TOOLS: Tool[] = [agentTool, askUserTool, bashTool, editTool, exitPlanTool, globTool, grepTool, readTool, todoTool, webFetchTool, writeTool];

/** Read-only set for "explore" sub-agents. */
export const EXPLORE_TOOLS = new Set(['glob', 'grep', 'read', 'web_fetch']);

export function toolByName(name: string): Tool | undefined {
  return ALL_TOOLS.find((t) => t.spec.name === name);
}

/** Deterministic: sorted by name, built the same way every time, so it caches. */
export function toolSpecs(filter?: (t: Tool) => boolean): ToolSpec[] {
  return ALL_TOOLS.filter((t) => !filter || filter(t))
    .map((t) => t.spec)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Minimal JSON-schema check: required keys and primitive types. Returns a repair hint or undefined. */
export function validateInput(spec: ToolSpec, input: Record<string, unknown>): string | undefined {
  const props = spec.input_schema.properties as Record<string, { type?: string; enum?: unknown[] }>;
  for (const key of spec.input_schema.required ?? []) {
    if (input[key] === undefined || input[key] === null) return `missing required parameter "${key}"`;
  }
  for (const [key, value] of Object.entries(input)) {
    const p = props[key];
    if (!p) continue;
    const t = p.type;
    const ok = t === undefined
      || (t === 'string' && typeof value === 'string')
      || (t === 'number' && (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value)))))
      || (t === 'boolean' && (typeof value === 'boolean' || value === 'true' || value === 'false'))
      || (t === 'array' && Array.isArray(value))
      || (t === 'object' && typeof value === 'object');
    if (!ok) return `parameter "${key}" must be a ${t}`;
    if (p.enum && !p.enum.includes(value)) return `parameter "${key}" must be one of ${p.enum.map((e) => JSON.stringify(e)).join(', ')}`;
  }
  return undefined;
}

export type { Tool };
