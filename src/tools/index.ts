import type { ToolSpec } from '../providers/types.ts';
import { bashTool, todoTool } from './exec.ts';
import { editTool, globTool, grepTool, readTool, writeTool } from './files.ts';
import { askUserTool, exitPlanTool } from './meta.ts';
import type { Tool } from './types.ts';
import { memoryTool } from './memory.ts';
import { publishTool } from './publish.ts';
import { webFetchTool, webSearchTool } from './web.ts';

/** Built-in tools. The `agent`, `skill` and MCP tools are made per session from what is registered. */
export const BUILTIN_TOOLS: Tool[] = [askUserTool, bashTool, editTool, exitPlanTool, globTool, grepTool, memoryTool, publishTool, readTool, todoTool, webFetchTool, webSearchTool, writeTool];

export function toolByName(name: string): Tool | undefined {
  return BUILTIN_TOOLS.find((t) => t.spec.name === name);
}

/** Deterministic order (by name) so the tool list - which renders first in every request - caches. */
export function sortTools(tools: Tool[]): Tool[] {
  return [...tools].sort((a, b) => (a.spec.name < b.spec.name ? -1 : a.spec.name > b.spec.name ? 1 : 0));
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
