/**
 * A conversation as Markdown or plain text: its title, when and with which model, then each turn (the
 * person's words, the agent's replies, the tools it ran with a line each, their errors). Images and
 * documents are named, never inlined; reasoning is left out. Pure, for export.ts and tests.
 */

import { visibleUserText, type Block, type Message, type SessionMeta } from '@harness/client';

export type ExportKind = 'md' | 'txt';

const oneLine = (v: unknown, max = 160) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** What a tool call was about, in a few words (its main argument). */
function toolLine(b: Extract<Block, { type: 'tool_use' }>): string {
  const i = b.input ?? {};
  const main = ['command', 'path', 'file', 'url', 'query', 'pattern', 'action', 'prompt', 'name'].map((k) => i[k]).find((v) => typeof v === 'string' && v);
  return `${b.name}${main ? ` ${oneLine(main, 120)}` : ''}`;
}

export function conversationAsText(meta: Pick<SessionMeta, 'title' | 'model'> & { createdAt?: number | string }, messages: Message[], kind: ExportKind): string {
  const md = kind === 'md';
  const lines: string[] = [];
  const title = meta.title || 'Conversation';
  const when = meta.createdAt ? new Date(meta.createdAt).toLocaleString() : '';
  lines.push(md ? `# ${title}` : title, '', md ? `*${[when, meta.model].filter(Boolean).join(' · ')}*` : [when, meta.model].filter(Boolean).join(' · '), '');
  const errors = new Map<string, string>();
  for (const m of messages) for (const b of m.content) if (b.type === 'tool_result' && b.is_error) errors.set(b.tool_use_id, oneLine(b.content, 200));
  for (const m of messages) {
    const texts: string[] = [];
    const tools: string[] = [];
    for (const b of m.content) {
      // The person's words only: the context the harness adds (environment, memory, skills, reminders) is left out, as in the transcript.
      const text = b.type === 'text' ? (m.role === 'user' ? visibleUserText(b.text) : b.text.trim()) : '';
      if (text) texts.push(text);
      else if (b.type === 'tool_use') tools.push(`${toolLine(b)}${errors.has(b.id) ? ` (failed: ${errors.get(b.id)})` : ''}`);
      else if (b.type === 'image') texts.push(md ? '*[an image]*' : '[an image]');
      else if (b.type === 'document') texts.push(md ? `*[a document${b.name ? `: ${b.name}` : ''}]*` : `[a document${b.name ? `: ${b.name}` : ''}]`);
    }
    // A user message that only carries tool results is not a turn of the person's.
    if (!texts.length && !tools.length) continue;
    const who = m.role === 'user' ? 'You' : 'Assistant';
    lines.push(md ? `## ${who}` : `${who}:`, '');
    if (texts.length) lines.push(texts.join('\n\n'), '');
    if (tools.length) lines.push(...tools.map((t) => (md ? `- \`${t.replace(/`/g, "'")}\`` : `  - ${t}`)), '');
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}
