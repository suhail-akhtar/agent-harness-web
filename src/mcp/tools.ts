import crypto from 'node:crypto';
import type { JsonSchema } from '../providers/types.ts';
import { validateInput } from '../tools/index.ts';
import type { Tool, ToolOutcome } from '../tools/types.ts';
import { str } from '../tools/types.ts';
import type { McpCallResult, McpClient, McpTool } from './client.ts';

// How MCP tools reach the model. A few servers' worth of tools are declared
// natively. Past MCP_INLINE_MAX, every schema in every request is a real cost,
// so the session declares two small tools instead: tool_search (returns the
// schemas that match, appended to the conversation, so the cache keeps
// hitting) and tool_call (runs one). The tool list itself never changes.

export interface McpEntry {
  server: string;
  tool: McpTool;
  client: Pick<McpClient, 'callTool'>;
  /** Name the model uses: mcp__server__tool. */
  qualified: string;
}

const MAX_RESULT = 40_000;
export const MCP_INLINE_MAX = Number(process.env.HARNESS_MCP_INLINE_MAX ?? 10);

export function qualifiedName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
  const q = `mcp__${clean(server)}__${clean(tool)}`;
  if (q.length <= 64) return q;
  return `${q.slice(0, 55)}_${crypto.createHash('sha1').update(q).digest('hex').slice(0, 8)}`;
}

export function schemaOf(t: McpTool): JsonSchema {
  const s = t.inputSchema ?? {};
  return { type: 'object', properties: (s.properties ?? {}) as Record<string, unknown>, ...(s.required?.length ? { required: s.required } : {}) };
}

export function convertResult(r: McpCallResult): ToolOutcome {
  const texts: string[] = [];
  const images: { media_type: string; data: string }[] = [];
  for (const c of r.content ?? []) {
    if (c.type === 'text' && c.text) texts.push(c.text);
    else if (c.type === 'image' && c.data && c.mimeType) images.push({ media_type: c.mimeType, data: c.data });
    else if (c.type === 'resource' && c.resource?.text) texts.push(c.resource.text);
    else if (c.type === 'resource_link' || c.type === 'resource') texts.push(`[resource ${c.resource?.uri ?? ''}]`);
  }
  if (!texts.length && r.structuredContent !== undefined) texts.push(JSON.stringify(r.structuredContent, null, 1));
  let content = texts.join('\n') || (images.length ? '(image result)' : '(empty result)');
  if (content.length > MAX_RESULT) content = content.slice(0, MAX_RESULT) + `\n[... ${content.length - MAX_RESULT} more characters cut]`;
  return { content, is_error: !!r.isError, ...(images.length ? { images } : {}) };
}

export function mcpTool(e: McpEntry): Tool {
  const readOnly = e.tool.annotations?.readOnlyHint === true;
  return {
    kind: readOnly ? 'read' : 'external',
    // Read-only or not, what a service returns is not the user's.
    untrusted: true,
    parallelSafe: readOnly,
    remoteable: false,
    spec: { name: e.qualified, description: (e.tool.description ?? e.tool.annotations?.title ?? e.tool.name).slice(0, 1000), input_schema: schemaOf(e.tool) },
    summarize: (i) => `${e.server}.${e.tool.name} ${JSON.stringify(i).slice(0, 100)}`,
    async run(input, ctx) {
      return convertResult(await e.client.callTool(e.tool.name, input, ctx.signal));
    },
  };
}

function score(e: McpEntry, words: string[]): number {
  const hay = `${e.qualified} ${e.server} ${e.tool.name} ${e.tool.description ?? ''}`.toLowerCase();
  let s = 0;
  for (const w of words) {
    if (e.tool.name.toLowerCase() === w) s += 10;
    if (e.tool.name.toLowerCase().includes(w)) s += 4;
    if (hay.includes(w)) s += 1;
  }
  return s;
}

export function deferredTools(entries: McpEntry[]): { search: Tool; call: Tool; byName: Map<string, McpEntry> } {
  const byName = new Map(entries.map((e) => [e.qualified, e]));
  const servers = [...new Set(entries.map((e) => e.server))];
  const search: Tool = {
    kind: 'read', parallelSafe: true, remoteable: false,
    spec: {
      name: 'tool_search',
      description: `Find external tools (from connected services: ${servers.join(', ')}) and get their exact parameters. Search by keywords, or "select:name1,name2" for exact names. Then run one with tool_call.`,
      input_schema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number', description: 'Default 5.' } }, required: ['query'] },
    },
    summarize: (i) => `search tools "${str(i.query)}"`,
    async run(input) {
      const q = str(input.query).trim();
      let hits: McpEntry[];
      if (q.startsWith('select:')) hits = q.slice(7).split(',').map((n) => byName.get(n.trim())).filter((x): x is McpEntry => !!x);
      else {
        const words = q.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length > 1);
        hits = entries.map((e) => ({ e, s: score(e, words) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, Math.min(20, Number(input.limit) || 5)).map((x) => x.e);
      }
      if (!hits.length) return { content: `No tools match "${q}". Servers: ${servers.join(', ')}. Try broader keywords.` };
      return { content: hits.map((e) => `<tool name="${e.qualified}"${e.tool.annotations?.readOnlyHint ? ' read_only="true"' : ''}>\n${(e.tool.description ?? '').slice(0, 1200)}\nparameters: ${JSON.stringify(schemaOf(e.tool))}\n</tool>`).join('\n') };
    },
  };
  const call: Tool = {
    kind: 'external', parallelSafe: false, remoteable: false,
    spec: {
      name: 'tool_call',
      description: 'Run an external tool found with tool_search: its exact name and an arguments object matching its parameters.',
      input_schema: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object' } }, required: ['name'] },
    },
    summarize: (i) => `${str(i.name)} ${JSON.stringify(i.arguments ?? {}).slice(0, 100)}`,
    resolve(input) {
      const e = byName.get(str(input.name));
      if (!e) return { error: `Unknown tool "${str(input.name)}". Find it with tool_search first.` };
      const args = (input.arguments && typeof input.arguments === 'object' ? input.arguments : {}) as Record<string, unknown>;
      const t = mcpTool(e);
      const invalid = validateInput(t.spec, args);
      if (invalid) return { error: `Invalid arguments for ${e.qualified}: ${invalid}. Parameters: ${JSON.stringify(t.spec.input_schema)}` };
      return { tool: t, input: args };
    },
    async run() {
      return { content: 'tool_call must be resolved by the harness', is_error: true };
    },
  };
  return { search, call, byName };
}
