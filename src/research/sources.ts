import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { checkCitations, type CitationReport, formatCitationReport } from './citations.ts';

// Every page the agent searched for or read in a session, kept by the harness
// (not in the workspace, where the agent could write "sources" itself). The
// citation check compares a report against exactly this: a citation is only as
// good as the text the agent actually fetched.

export interface SourceEntry {
  url: string;
  finalUrl: string;
  title?: string;
  fetchedAt: number;
  chars: number;
  file: string;
}

export interface SearchHit { title: string; url: string; snippet?: string; date?: string }

export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|ref$|ref_src$)/i.test(k)) u.searchParams.delete(k);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const p = u.pathname.replace(/\/+$/, '') || '';
    const q = u.searchParams.toString();
    return `${host}${p}${q ? `?${q}` : ''}`;
  } catch { return raw.trim(); }
}

/**
 * A URL exactly as it is requested, for the known set: http(s), no fragment (it is not sent), no user name or
 * password; else undefined. Never normalizeUrl: that maps a changed query or port to the same page, and what
 * changed is where data would ride.
 */
export function exactUrl(raw: string): string | undefined {
  try {
    const u = new URL(raw.trim());
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return undefined;
    u.hash = '';
    return u.href;
  } catch { return undefined; }
}

const MAX_KNOWN = 20_000;
/** How many links from a search hit or the person's words stay known: a page choosing what comes next can only signal so far. */
const MAX_LINK_DEPTH = 2;

export class SourceStore {
  readonly dir: string;
  private index?: SourceEntry[];
  private searches: { at: number; query: string; hits: SearchHit[] }[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  /**
   * URLs that existed before the agent could put anything in them (search hits, the person's words, links of pages
   * reached from those), with their distance from the first. Fetching one exactly carries nothing of the session's:
   * the untrusted-content guard does not ask (permissions.ts). Written by the harness only, and in memory only: a
   * bundle or a file cannot bring any in.
   */
  private known = new Map<string, number>();

  constructor(dir: string) { this.dir = dir; }

  private async load(): Promise<SourceEntry[]> {
    if (this.index) return this.index;
    try { this.index = JSON.parse(await fs.readFile(path.join(this.dir, 'index.json'), 'utf8')) as SourceEntry[]; } catch { this.index = []; }
    return this.index;
  }

  async list(): Promise<SourceEntry[]> { return [...await this.load()]; }

  /** Records a fetched page (the latest text wins). Serialised: fetches run in parallel. */
  recordFetch(e: { url: string; finalUrl: string; title?: string; text: string }): Promise<SourceEntry> {
    const next = this.queue.catch(() => {}).then(async () => {
      const idx = await this.load();
      const file = `${crypto.createHash('sha256').update(normalizeUrl(e.finalUrl)).digest('hex').slice(0, 24)}.txt`;
      await fs.mkdir(this.dir, { recursive: true });
      await fs.writeFile(path.join(this.dir, file), e.text);
      const entry: SourceEntry = { url: e.url, finalUrl: e.finalUrl, title: e.title, fetchedAt: Date.now(), chars: e.text.length, file };
      const keys = new Set([normalizeUrl(e.url), normalizeUrl(e.finalUrl)]);
      const kept = idx.filter((x) => !keys.has(normalizeUrl(x.url)) && !keys.has(normalizeUrl(x.finalUrl)));
      kept.push(entry);
      this.index = kept;
      const tmp = path.join(this.dir, `index.json.${crypto.randomUUID().slice(0, 8)}.tmp`);
      await fs.writeFile(tmp, JSON.stringify(kept, null, 1));
      await fs.rename(tmp, path.join(this.dir, 'index.json'));
      return entry;
    });
    this.queue = next;
    return next;
  }

  /** Was this very URL seen (see `known`)? Exact: another query, port or path is another URL. */
  knows(url: string): boolean {
    const key = exactUrl(url);
    return !!key && this.known.has(key);
  }

  learn(urls: Iterable<string>, depth = 0): void {
    for (const u of urls) {
      const key = exactUrl(u);
      if (key && !this.known.has(key) && this.known.size < MAX_KNOWN) this.known.set(key, depth);
    }
  }

  /**
   * What a fetched page adds: its final address and its links, only when the request itself was known. A composed
   * URL proves nothing about the page it reaches: a site that echoes its query would hand the agent's own URL
   * back as a link.
   */
  learnPage(asked: string, finalUrl: string, links: readonly string[]): void {
    const depth = this.known.get(exactUrl(asked) ?? '');
    if (depth === undefined) return;
    this.learn([finalUrl], depth);
    if (depth < MAX_LINK_DEPTH) this.learn(links, depth + 1);
  }

  recordSearch(query: string, hits: SearchHit[]): void {
    this.learn(hits.map((h) => h.url));
    this.searches.push({ at: Date.now(), query, hits });
    fs.mkdir(this.dir, { recursive: true }).then(() => fs.appendFile(path.join(this.dir, 'searches.jsonl'), JSON.stringify({ at: Date.now(), query, hits }) + '\n')).catch(() => {});
  }

  /** A fetched source by any URL it was known under. */
  async find(url: string): Promise<SourceEntry | undefined> {
    await this.queue.catch(() => {});
    const key = normalizeUrl(url);
    return (await this.load()).find((x) => normalizeUrl(x.url) === key || normalizeUrl(x.finalUrl) === key);
  }

  async text(entry: SourceEntry): Promise<string> {
    return fs.readFile(path.join(this.dir, entry.file), 'utf8');
  }

  /** Checks a report's citations against what was read in this session (see citations.ts). */
  async check(report: string): Promise<CitationReport & { summary: string }> {
    const r = await checkCitations(report, this);
    return { ...r, summary: formatCitationReport(r) };
  }
}
