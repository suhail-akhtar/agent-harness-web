import type { Block, Message } from '../core/types.ts';

/**
 * For providers whose tool results are text only: a result's images follow
 * the results as user content, in the same message. Pure, so the prompt is
 * byte-identical on every request and the cache holds.
 */
export function splitToolImages(m: Message): Message {
  if (m.role !== 'user' || !m.content.some((b) => b.type === 'tool_result' && b.images?.length)) return m;
  const head: Block[] = [];
  const tail: Block[] = [];
  for (const b of m.content) {
    if (b.type === 'tool_result' && b.images?.length) {
      head.push({ type: 'tool_result', tool_use_id: b.tool_use_id, content: b.content, ...(b.is_error ? { is_error: true } : {}) });
      tail.push({ type: 'text', text: `Image(s) from tool call ${b.tool_use_id}:` }, ...b.images.map((i) => ({ type: 'image' as const, media_type: i.media_type, data: i.data })));
    } else if (b.type === 'tool_result') head.push(b);
    else tail.push(b);
  }
  return { ...m, content: [...head, ...tail] };
}
