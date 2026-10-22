import crypto from 'node:crypto';
import { constants as fsc } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Tool } from '../tools/types.ts';
import { bool, clip, num, str } from '../tools/types.ts';
import { withFileLock, writeFileAtomic } from '../util/shared-file.ts';
import { validateDiagram } from '../../packages/plugin-ui/src/diagram.ts';

// Artifacts: documents, apps, diagrams and data an agent makes for the person to keep -
// versioned files in the session's workspace under .harness/artifacts/<id>/v<n>.<ext>,
// with a meta.json per artifact. Clients render them sandboxed (html, svg and react in a
// frame without same origin); the server never serves one as an active page of its own.

export const ARTIFACT_KINDS = ['markdown', 'html', 'svg', 'react', 'mermaid', 'code', 'csv', 'json', 'chart', 'diagram', 'image', 'pdf'] as const;
export type ArtifactKind = typeof ARTIFACT_KINDS[number];
const BINARY = new Set<ArtifactKind>(['image', 'pdf']);

export interface ArtifactVersion { n: number; at: number; size: number; action: 'create' | 'update' | 'rewrite'; file: string }
export interface ArtifactMeta {
  id: string; title: string; kind: ArtifactKind; language?: string; contentType: string;
  version: number; versions: ArtifactVersion[]; createdAt: number; updatedAt: number;
}

export class ArtifactError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

const ID = /^[a-z0-9][a-z0-9-]{2,60}$/;
const TEXT_MAX = () => Math.max(16, Number(process.env.HARNESS_ARTIFACT_MAX_KB ?? 1024) || 1024) * 1024;
const BINARY_MAX = 10 * 1024 * 1024;
const MAX_VERSIONS = 100;
const MAX_ARTIFACTS = 300;

