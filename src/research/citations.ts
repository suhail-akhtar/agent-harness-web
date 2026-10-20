import { normalizeUrl, type SourceStore } from './sources.ts';

// A deterministic check of a written report against the sources the agent
// actually read. It cannot judge whether a claim is well argued; it catches the
// failures that matter most and that a model reviewer misses most often:
//   - a citation to a page that was never fetched (made up, or only seen in a
//     search result);
//   - a quotation that does not appear in the cited source;
//   - a figure (percent, money, a number with 3+ digits, a year) in a cited
//     sentence that does not appear in any source that sentence cites.
// A figure the author computed goes in its own sentence marked "(derived: ...)";
// such sentences are not figure-checked.

export interface CitationIssue { kind: 'unread' | 'quote' | 'figure' | 'dangling'; line: number; text: string; detail: string }
export interface CitationReport {
  citations: number;
  sources: number;
  sentencesChecked: number;
  issues: CitationIssue[];
  uncited: number;
}

interface Ref { id: string; url: string }

/** Reference definitions: "[1]: url", "[1] Title - url", "1. Title. url", footnotes "[^1]: ... url". */
export function parseReferences(text: string): Map<string, string> {
  const refs = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^\s*(?:\[\^?([\w-]+)\]:?|(\d+)[.)])\s+(.*)$/.exec(line);
    if (!m) continue;
    const url = /(https?:\/\/[^\s)>\]]+)/.exec(m[3]!)?.[1]?.replace(/[.,;]+$/, '');
    if (url) refs.set(m[1] ?? m[2]!, url);
  }
  return refs;
}

const QUOTE = /["“]([^"”]{12,400})["”]/g;
const FIGURE = /(?:[$€£]\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:million|billion|trillion|bn|m|k))?)|(?:\d[\d,]*(?:\.\d+)?\s?%)|(?:\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b)|(?:\b\d{3,}(?:\.\d+)?\b)|(?:\b\d+\.\d+\b)/gi;

/** Comparable text: lower case, quotes and dashes unified, whitespace collapsed. */
export function canon(s: string): string {
  return s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—−]/g, '-').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

/** The forms a figure can take in a source: "1,234" ~ "1234", "12%" ~ "12 percent". */
function figureForms(f: string): string[] {
  const t = f.toLowerCase().replace(/\s+/g, ' ').trim();
  const bare = t.replace(/[$€£]\s?/, '').replace(/\s?%$/, '').replace(/\s?(million|billion|trillion|bn|m|k)$/, '');
  const nocomma = bare.replace(/,/g, '');
  const withComma = /^\d{4,}$/.test(nocomma) ? Number(nocomma).toLocaleString('en-US') : nocomma;
  return [...new Set([bare, nocomma, withComma])].filter(Boolean);
}

function figureIn(source: string, f: string): boolean {
  return figureForms(f).some((form) => new RegExp(`(^|[^\\d.,])${form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\d])`).test(source));
}

/** Sentences with their line numbers; reference-list lines and code blocks are skipped. */
function sentences(text: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let inCode = false;
  text.split('\n').forEach((raw, i) => {
    if (/^\s*```/.test(raw)) { inCode = !inCode; return; }
    if (inCode || /^\s*(?:\[\^?[\w-]+\]:|\d+[.)]\s+.*https?:\/\/)/.test(raw) || /^\s*#/.test(raw)) return;
    for (const s of raw.split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/)) if (s.trim()) out.push({ line: i + 1, text: s.trim() });
  });
  return out;
}

export async function checkCitations(report: string, sources: SourceStore): Promise<CitationReport> {
  const refs = parseReferences(report);
  const issues: CitationIssue[] = [];
  const textOf = new Map<string, string | null>();
  const sourceText = async (url: string): Promise<string | null> => {
    const k = normalizeUrl(url);
    if (!textOf.has(k)) {
      const e = await sources.find(url);
      textOf.set(k, e ? canon(await sources.text(e)) : null);
    }
    return textOf.get(k)!;
  };

  // Every reference must be something the agent read.
  const cited = new Set<string>();
  for (const [id, url] of refs) {
    cited.add(url);
    if ((await sourceText(url)) === null) issues.push({ kind: 'unread', line: lineOf(report, url), text: `[${id}] ${url}`, detail: 'never fetched in this session: read it with web_fetch, or remove the citation' });
  }

  let checked = 0;
  let uncited = 0;
  for (const s of sentences(report)) {
    const markers = [...s.text.matchAll(/\[\^?([\w-]+)\](?!\()/g)].map((m) => m[1]!).filter((id) => /^\d+$|^\^|^[\w-]+$/.test(id));
    const inline = [...s.text.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]!);
    const urls: Ref[] = [];
    for (const id of markers) {
      const url = refs.get(id);
      if (url) urls.push({ id, url });
      else if (/^\d+$/.test(id)) issues.push({ kind: 'dangling', line: s.line, text: s.text.slice(0, 160), detail: `[${id}] has no entry in the reference list` });
    }
    for (const url of inline) {
      urls.push({ id: url, url });
      if (!cited.has(url)) {
        cited.add(url);
        if ((await sourceText(url)) === null) issues.push({ kind: 'unread', line: s.line, text: url, detail: 'linked, but never fetched in this session' });
      }
    }
    const figures = s.text.replace(/\[[^\]]*\]\([^)]*\)/g, '').replace(/\[\^?[\w-]+\]/g, '').match(FIGURE) ?? [];
    const quotes = [...s.text.matchAll(QUOTE)].map((m) => m[1]!);
    if (!urls.length) { if (figures.length || quotes.length) uncited++; continue; }
    checked++;
    const texts = (await Promise.all(urls.map((u) => sourceText(u.url)))).filter((t): t is string => t !== null);
    if (!texts.length) continue; // reported as unread above
    for (const q of quotes) {
      const cq = canon(q).replace(/^\.\.\.|\.\.\.$|…/g, '').trim();
      if (!texts.some((t) => t.includes(cq))) issues.push({ kind: 'quote', line: s.line, text: q.slice(0, 160), detail: `not found word for word in ${urls.map((u) => `[${u.id}]`).join(', ')}` });
    }
    if (/\(derived\b/i.test(s.text)) continue;
    for (const f of new Set(figures)) {
      if (/^(19|20)\d{2}$/.test(f.trim()) && texts.some((t) => t.includes(f.trim()))) continue;
      if (!texts.some((t) => figureIn(t, f))) issues.push({ kind: 'figure', line: s.line, text: s.text.slice(0, 160), detail: `"${f.trim()}" does not appear in ${urls.map((u) => `[${u.id}]`).join(', ')} (a computed figure goes in its own sentence ending "(derived: ...)")` });
    }
  }
  return { citations: cited.size, sources: (await sources.list()).length, sentencesChecked: checked, issues, uncited };
}

function lineOf(text: string, needle: string): number {
  const i = text.indexOf(needle);
  return i < 0 ? 0 : text.slice(0, i).split('\n').length;
}

export function formatCitationReport(r: CitationReport): string {
  const head = r.issues.length
    ? `${r.issues.length} citation problem(s) in ${r.sentencesChecked} cited sentence(s):`
    : `All ${r.citations} citation(s) point to pages read in this session; quotes and figures in ${r.sentencesChecked} cited sentence(s) match their sources.`;
  const lines = r.issues.slice(0, 40).map((i) => `- line ${i.line} [${i.kind}] ${i.detail}: ${i.text}`);
  const tail = r.uncited ? `\nNote: ${r.uncited} sentence(s) with figures or quotes cite nothing.` : '';
  return [head, ...lines].join('\n') + tail;
}
