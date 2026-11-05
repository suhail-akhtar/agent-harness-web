// Your agent: the model, its tools and how much it may do without asking. Everything else (the loop, context
// management, recovery, cost tracking, permissions) comes from the harness. app.ts runs it; test/ checks it.
import { createHarness, defineTool, type Harness, type Session } from '@harness/core';

// Replace this with what your agent needs. `kind` is what the permission system judges a call by:
// read, edit, exec, network or external.
export const lookupOrder = defineTool({
  name: 'lookup_order',
  description: 'Finds an order by its number.',
  parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  kind: 'read',
  run: async (input) => JSON.stringify({ id: input.id, status: 'shipped' }),
});

export interface Agent { harness: Harness; session: Session; ask(text: string): Promise<string> }

export async function startAgent(o: { dataDir: string; workspace: string; model?: string; setup?: (h: Harness) => void }): Promise<Agent> {
  const harness = await createHarness({ dataDir: o.dataDir, memory: 'off' });
  harness.registry.addTool(lookupOrder);
  o.setup?.(harness);
  // dontAsk: nobody is watching, so what would need a person's yes is refused instead of waiting.
  const session = await harness.sessions.create({ model: o.model ?? 'claude-sonnet-5-5', mode: 'dontAsk', runtime: { kind: 'local', network: 'none', path: o.workspace } });
  const ask = async (text: string) => {
    const done = new Promise<void>((r) => session.subscribe(session.lastSeq, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) r(); }));
    await session.send(text);
    await done;
    const last = session.history.at(-1);
    return last?.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('') ?? '';
  };
  return { harness, session, ask };
}
