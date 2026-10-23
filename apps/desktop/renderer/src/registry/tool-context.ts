/**
 * What a plugin's frame renderer of a tool's result is given (its init `context`): the call and its
 * result, the conversation it is in (so a renderer can read that session's files with files.read,
 * or find its workspace with sessions.get), and the images the result carried: the frame replaces
 * the default card, image strip included, so it gets them to draw (up to 8 MB in all, in order).
 */

export interface ToolRendererContext {
  tool: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  sessionId: string;
  images?: Array<{ media_type: string; data: string }>;
}

export const TOOL_CONTEXT_IMAGE_BYTES = 8 * 1024 * 1024;

export function toolRendererContext(item: { name: string; input: Record<string, unknown>; result?: string; isError?: boolean; images?: Array<{ media_type: string; data: string }> }, sessionId: string): ToolRendererContext {
  let budget = TOOL_CONTEXT_IMAGE_BYTES;
  const images: Array<{ media_type: string; data: string }> = [];
  for (const im of item.images ?? []) {
    if (im.data.length > budget) break;
    budget -= im.data.length;
    images.push({ media_type: im.media_type, data: im.data });
  }
  return { tool: item.name, input: item.input, result: item.result, isError: item.isError, sessionId, ...(images.length ? { images } : {}) };
}
