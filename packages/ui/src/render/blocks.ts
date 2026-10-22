/**
 * Splitting Markdown into top-level blocks, so a streaming reply re-parses only its last block.
 *
 * Every delta used to re-parse the whole reply: fine for a paragraph, a stutter for a long answer
 * with tables and a diagram. Blocks that are complete never change again, so each is rendered by its
 * own memoised component (keyed by position) and only the tail one sees new text. The split is
 * conservative: inside a fence or a $$ block nothing splits; an indented line or a list item after a
 * blank line belongs to the block before.
 *
 * The split only ever appends to its last block, so every block but the last one of any prefix of a
 * reply is final: its key (its position) and its text stay the same as more text arrives. One partial
 * line could still change that (a "-" after a list may become "- next item"), so while streaming an
 * unfinished line that could go either way is held back until it can be decided (planBlocks).
 *
 * Footnotes and link reference definitions reach across blocks: they used to keep the whole reply as
 * one block, which re-rendered everything on every delta (and switched every code block and formula
 * above the tail between "arriving" and drawn as the tail entered and left a fence). Now each block is
 * given the definitions it refers to, and the footnotes are drawn once, at the end (planBlocks).
 */

export function splitBlocks(md: string): string[] {
  if (!md) return [];
  const lines = md.split('\n');
  const blocks: string[] = [];
  let cur: string[] = [];
  let fence: string | null = null;
  let math = false;
  let pendingBlank = false;
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

const isListItem = (l: string) => /^\s{0,3}([-*+]|\d+[.)])\s/.test(l);

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

/**
 * While streaming: the text without an unfinished last line whose meaning the next delta decides, shown
 * once it is decided. After a blank line under a list, "-", "1" or "12." may join the list (the block
 * before) or start a new block: held back, the blocks before it never change. Right under a line of
 * text, "-" or "=" may be a heading's underline (the line above would flash as a heading); and "[" at
 * the start of a block may be a footnote or link definition (drawn as text, then gone): held back too.
 */
export function settledText(md: string): string {
  const nl = md.lastIndexOf('\n');
  const tail = md.slice(nl + 1);
  const underList = /^\s{0,3}([-*+]|\d{1,9}[.)]?)$/.test(tail);
  const underline = /^\s*(-+|=+)\s*$/.test(tail);
  const definition = /^\s{0,3}\[[^\]]*(\]:?)?$/.test(tail);
  if (!underList && !underline && !definition) return md;
  const head = nl < 0 ? '' : md.slice(0, nl);
  const afterBlank = nl < 0 || /(^|\n)\s*$/.test(head);
  const blocks = head ? splitBlocks(head) : [];
  const last = blocks[blocks.length - 1];
  if (last && isOpenBlock(last)) return md; // inside a fence or $$: it is just text
  const cut = md.slice(0, nl + 1);
  if (definition && afterBlank) return cut;
  if (underline && !afterBlank) return cut;
  if (underList && afterBlank && last?.split('\n').some(isListItem)) return cut;
  return md;
}

const FOOTNOTE_DEF = /^\s{0,3}\[\^([^\]\s]+)\]:/;
const LINK_DEF = /^\s{0,3}\[([^\]^][^\]]*)\]:\s*\S/;
const FOOTNOTE_REF = /\[\^([^\]\s]+)\]/g;
const norm = (label: string) => label.trim().replace(/\s+/g, ' ').toLowerCase();

export interface PlannedBlock {
  /** Stable across deltas: the block's position in the reply. */
  key: string;
  /** What the block renders: its own text, plus the definitions (footnotes, link references) it refers to. */
  text: string;
  /** True while its fence or $$ is open (only ever the last block). */
  open: boolean;
}

export interface BlockPlan {
  blocks: PlannedBlock[];
  /** The footnotes referenced and defined, in the order of their first reference ("1", "note"...). */
  footnotes: string[];
  /** A document whose only output is the footnotes section, numbered in that order; '' when there are none. */
  footnotesDoc: string;
}

/**
 * The blocks to render for a reply. Definition blocks render nothing themselves: each block that refers
 * to a footnote or a link reference gets its definition appended (so a block changes only when a
 * definition it uses arrives), and the footnotes are one section at the end (footnotesDoc). While
 * streaming, the unfinished tail is never used as a definition, and an undecided last line is held back.
 */
export function planBlocks(md: string, o: { streaming?: boolean } = {}): BlockPlan {
  const raw = splitBlocks(o.streaming ? settledText(md) : md);
  const defs: Array<{ index: number; text: string; footnotes: string[]; links: string[] }> = [];
  const isDef = raw.map((b, i) => {
    const lines = b.split('\n');
    const first = lines[0]!;
    if (!FOOTNOTE_DEF.test(first) && !lines.every((l) => l.trim() === '' || LINK_DEF.test(l))) return false;
    // The tail of a streaming reply may still be arriving: not used until it is complete.
    if (!(o.streaming && i === raw.length - 1)) {
      defs.push({
        index: i, text: b.replace(/\n+$/, ''),
        footnotes: lines.flatMap((l) => { const m = FOOTNOTE_DEF.exec(l); return m ? [norm(m[1]!)] : []; }),
        links: lines.flatMap((l) => { const m = LINK_DEF.exec(l); return m ? [norm(m[1]!)] : []; }),
      });
    }
    return true;
  });
  const definedFootnotes = new Set(defs.flatMap((d) => d.footnotes));
  const firstDef = new Map<string, (typeof defs)[number]>();
  for (const d of defs) for (const label of [...d.footnotes.map((f) => `^${f}`), ...d.links]) if (!firstDef.has(label)) firstDef.set(label, d);
  const footnotes: string[] = [];
  const seen = new Set<string>();
  const blocks: PlannedBlock[] = [];
  raw.forEach((b, i) => {
    if (isDef[i]) return;
    const open = isOpenBlock(b);
    let text = b;
    const refs = open ? new Set<string>() : new Set([...b.matchAll(FOOTNOTE_REF)].map((m) => norm(m[1]!)));
    if ((defs.length || refs.size) && !open) {
      const lower = b.toLowerCase();
      // Streaming, a reference is numbered before its definition arrives (it would show as "[^1]", then shrink).
      for (const r of refs) if ((o.streaming || definedFootnotes.has(r)) && !seen.has(r)) { seen.add(r); footnotes.push(r); }
      // The first definition of a label wins (as in CommonMark): a later one never changes a block.
      const needed = defs.filter((d) => d.footnotes.some((f) => refs.has(f) && firstDef.get(`^${f}`) === d) || d.links.some((l) => lower.includes(`[${l}]`) && firstDef.get(l) === d));
      const waiting = o.streaming ? [...refs].filter((r) => !definedFootnotes.has(r)).map((r) => `[^${r}]: …`) : [];
      const appended = [...needed.map((d) => d.text), ...waiting];
      if (appended.length) text = `${b.replace(/\n+$/, '')}\n\n${appended.join('\n\n')}`;
    }
    blocks.push({ key: `b${i}`, text, open });
  });
  const footnotesDoc = footnotes.length
    ? `${footnotes.map((f) => `[^${f}]`).join(' ')}\n\n${defs.map((d) => d.text).join('\n\n')}`
    : '';
  return { blocks, footnotes, footnotesDoc };
}
