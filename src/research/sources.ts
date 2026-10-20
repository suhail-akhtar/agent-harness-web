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

export class SourceStore {
  readonly dir: string;
  private index?: SourceEntry[];
  private searches: { at: number; query: string; hits: SearchHit[] }[] = [];
  private queue: Promise<unknown> = Promise.resolve();

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

  recordSearch(query: string, hits: SearchHit[]): void {
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
