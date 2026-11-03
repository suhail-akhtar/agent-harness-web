// Skill packages: what a skill is beyond its SKILL.md, how one is checked, imported and kept.
//
// A skill is a folder (the Anthropic Agent Skills layout, which Claude Code reads too):
//   SKILL.md      frontmatter (name, description; optional: version, license, allowed-tools, mcp-servers) + instructions
//   scripts/      code the agent runs with skill_script (Python, JavaScript or TypeScript, shell, PowerShell): the
//                 deterministic part of the work (parsing, converting, computing), so the model does not do it by hand
//   references/   documents the agent loads when it needs them (skill file=...)
//   assets/       templates and data the scripts or the agent use
//   tests/        self-tests of the scripts, run by check_skill
//   mcp.json      MCP servers the skill needs ({"mcpServers": {...}}, Claude Desktop's format): imported switched off
// A skill with only instructions is a fine skill: scripts are for what code does better than a model.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseFrontmatter } from '../util/frontmatter.ts';
import { readZip, writeZip, ZipError } from '../util/zip.ts';

export const SKILL_NAME = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;
export const SCRIPT_KINDS: Record<string, { run: string[]; check?: string[] }> = {
  '.py': { run: ['python3', 'python'], check: ['-m', 'py_compile'] },
  '.mjs': { run: ['node'], check: ['--check'] },
  '.js': { run: ['node'], check: ['--check'] },
  '.cjs': { run: ['node'], check: ['--check'] },
  '.ts': { run: ['node'] },
  '.sh': { run: ['bash'], check: ['-n'] },
  '.ps1': { run: ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File'] },
};
const MAX_FILE = 5 * 1024 * 1024;
const MAX_TOTAL = 20 * 1024 * 1024;

export interface SkillManifest {
  name: string; description: string; version?: string; license?: string;
  /** Tools the skill uses (allowed-tools): an agent given the skill gets them. */
  tools: string[];
  /** MCP servers it needs, by name (its own mcp.json, or ones the person has). */
  mcpServers: string[];
  /** Its own MCP servers (mcp.json), by name. */
  mcp: Record<string, Record<string, unknown>>;
  scripts: string[]; references: string[]; assets: string[]; tests: string[];
  /** Lines of instructions in SKILL.md. */
  lines: number;
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(/[,\s]+/) : []).map((x) => x.trim()).filter(Boolean);

/** A skill folder's files (relative paths), walked. Symbolic links are refused: a skill is its own files. */
export async function skillFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, rel: string) => {
    for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (e.name === 'node_modules' || e.name === '__pycache__' || e.name === '.git') continue;
      if (e.isSymbolicLink()) throw new Error(`${rel}${e.name} is a symbolic link: a skill holds its own files`);
      if (e.isDirectory()) await walk(path.join(d, e.name), `${rel}${e.name}/`);
      else if (e.isFile()) out.push(`${rel}${e.name}`);
      if (out.length > 1000) throw new Error('more than 1000 files: too many for a skill');
    }
  };
  await walk(dir, '');
  return out.sort();
}

/** What a skill folder declares and holds. */
export async function readManifest(dir: string): Promise<SkillManifest> {
  const text = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8');
  const { data, body } = parseFrontmatter(text);
  const files = await skillFiles(dir);
  let mcp: Record<string, Record<string, unknown>> = {};
  if (files.includes('mcp.json')) {
    const j = JSON.parse(await fs.readFile(path.join(dir, 'mcp.json'), 'utf8')) as { mcpServers?: Record<string, Record<string, unknown>> };
    mcp = j.mcpServers && typeof j.mcpServers === 'object' ? j.mcpServers : {};
  }
  const under = (p: string) => files.filter((f) => f.startsWith(`${p}/`));
  return {
    name: String(data.name ?? path.basename(dir)).trim(),
    description: String(data.description ?? '').trim(),
    ...(data.version ? { version: String(data.version) } : {}),
    ...(data.license ? { license: String(data.license) } : {}),
    tools: [...new Set([...list(data['allowed-tools']), ...list(data.tools)])],
    mcpServers: [...new Set([...list(data['mcp-servers']), ...Object.keys(mcp)])],
    mcp,
    scripts: under('scripts').filter((f) => SCRIPT_KINDS[path.extname(f)]),
    references: under('references'), assets: under('assets'),
    tests: under('tests').filter((f) => SCRIPT_KINDS[path.extname(f)]),
    lines: body.split('\n').length,
  };
}