const CODE_EXT: Record<string, string> = { javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', tsx: 'tsx', jsx: 'jsx', python: 'py', py: 'py', go: 'go', rust: 'rs', java: 'java', c: 'c', cpp: 'cpp', csharp: 'cs', ruby: 'rb', php: 'php', shell: 'sh', bash: 'sh', sql: 'sql', yaml: 'yaml', toml: 'toml', css: 'css', kotlin: 'kt', swift: 'swift' };
const IMAGE_TYPES: Record<string, { ext: string; type: string; magic: (b: Buffer) => boolean }> = {
  png: { ext: 'png', type: 'image/png', magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  jpeg: { ext: 'jpg', type: 'image/jpeg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 },
  gif: { ext: 'gif', type: 'image/gif', magic: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8' },
  webp: { ext: 'webp', type: 'image/webp', magic: (b) => b.subarray(8, 12).toString('latin1') === 'WEBP' },
};

/** File extension and content type of a kind (the language picks code's extension, an image's format). */
export function kindFile(kind: ArtifactKind, language?: string): { ext: string; type: string } {
  switch (kind) {
    case 'markdown': return { ext: 'md', type: 'text/markdown; charset=utf-8' };
    case 'html': return { ext: 'html', type: 'text/html; charset=utf-8' };
    case 'svg': return { ext: 'svg', type: 'image/svg+xml' };
    case 'react': return { ext: 'jsx', type: 'text/jsx; charset=utf-8' };
    case 'mermaid': return { ext: 'mmd', type: 'text/vnd.mermaid; charset=utf-8' };
    case 'csv': return { ext: 'csv', type: 'text/csv; charset=utf-8' };
    case 'json': case 'chart': case 'diagram': return { ext: 'json', type: 'application/json' };
    case 'pdf': return { ext: 'pdf', type: 'application/pdf' };
    case 'image': { const t = IMAGE_TYPES[(language ?? 'png').toLowerCase().replace('jpg', 'jpeg')] ?? IMAGE_TYPES.png!; return { ext: t.ext, type: t.type }; }
    default: return { ext: CODE_EXT[(language ?? '').toLowerCase()] ?? 'txt', type: 'text/plain; charset=utf-8' };
  }
}

/** Binary content arrives as base64 or a data: URL; text as it is. Checked for kind and size. */
function encode(kind: ArtifactKind, content: string, language?: string): Buffer {
  if (!BINARY.has(kind)) {
    const b = Buffer.from(content, 'utf8');
    if (b.length > TEXT_MAX()) throw new ArtifactError(`content is ${Math.round(b.length / 1024)} KB; an artifact version is at most ${TEXT_MAX() / 1024} KB`);
    if ((kind === 'json' || kind === 'chart') && content.trim()) { try { JSON.parse(content); } catch (e) { throw new ArtifactError(`a ${kind} artifact must be valid JSON: ${(e as Error).message}`); } }
    // A diagram is checked against its spec (packages/plugin-ui/src/diagram.ts), so the model hears what to fix at once.
    if (kind === 'diagram') { const r = validateDiagram(content); if (r.error) throw new ArtifactError(`not a valid diagram: ${r.error}`); }
    return b;
  }
  const m = /^data:([\w/+.-]+);base64,(.*)$/s.exec(content.trim());
  const b = Buffer.from((m ? m[2]! : content).replace(/\s+/g, ''), 'base64');
  if (!b.length) throw new ArtifactError(`a ${kind} artifact's content is base64 (or a data: URL), or give path to a workspace file`);
  if (b.length > BINARY_MAX) throw new ArtifactError(`content is larger than ${BINARY_MAX / 1048576} MB`);
  if (kind === 'pdf' && b.subarray(0, 5).toString('latin1') !== '%PDF-') throw new ArtifactError('this is not a PDF (it does not start with %PDF-)');
  if (kind === 'image' && !IMAGE_TYPES[(language ?? 'png').toLowerCase().replace('jpg', 'jpeg')]?.magic(b)) throw new ArtifactError(`this is not a ${language ?? 'png'} image (set language to png, jpeg, gif or webp)`);
  return b;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'artifact';

/**
 * The artifacts of one workspace. Every folder on the way is checked not to be a link (a
 * command in the workspace could plant one pointing at a server file), files are opened
 * without following links, and meta.json changes under a lock.
 */
export class ArtifactStore {
  readonly root: string;
  private opts: { keep?: number };
  /** keep: past this many versions the oldest are dropped instead of refusing a new one (documents edited often, like dashboards). */
  constructor(workspace: string, opts: { keep?: number } = {}) { this.root = path.join(workspace, '.harness', 'artifacts'); this.opts = opts; }

  /** The artifacts folder, made if asked; refused when a link is on the way. */
  private async base(make: boolean): Promise<string | undefined> {
    const ws = path.dirname(path.dirname(this.root));
    for (const d of [path.join(ws, '.harness'), this.root]) {
      const st = await fs.lstat(d).catch(() => null);
      if (!st) { if (!make) return undefined; await fs.mkdir(d).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e; }); continue; }
      if (st.isSymbolicLink() || !st.isDirectory()) throw new ArtifactError(`${path.relative(ws, d)} is not a plain folder (a link?): artifacts are not kept there`, 409);
    }
    return this.root;
  }

  private async dir(id: string, make: boolean): Promise<string | undefined> {
    if (!ID.test(id)) throw new ArtifactError(`no artifact "${id}"`, 404);
    const base = await this.base(make);
    if (!base) return undefined;
    const d = path.join(base, id);
    const st = await fs.lstat(d).catch(() => null);
    if (!st) { if (!make) return undefined; await fs.mkdir(d); return d; }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new ArtifactError(`artifact ${id} is not a plain folder`, 409);
    return d;
  }

  private async readNoFollow(file: string, max: number): Promise<Buffer> {
    const fh = await fs.open(file, fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0)).catch(() => { throw new ArtifactError('artifact file missing', 404); });
    try {
      const st = await fh.stat();
      if (!st.isFile() || st.size > max) throw new ArtifactError('artifact file is not readable', 409);
      const buf = Buffer.alloc(st.size);
      if (st.size) await fh.read(buf, 0, st.size, 0);
      return buf;
    } finally { await fh.close(); }
  }

  async meta(id: string): Promise<ArtifactMeta | undefined> {
    const d = await this.dir(id, false);
    if (!d) return undefined;
    try { return JSON.parse((await this.readNoFollow(path.join(d, 'meta.json'), 1_000_000)).toString('utf8')) as ArtifactMeta; } catch { return undefined; }
  }

  async list(): Promise<ArtifactMeta[]> {
    const base = await this.base(false).catch(() => undefined);
    if (!base) return [];
    const names = (await fs.readdir(base).catch(() => [] as string[])).filter((n) => ID.test(n));
    const out = (await Promise.all(names.map((n) => this.meta(n).catch(() => undefined)))).filter((m): m is ArtifactMeta => !!m);
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** A version's bytes (the latest by default) with its meta. */
  async get(id: string, version?: number): Promise<{ meta: ArtifactMeta; v: ArtifactVersion; data: Buffer }> {
    const meta = await this.meta(id);
    if (!meta) throw new ArtifactError(`no artifact "${id}"`, 404);
    const v = meta.versions.find((x) => x.n === (version ?? meta.version));
    if (!v) throw new ArtifactError(`artifact ${id} has no version ${version} (versions 1-${meta.version})`, 404);
    const d = (await this.dir(id, false))!;
    return { meta, v, data: await this.readNoFollow(path.join(d, path.basename(v.file)), BINARY_MAX + 1) };
  }

  private async write(d: string, meta: ArtifactMeta, data: Buffer, action: ArtifactVersion['action']): Promise<ArtifactMeta> {
    if (this.opts.keep && meta.versions.length >= this.opts.keep) {
      const drop = meta.versions.slice(0, meta.versions.length - this.opts.keep + 1);
      for (const v of drop) await fs.rm(path.join(d, path.basename(v.file)), { force: true });
      meta = { ...meta, versions: meta.versions.slice(drop.length) };
    } else if (meta.versions.length >= MAX_VERSIONS) throw new ArtifactError(`artifact ${meta.id} has ${MAX_VERSIONS} versions, the most it keeps; create a new artifact`, 409);
    const n = meta.version + 1;
    const file = `v${n}.${kindFile(meta.kind, meta.language).ext}`;
    // 'wx': never through a link, never over a file already there.
    await fs.writeFile(path.join(d, file), data, { flag: 'wx' });
    const now = Date.now();
    const next: ArtifactMeta = { ...meta, version: n, updatedAt: now, versions: [...meta.versions, { n, at: now, size: data.length, action, file }] };
    await writeFileAtomic(path.join(d, 'meta.json'), JSON.stringify(next, null, 1));
    return next;
  }

  async create(a: { title: string; kind: ArtifactKind; content: string | Buffer; language?: string; id?: string }): Promise<ArtifactMeta> {
    const title = a.title.replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!title) throw new ArtifactError('title is required');
    if (!(ARTIFACT_KINDS as readonly string[]).includes(a.kind)) throw new ArtifactError(`kind is one of ${ARTIFACT_KINDS.join(', ')}`);
    const language = a.language ? a.language.toLowerCase().replace(/[^a-z0-9+#.-]/g, '').slice(0, 30) || undefined : undefined;
    const data = Buffer.isBuffer(a.content) ? encodeBuffer(a.kind, a.content, language) : encode(a.kind, a.content, language);
    if ((await this.list()).length >= MAX_ARTIFACTS) throw new ArtifactError(`this session already has ${MAX_ARTIFACTS} artifacts`, 409);
    const id = a.id && ID.test(a.id) ? a.id : `${slug(title)}-${crypto.randomBytes(2).toString('hex')}`;
    const d = (await this.dir(id, true))!;
    return withFileLock(path.join(d, 'meta.json'), async () => {
      if (await this.meta(id)) throw new ArtifactError(`artifact ${id} exists`, 409);
      const now = Date.now();
      const meta: ArtifactMeta = { id, title, kind: a.kind, ...(language ? { language } : {}), contentType: kindFile(a.kind, language).type, version: 0, versions: [], createdAt: now, updatedAt: now };
      return this.write(d, meta, data, 'create');
    });
  }

  /** A find/replace edit of the latest version (text kinds), as a new version. */
  async update(id: string, e: { old_string: string; new_string: string; replace_all?: boolean; title?: string }): Promise<{ meta: ArtifactMeta; count: number }> {
    const d = await this.dir(id, false);
    if (!d) throw new ArtifactError(`no artifact "${id}"`, 404);
    return withFileLock(path.join(d, 'meta.json'), async () => {
      const cur = await this.get(id);
      if (BINARY.has(cur.meta.kind)) throw new ArtifactError(`a ${cur.meta.kind} artifact is changed with rewrite`);
      const before = cur.data.toString('utf8');
      if (!e.old_string) throw new ArtifactError('old_string is empty: include the text to replace (rewrite replaces the whole content)');
      if (e.old_string === e.new_string) throw new ArtifactError('old_string and new_string are identical; nothing to change');
      const count = before.split(e.old_string).length - 1;
      if (!count) throw new ArtifactError(`old_string was not found in ${id} v${cur.meta.version}; get it and copy the text exactly`);
      if (count > 1 && !e.replace_all) throw new ArtifactError(`old_string occurs ${count} times; add surrounding text to make it unique, or set replace_all`);
      const after = e.replace_all ? before.split(e.old_string).join(e.new_string) : before.replace(e.old_string, () => e.new_string);
      const meta = e.title?.trim() ? { ...cur.meta, title: e.title.trim().slice(0, 120) } : cur.meta;
      return { meta: await this.write(d, meta, encode(meta.kind, after, meta.language), 'update'), count };
    });
  }

  async rewrite(id: string, content: string | Buffer, title?: string): Promise<ArtifactMeta> {
    const d = await this.dir(id, false);
    if (!d) throw new ArtifactError(`no artifact "${id}"`, 404);
    return withFileLock(path.join(d, 'meta.json'), async () => {
      const cur = await this.meta(id);
      if (!cur) throw new ArtifactError(`no artifact "${id}"`, 404);
      const meta = title?.trim() ? { ...cur, title: title.trim().slice(0, 120) } : cur;
      return this.write(d, meta, Buffer.isBuffer(content) ? encodeBuffer(meta.kind, content, meta.language) : encode(meta.kind, content, meta.language), 'rewrite');
    });
  }
}

function encodeBuffer(kind: ArtifactKind, b: Buffer, language?: string): Buffer {
  return BINARY.has(kind) ? encode(kind, b.toString('base64'), language) : encode(kind, b.toString('utf8'), language);
}

/** What the artifact tool reaches: the session's store, with events and permission already decided. */
export interface ArtifactService {
  create(a: { title: string; kind: ArtifactKind; content?: string; path?: string; language?: string }): Promise<ArtifactMeta>;
  update(id: string, e: { old_string: string; new_string: string; replace_all?: boolean; title?: string }): Promise<{ meta: ArtifactMeta; count: number }>;
  rewrite(id: string, a: { content?: string; path?: string; title?: string }): Promise<ArtifactMeta>;
  get(id: string, version?: number): Promise<{ meta: ArtifactMeta; v: ArtifactVersion; data: Buffer }>;
  list(): Promise<ArtifactMeta[]>;
}

const line = (m: ArtifactMeta) => `${m.id} v${m.version} ${m.kind}${m.language ? `/${m.language}` : ''}: ${m.title}`;

export const artifactTool: Tool = {
  kind: 'edit', parallelSafe: false, remoteable: false,
  kindsFor: (i) => (['get', 'list'].includes(str(i.action)) ? ['read'] : ['edit']),
  sendsOut: false,
  spec: {
    name: 'artifact',
    description: 'Versioned artifacts the person keeps (docs, apps, diagrams, data). create {title, kind, content, language?}; update {id, old_string, new_string, replace_all?}: an exact find/replace like edit; rewrite {id, content}; get {id, version?}; list. image/pdf content: base64, or path to a workspace file.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'rewrite', 'get', 'list'] },
        id: { type: 'string' },
        title: { type: 'string' },
        kind: { type: 'string', enum: [...ARTIFACT_KINDS] },
        content: { type: 'string' },
        language: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' },
        version: { type: 'number' },
        path: { type: 'string' },
      },
      required: ['action'],
    },
  },
  summarize: (i) => `artifact ${str(i.action)} ${str(i.id) || str(i.title)}`.trim(),
  async run(input, ctx) {
    const svc = ctx.services?.artifacts;
    if (!svc) return { content: 'Artifacts are not available here.', is_error: true };
    const action = str(input.action);
    try {
      if (action === 'list') {
        const all = await svc.list();
        return { content: all.length ? all.map(line).join('\n') : 'No artifacts in this session yet.' };
      }
      if (action === 'get') {
        const r = await svc.get(str(input.id), num(input.version));
        const body = r.meta.kind === 'image' || r.meta.kind === 'pdf' ? `(${r.v.size} bytes of ${r.meta.contentType})` : clip(r.data.toString('utf8'), 30_000, 'the rest is in the file');
        return { content: `${line({ ...r.meta, version: r.v.n })}\n${body}` };
      }
      if (action === 'create') {
        if (input.content === undefined && !str(input.path)) return { content: 'create needs content (or path for image/pdf)', is_error: true };
        const m = await svc.create({ title: str(input.title), kind: str(input.kind) as ArtifactKind, content: typeof input.content === 'string' ? input.content : undefined, path: str(input.path) || undefined, language: str(input.language) || undefined });
        return { content: `Created artifact ${line(m)}` };
      }
      if (action === 'update') {
        const r = await svc.update(str(input.id), { old_string: str(input.old_string), new_string: str(input.new_string), replace_all: bool(input.replace_all), title: str(input.title) || undefined });
        return { content: `Updated ${line(r.meta)}${r.count > 1 ? ` (${r.count} replacements)` : ''}` };
      }
      if (action === 'rewrite') {
        if (input.content === undefined && !str(input.path)) return { content: 'rewrite needs content (or path for image/pdf)', is_error: true };
        const m = await svc.rewrite(str(input.id), { content: typeof input.content === 'string' ? input.content : undefined, path: str(input.path) || undefined, title: str(input.title) || undefined });
        return { content: `Rewrote ${line(m)}` };
      }
      return { content: 'action is create, update, rewrite, get or list', is_error: true };
    } catch (e) {
      return { content: (e as Error).message, is_error: true };
    }
  },
};
