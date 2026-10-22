// The scripted engine's diagram turns (no model is called):
//   "draw the <view> diagram"   -> an `artifact create` of that view's fixture
//   "draw a diagram block"      -> a reply with a ```diagram block
//   "... add a cache in front of the database ... id <id> ..." (the canvas's ask box)
//                               -> `artifact get`, then `artifact rewrite` with a cache before the database
// and a one-line answer after each artifact call.
import type { Block, Message } from '../../../src/core/types.ts';
import { DIAGRAMS, json } from './diagrams.ts';

export interface ScriptedTurn { text?: string; call?: { name: string; input: Record<string, unknown> } }

const textOf = (b: Block[]) => b.filter((x) => x.type === 'text').map((x) => (x as { text: string }).text).join('\n');

/** The next step of a diagram conversation, or null when the message is not about diagrams. */
export function diagramTurn(messages: Message[]): ScriptedTurn | null {
  const last = messages[messages.length - 1];
  if (!last) return null;
  const results = last.role === 'user' ? last.content.filter((b) => b.type === 'tool_result') as Array<{ content: string; is_error?: boolean }> : [];
  if (results.length) {
    const prev = [...messages].reverse().find((m) => m.role === 'assistant');
    const call = prev?.content.find((b) => b.type === 'tool_use') as { name: string; input: Record<string, unknown> } | undefined;
    if (!call || call.name !== 'artifact') return null;
    const r = results[0]!;
    if (r.is_error) return { text: `The artifact tool said: ${r.content}` };
    if (call.input.action === 'get') {
      // The latest version (its JSON follows the first line): a cache in front of the database, the rest kept.
      const spec = JSON.parse(r.content.slice(r.content.indexOf('\n') + 1)) as { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };
      if (!spec.nodes.some((n) => n.id === 'cache')) {
        spec.nodes.push({ id: 'cache', kind: 'cache', title: 'Cache', tech: 'Redis 7', group: 'data', status: 'planned', address: '10.42.29.5:6379' });
        const toDb = spec.edges.find((e) => e.from === 'web' && e.to === 'db');
        if (toDb) { toDb.to = 'cache'; toDb.label = 'get / set'; }
        spec.edges.push({ id: 'e8', from: 'cache', to: 'db', label: 'on a miss' });
      }
      return { call: { name: 'artifact', input: { action: 'rewrite', id: call.input.id, content: JSON.stringify(spec, null, 2) } } };
    }
    const made = /(?:Created artifact|Rewrote|Updated) (\S+) v(\d+)/.exec(r.content);
    return { text: call.input.action === 'create' ? `Here is the diagram (artifact ${made?.[1] ?? ''}). Open it to explore, play its flows or drag boxes.` : `Done: added a Redis cache in front of the database (now v${made?.[2] ?? '?'}).` };
  }
  if (last.role !== 'user') return null;
  const said = textOf(last.content);
  const view = /draw the (context|container|component|deployment|data|code|flow) diagram/i.exec(said)?.[1]?.toLowerCase() as keyof typeof DIAGRAMS | undefined;
  if (view) {
    const d = DIAGRAMS[view];
    return { text: `I will draw the ${view} diagram.`, call: { name: 'artifact', input: { action: 'create', title: d.title, kind: 'diagram', content: json(d) } } };
  }
  if (/draw a diagram block/i.test(said)) return { text: `A quick one:\n\n\`\`\`diagram\n${json(DIAGRAMS.flow)}\n\`\`\`` };
  const ask = /add a cache in front of the database[\s\S]*\bid ([a-z0-9][a-z0-9-]{2,60})\b/i.exec(said);
  if (ask) return { text: 'Reading the diagram first.', call: { name: 'artifact', input: { action: 'get', id: ask[1] } } };
  return null;
}
