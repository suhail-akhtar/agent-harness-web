import fs from 'node:fs/promises';
import path from 'node:path';

// Tool output too long for the context, kept rather than cut. clip() keeps a head and a tail and
// drops the middle for good: the agent can see that something is gone and has no way to get it
// back, so it reasons from a fragment (or runs the command again, filtered, and pays twice).
// Here the whole text goes to a file in the workspace, and the agent is handed the head, the tail,
// the file's path and its line count: it reads the middle with read (offset/limit) or grep.
//
// Where: <workspace>/.harness/spill/<session id>/. The workspace, because that is what the file
// tools read (the session's data folder is outside their reach), and the same folder is mounted
// in a Docker sandbox and readable in an OS sandbox. Not for a companion session (the files
// would have to be written to the person's computer; its own tools clip as before), and never
// for untrusted output (a page read back through `read` would no longer be marked as outside
// content). The folder carries a .gitignore of `*`, so a commit or a published branch never
// picks it up; it has a byte cap (the oldest files go first), and it is removed with the session.
// Text is redacted before it is written: the agent reads these files back.
//
// Spilling never fails a tool call: when the folder cannot be used, the output is clipped as before.

/** Share of the excerpt taken from the end: a log's last lines say how it ended. */
const TAIL_SHARE = 0.4;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

export interface SpillRef {
  /** Workspace-relative path (forward slashes), as the agent passes it to read. */
  rel: string;
  lines: number;
  chars: number;
}

export class SpillStore {
  /** <workspace>/.harness/spill/<session> */
  readonly dir: string;
  private readonly workspace: string;
  private readonly redact: (s: string) => string;
  private readonly maxBytes: number;
  private n = 0;
  /** Files written, oldest first, with their sizes (the cap removes from the front). */
  private files: { file: string; bytes: number }[] = [];
  private ready?: Promise<string | undefined>;

  constructor(workspace: string, session: string, opts: { redact?: (s: string) => string; maxBytes?: number } = {}) {
    this.workspace = workspace;
    this.dir = path.join(workspace, '.harness', 'spill', session.replace(/[^\w.-]/g, '_').slice(0, 64) || 'session');
    this.redact = opts.redact ?? ((s) => s);
    this.maxBytes = opts.maxBytes ?? (Number(process.env.HARNESS_SPILL_MAX_MB) > 0 ? Number(process.env.HARNESS_SPILL_MAX_MB) * 1024 * 1024 : DEFAULT_MAX_BYTES);
  }

  /** Bytes the session's spill files hold now. */
  get bytes(): number { return this.files.reduce((a, f) => a + f.bytes, 0); }

  /** The folder, made on first use; undefined when a link (or a file) is in the way. */
  private base(): Promise<string | undefined> {
    this.ready ??= (async () => {
      const spill = path.dirname(this.dir);
      for (const d of [path.join(this.workspace, '.harness'), spill, this.dir]) {
        const st = await fs.lstat(d).catch(() => null);
        if (!st) { await fs.mkdir(d).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e; }); continue; }
        if (st.isSymbolicLink() || !st.isDirectory()) return undefined;
      }
      // Never committed or published with the work.
      await fs.writeFile(path.join(spill, '.gitignore'), '*\n', { flag: 'wx' }).catch(() => {});
      return this.dir;
    })().catch(() => undefined);
    return this.ready;
  }

  /** Writes the whole text (redacted); undefined when it cannot be kept (no folder, over the cap, a write error). */
  async save(tool: string, text: string): Promise<SpillRef | undefined> {
    const dir = await this.base();
    if (!dir) return undefined;
    const clean = this.redact(text);
    const bytes = Buffer.byteLength(clean);
    // One output bigger than half the cap is not kept: it would push out everything else.
    if (bytes > this.maxBytes / 2) return undefined;
    const name = `${String(++this.n).padStart(4, '0')}-${tool.replace(/[^\w-]/g, '-').slice(0, 40) || 'tool'}.txt`;
    const file = path.join(dir, name);
    try {
      await fs.writeFile(file, clean, { flag: 'wx' });
    } catch { return undefined; }
    this.files.push({ file, bytes });
    while (this.bytes > this.maxBytes && this.files.length > 1) {
      const old = this.files.shift()!;
      await fs.unlink(old.file).catch(() => {});
    }
    return { rel: path.relative(this.workspace, file).split(path.sep).join('/'), lines: lineCount(clean), chars: clean.length };
  }

  /** Removes the session's spill files and its folder (only plain files of ours; never through a link). */
  async remove(): Promise<void> {
    const st = await fs.lstat(this.dir).catch(() => null);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) return;
    for (const e of await fs.readdir(this.dir, { withFileTypes: true }).catch(() => [])) {
      if (e.isFile()) await fs.unlink(path.join(this.dir, e.name)).catch(() => {});
    }
    await fs.rmdir(this.dir).catch(() => {});
    this.files = [];
  }

  /**
   * The text the agent sees for `text`: unchanged when it fits `max`, else its head and tail with
   * where the rest is (or, when it cannot be kept, clipped as before, saying so).
   */
  async excerpt(tool: string, text: string, max: number, hint = ''): Promise<string> {
    if (text.length <= max) return text;
    // Redacted before it is cut: a cut could split a secret into a piece the redactor no longer knows.
    const clean = this.redact(text);
    const ref = await this.save(tool, clean);
    return excerpt(clean, max, ref, hint);
  }
}

const lineCount = (s: string) => (s ? s.split('\n').length - (s.endsWith('\n') ? 1 : 0) : 0);

/** Head and tail of `text` within `max` characters (the notice included), with the spill file's path when there is one. */
export function excerpt(text: string, max: number, ref?: SpillRef, hint = ''): string {
  if (text.length <= max) return text;
  const notice = (dropped: number) => (ref
    ? `\n\n[... ${dropped} characters not shown. The whole output (${ref.lines} lines) is in ${ref.rel}: read it with offset/limit or grep it for the part you need.]\n\n`
    : `\n\n[... ${dropped} characters omitted${hint ? ` - ${hint}` : ''} ...]\n\n`);
  // The notice counts toward max (its number's width taken at its largest).
  const room = Math.max(0, max - notice(text.length).length);
  const tail = Math.floor(room * TAIL_SHARE);
  const head = room - tail;
  return `${text.slice(0, head)}${notice(text.length - head - tail)}${tail ? text.slice(text.length - tail) : ''}`;
}

/** The spill file a result names (a masked result's placeholder keeps it). */
export function spillPathIn(content: string): string | undefined {
  return /The whole output \(\d+ lines\) is in (\.harness\/spill\/[^\s:]+):/.exec(content)?.[1];
}
