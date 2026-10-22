/**
 * Splitting Markdown into top-level blocks, so a streaming reply re-parses only its last block.
 *
 * Every delta used to re-parse the whole reply: fine for a paragraph, a stutter for a long answer
 * with tables and a diagram. Blocks that are complete never change again, so each is rendered by its
 * own memoised component (keyed by position) and only the tail one sees new text. The split is
 * conservative: inside a fence or a $$ block nothing splits; an indented line or a list item after a
 * blank line belongs to the block before; and anything with footnotes or link definitions (which
 * reach across blocks) is kept whole.
 */

export function splitBlocks(md: string): string[] {
  if (!md) return [];
  if (/\[\^[^\]]+\]/.test(md) || /^\s{0,3}\[[^\]]+\]:\s*\S/m.test(md)) return [md];
  const lines = md.split('\n');
  const blocks: string[] = [];
  let cur: string[] = [];
  let fence: string | null = null;
  let math = false;
  let pendingBlank = false;
  const isListItem = (l: string) => /^\s{0,3}([-*+]|\d+[.)])\s/.test(l);
  const curIsList = () => cur.some((l) => isListItem(l));
  for (const line of lines) {
    if (fence) {
      cur.push(line);
      if (line.trim().startsWith(fence) && line.trim().replace(/[`~]/g, '') === '') fence = null;
      continue;
    }
    if (math) {
      cur.push(line);
      if (line.trim().endsWith('$$')) math = false;
      continue;
    }
    if (line.trim() === '') { pendingBlank = true; continue; }
    if (pendingBlank && cur.length) {
      const continues = /^\s/.test(line) || (isListItem(line) && curIsList());
      if (continues) cur.push('');
      else { blocks.push(cur.join('\n')); cur = []; }
    }
    pendingBlank = false;
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) fence = f[1]!;
    else if (line.trim().startsWith('$$') && !(line.trim().length > 2 && line.trim().endsWith('$$'))) math = true;
    cur.push(line);
  }
  if (cur.length) blocks.push(cur.join('\n') + (pendingBlank ? '\n' : ''));
  return blocks;
}

/** True while a block's fence (or $$) is still open: the renderer shows it as "arriving". */
export function isOpenBlock(block: string): boolean {
  let fence: string | null = null;
  let math = false;
  for (const line of block.split('\n')) {
    if (fence) { if (line.trim().startsWith(fence) && line.trim().replace(/[`~]/g, '') === '') fence = null; continue; }
    if (math) { if (line.trim().endsWith('$$')) math = false; continue; }
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) fence = f[1]!;
    else if (line.trim().startsWith('$$') && !(line.trim().length > 2 && line.trim().endsWith('$$'))) math = true;
  }
  return fence !== null || math;
}