export interface CheckReport { ok: boolean; problems: string[]; warnings: string[]; manifest?: SkillManifest }

/**
 * A skill checked before it is used or kept: its frontmatter, the files its instructions point to, every script's
 * syntax (with the interpreters this machine has), its size, its MCP servers' shape. Running its tests is the
 * check_skill tool's (where the session runs commands); this is what can be decided from the files.
 */
export async function checkSkillDir(dir: string): Promise<CheckReport> {
  const problems: string[] = []; const warnings: string[] = [];
  let m: SkillManifest;
  try { m = await readManifest(dir); } catch (e) { return { ok: false, problems: [`cannot read the skill: ${(e as Error).message}`], warnings }; }
  if (!SKILL_NAME.test(m.name)) problems.push(`name "${m.name}" must be letters, digits, "-", "_" or "." (at most 64), starting with a letter or digit`);
  if (m.name !== path.basename(dir)) warnings.push(`its folder is "${path.basename(dir)}" but its name is "${m.name}"`);
  if (m.description.length < 20) problems.push('description must say what the skill does and when to use it (at least 20 characters): it is all an agent sees before loading it');
  if (m.description.length > 1024) problems.push('description is longer than 1024 characters');
  if (m.lines > 500) warnings.push(`SKILL.md has ${m.lines} lines: keep it under 500 and move details to references/`);
  const files = await skillFiles(dir);
  let total = 0;
  for (const f of files) {
    const st = await fs.stat(path.join(dir, f));
    total += st.size;
    if (st.size > MAX_FILE) problems.push(`${f} is larger than ${MAX_FILE / 1048576} MB`);
  }
  if (total > MAX_TOTAL) problems.push(`the skill holds more than ${MAX_TOTAL / 1048576} MB`);
  // Files the instructions name: links and backticked paths into its own folders.
  const body = parseFrontmatter(await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8')).body;
  const named = new Set([...body.matchAll(/\]\(((?:scripts|references|assets|tests)\/[^)\s#]+)\)/g), ...body.matchAll(/`((?:scripts|references|assets|tests)\/[^`\s]+)`/g)].map((x) => x[1]!));
  for (const f of named) if (!files.includes(f)) problems.push(`SKILL.md points to ${f}, which is not in the skill`);
  for (const s of m.scripts) if (!named.has(s) && !body.includes(path.basename(s))) warnings.push(`${s} is never mentioned in SKILL.md: say when to run it, or the agent will not`);
  // Syntax, with what this machine has.
  for (const s of [...m.scripts, ...m.tests]) {
    const k = SCRIPT_KINDS[path.extname(s)]!;
    if (!k.check) continue;
    const bin = k.run.find((b) => spawnSync(b, ['--version'], { stdio: 'ignore', windowsHide: true }).status === 0);
    if (!bin) { warnings.push(`${s}: ${k.run[0]} is not installed here, its syntax was not checked`); continue; }
    const r = spawnSync(bin, [...k.check, path.join(dir, s)], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    if (r.status !== 0) problems.push(`${s} does not parse: ${String(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ').slice(0, 300)}`);
  }
  for (const [n, c] of Object.entries(m.mcp)) if (typeof c.command !== 'string' && typeof c.url !== 'string') problems.push(`mcp.json: server "${n}" needs a command or a url`);
  if (m.scripts.length && !m.tests.length) warnings.push('scripts without tests/: add a self-test so check_skill can show the scripts work');
  return { ok: !problems.length, problems, warnings, manifest: m };
}

/** One skill out of a package: its name (from its SKILL.md) and its files. */
export interface PackagedSkill { name: string; files: Map<string, Buffer> }

/**
 * The skills in what a person brings:
 * - a zip (an Anthropic .skill package, or any .zip): a skill at its root, in one folder, or several (a Claude Code
 *   plugin's skills/<name>/, or folders side by side), each found by its SKILL.md;
 * - a SKILL.md on its own (text with frontmatter).
 */
export function unpackSkills(data: Buffer): PackagedSkill[] {
  if (data.subarray(0, 2).toString('latin1') === 'PK') {
    let entries;
    try { entries = readZip(data); } catch (e) { throw e instanceof ZipError ? new Error(`the package: ${e.message}`) : e; }
    // macOS adds __MACOSX/ copies: never part of a skill.
    entries = entries.filter((e) => !e.name.startsWith('__MACOSX/') && !/(^|\/)\.DS_Store$/.test(e.name));
    const roots = entries.filter((e) => e.name === 'SKILL.md' || e.name.endsWith('/SKILL.md')).map((e) => e.name.slice(0, -'SKILL.md'.length));
    if (!roots.length) throw new Error('the package holds no SKILL.md');
    // A skill inside another one's folder is part of it (its references), not a skill of its own.
    const tops = roots.filter((r) => !roots.some((o) => o !== r && r.startsWith(o) && o.length < r.length)).sort();
    return tops.map((root) => {
      const files = new Map<string, Buffer>();
      for (const e of entries) if (e.name.startsWith(root)) files.set(e.name.slice(root.length), e.data);
      const { data: fm } = parseFrontmatter(files.get('SKILL.md')!.toString('utf8'));
      const name = String(fm.name ?? (root.replace(/\/$/, '').split('/').pop() || 'skill')).trim();
      return { name, files };
    });
  }
  const text = data.toString('utf8');
  if (!/^﻿?---\r?\n/.test(text)) throw new Error('not a skill: a .skill or .zip package, or a SKILL.md with frontmatter (name, description)');
  const { data: fm } = parseFrontmatter(text.replace(/^﻿/, ''));
  return [{ name: String(fm.name ?? '').trim(), files: new Map([['SKILL.md', Buffer.from(text.replace(/^﻿/, ''))]]) }];
}

/**
 * The person's own skills, kept on the server (<data>/skills/<owner>/<name>/): made by them or an agent (save_skill),
 * or imported. Each is checked before it is kept; one that does not pass is not kept.
 */
export class SkillStore {
  readonly dir: string;
  constructor(dataDir: string) { this.dir = path.join(dataDir, 'skills'); }
  root(owner: string | undefined): string { return path.join(this.dir, (owner ?? '_local').replace(/[^\w.-]/g, '_').slice(0, 80) || '_local'); }
  private skillDir(owner: string | undefined, name: string): string {
    if (!SKILL_NAME.test(name)) throw new Error(`"${name}" is not a skill name`);
    return path.join(this.root(owner), name);
  }

  async names(owner: string | undefined): Promise<string[]> {
    return (await fs.readdir(this.root(owner), { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort();
  }

  /** Writes a skill (replacing one of the same name only with `replace`), checked first in a staging folder. */
  async put(owner: string | undefined, s: PackagedSkill, o: { replace?: boolean } = {}): Promise<CheckReport> {
    const name = s.name;
    if (!SKILL_NAME.test(name)) return { ok: false, problems: [`"${name}" is not a skill name (letters, digits, "-", "_", "."; at most 64)`], warnings: [] };
    if (!s.files.has('SKILL.md')) return { ok: false, problems: ['no SKILL.md'], warnings: [] };
    const target = this.skillDir(owner, name);
    const exists = await fs.stat(target).then(() => true, () => false);
    if (exists && !o.replace) return { ok: false, problems: [`you have a skill named "${name}" already (replace it, or give this one another name)`], warnings: [] };
    const staging = path.join(this.root(owner), `.staging-${name}-${process.pid}-${Date.now()}`);
    try {
      for (const [rel, data] of s.files) {
        const clean = rel.replace(/\\/g, '/');
        if (!clean || clean.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(clean)) return { ok: false, problems: [`an unsafe path: ${clean}`], warnings: [] };
        const p = path.join(staging, ...clean.split('/'));
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, data);
      }
      const report = await checkSkillDir(staging).then((r) => ({ ...r, warnings: r.warnings.filter((w) => !/its folder is/.test(w)) }));
      if (!report.ok) return report;
      if (exists) await fs.rm(target, { recursive: true, force: true });
      await fs.rename(staging, target);
      return report;
    } finally { await fs.rm(staging, { recursive: true, force: true }).catch(() => {}); }
  }

  async remove(owner: string | undefined, name: string): Promise<boolean> {
    const d = this.skillDir(owner, name);
    if (!(await fs.stat(d).then(() => true, () => false))) return false;
    await fs.rm(d, { recursive: true, force: true });
    return true;
  }

  /** A kept skill as a .skill package (a zip with its folder), to share or to use elsewhere. */
  async exportZip(owner: string | undefined, name: string): Promise<Buffer> {
    const d = this.skillDir(owner, name);
    const files = await skillFiles(d);
    return writeZip(await Promise.all(files.map(async (f) => ({ name: `${name}/${f}`, data: await fs.readFile(path.join(d, ...f.split('/'))) }))));
  }
}
