/**
 * A conversation as Markdown or plain text: its title, when and with which model, then each turn (the
 * person's words, the agent's replies, the tools it ran with a line each, their errors). Images and
 * documents are named, never inlined; reasoning is left out. For Export as Markdown / as text and Copy
 * as Markdown (the conversation's header and its row in the sidebar).
 */

import type { Block, Message, SessionMeta } from '@harness/client';
import { toast } from '@harness/ui';
import { desktop } from '../../bridge';
import { client } from '../../state/data';

export type ExportKind = 'md' | 'txt';

/** Every message of the conversation (paged from the server). */
async function allMessages(id: string): Promise<Message[]> {
  const out: Message[] = [];
  for (let after = 0, guard = 0; guard < 500; guard++) {
    const page = await client.sessions.history(id, { after, limit: 500 });
    out.push(...page.messages);
    if (page.next === null || page.next === undefined || !page.messages.length) break;
    after = page.next;
  }
  return out;
}

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
      if (b.type === 'text' && b.text.trim()) texts.push(b.text.trim());
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

const fileName = (title: string, kind: ExportKind) => `${(title || 'conversation').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'conversation'}.${kind}`;

async function build(id: string, kind: ExportKind): Promise<{ text: string; name: string }> {
  const d = await client.sessions.get(id);
  const messages = await allMessages(id).catch(() => d.history);
  return { text: conversationAsText(d.meta as SessionMeta & { createdAt?: number }, messages, kind), name: fileName(d.meta.title, kind) };
}

/** Saves the conversation as a .md or .txt file (a save dialog). */
export async function exportConversation(id: string, kind: ExportKind): Promise<void> {
  try {
    const { text, name } = await build(id, kind);
    const saved = await desktop.saveText(name, text, kind);
    if (saved) toast(`Saved ${saved}`, { kind: 'success' });
  } catch (e) { toast((e as Error).message, { kind: 'error' }); }
}

/** Copies the conversation to the clipboard as Markdown. */
export async function copyConversation(id: string): Promise<void> {
  try {
    const { text } = await build(id, 'md');
    await desktop.clipboard(text);
    toast('Copied the conversation as Markdown', { kind: 'success' });
  } catch (e) { toast((e as Error).message, { kind: 'error' }); }
}
