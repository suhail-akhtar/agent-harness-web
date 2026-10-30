/**
 * Export as Markdown / as text and Copy as Markdown (the conversation's header and its row in the
 * sidebar). The text itself is built in conversation-text.ts.
 */

import type { Message, SessionMeta } from '@harness/client';
import { toast } from '@harness/ui';
import { desktop } from '../../bridge';
import { client } from '../../state/data';
import { conversationAsText, type ExportKind } from './conversation-text';

export type { ExportKind };

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
