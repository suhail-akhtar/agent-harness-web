import fs from 'node:fs/promises';
import path from 'node:path';
import type { ToolHost } from '../runtime/host.ts';
import type { Tool } from '../tools/types.ts';
import { str } from '../tools/types.ts';
import { within } from '../tools/paths.ts';
import { switchedOff } from '../kernel/registry.ts';
import { parseFrontmatter } from '../util/frontmatter.ts';
import { fileURLToPath } from 'node:url';
import { readManifest, SCRIPT_KINDS, skillFiles } from './package.ts';
import { bashTool } from '../tools/exec.ts';
import type { ToolContext } from '../tools/types.ts';

/**
 * A skill's command, run as the agent's bash would run it. An agent may be given a skill's scripts without bash: then
 * the command runs through the bash tool itself on the same host (and sandbox), under the calling tool's permission.
 */
export async function skillShell(ctx: ToolContext, input: Record<string, unknown>): Promise<{ content: string; is_error?: boolean }> {
  if (ctx.callTool && (ctx.toolNames?.() ?? []).includes('bash')) return ctx.callTool('bash', input);
  const r = await bashTool.run(input, ctx);
  return { content: r.content, ...(r.is_error ? { is_error: true } : {}) };
}

// Skills are folders of instructions (SKILL.md + any files it references) that
// the agent loads only when a task needs them: the context carries one line per
// skill until then. That is how the harness gains domain know-how (a stack, a
// file format, a company's conventions) without paying for it on every request.

export interface Skill {
  name: string;
  description: string;
  source: string;
  /** A plugin's guide (src/plugins/guides.ts): the plugin it guides. Listed in the client block, not in <skills>. */
  guide?: string;
  /** Returns SKILL.md's body, or another file in the skill's folder. */
  load(file?: string): Promise<string>;
  files(): Promise<string[]>;
  /** Its folder on this server (absent for a skill read through a companion). */
  dir?: string;
}

const MAX_FILE = 100_000;

async function fromDir(dir: string, source: string): Promise<Skill | undefined> {
  let text: string;
  try { text = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8'); } catch { return undefined; }
  const { data, body } = parseFrontmatter(text);
  const name = String(data.name ?? path.basename(dir)).trim();
  const description = String(data.description ?? '').trim();
  if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(name) || !description) return undefined;
  const real = await fs.realpath(dir);
  return {
    name, description: description.slice(0, 400), source, dir: real,
    async load(file) {
      if (!file || file === 'SKILL.md') return body;
      const target = await fs.realpath(path.resolve(real, file)).catch(() => '');
      if (!target || !within(real, target)) throw new Error(`${file} is not a file of skill ${name}`);
      const st = await fs.stat(target);
      if (st.size > MAX_FILE) throw new Error(`${file} is too large to load (${st.size} bytes); read it in parts with the read tool if it is in the workspace`);
      return fs.readFile(target, 'utf8');
    },
    async files() {
      const out: string[] = [];
      const walk = async (d: string, rel: string) => {
        for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
          if (e.name.startsWith('.')) continue;
          if (e.isDirectory()) await walk(path.join(d, e.name), `${rel}${e.name}/`);
          else if (e.isFile() && !(rel === '' && e.name === 'SKILL.md')) out.push(rel + e.name);
          if (out.length > 200) return;
        }
      };
      await walk(real, '');
      return out;
    },
  };
}

/** All skills under a directory of skill folders. */
export async function skillsIn(root: string, source: string): Promise<Skill[]> {
  let names: string[];
  try { names = await fs.readdir(root); } catch { return []; }
  const out: Skill[] = [];
  for (const n of names.sort()) {
    const s = await fromDir(path.join(root, n), source);
    if (s) out.push(s);
  }
  return out;
}

/** Skills that live in the workspace on a companion (the user's machine), read through it. */
async function companionSkills(host: ToolHost, rootRel: string, source: string): Promise<Skill[]> {
  const g = await host.remoteTool!('glob', { pattern: `${rootRel}/*/SKILL.md` }, AbortSignal.timeout(15_000)).catch(() => undefined);
  if (!g || g.is_error || /^No files/.test(g.content)) return [];
  const out: Skill[] = [];
  for (const p of g.content.split('\n').filter((l) => l.endsWith('SKILL.md')).slice(0, 50)) {
    const dir = p.slice(0, -'/SKILL.md'.length);
    const read = async (rel: string) => {
      const r = await host.remoteTool!('read', { path: `${dir}/${rel}` }, AbortSignal.timeout(15_000));
      if (r.is_error) throw new Error(r.content);
      return r.content.split('\n').filter((l) => !l.startsWith('[lines ')).map((l) => l.replace(/^ *\d+\t/, '')).join('\n');
    };
    const { data, body } = parseFrontmatter(await read('SKILL.md').catch(() => ''));
    const name = String(data.name ?? dir.split('/').pop()).trim();
    const description = String(data.description ?? '').trim();
    if (!name || !description) continue;
    out.push({
      name, description: description.slice(0, 400), source,
      load: async (file) => (!file || file === 'SKILL.md' ? body : file.includes('..') ? Promise.reject(new Error('invalid path')) : read(file)),
      files: async () => {
        const r = await host.remoteTool!('glob', { pattern: `${dir}/**/*` }, AbortSignal.timeout(15_000));
        return r.is_error ? [] : r.content.split('\n').filter((l) => l.startsWith(dir) && !l.endsWith('/SKILL.md')).map((l) => l.slice(dir.length + 1));
      },
    });
  }
  return out;
}

/** Skills that come with the harness for what a client app renders: a skill here is listed only when the app declares its renderer. */
const CLIENT_SKILLS: Record<string, string> = { diagrams: 'diagram' };
const CLIENT_SKILLS_DIR = fileURLToPath(new URL('./client', import.meta.url));

export async function clientSkills(renderers: readonly string[]): Promise<Skill[]> {
  const wanted = Object.entries(CLIENT_SKILLS).filter(([, r]) => renderers.includes(r)).map(([n]) => n);
  if (!wanted.length) return [];
  return (await skillsIn(CLIENT_SKILLS_DIR, 'harness')).filter((s) => wanted.includes(s.name));
}

/** Workspace skills: .harness/skills and .claude/skills (Claude Code's location). */
export async function workspaceSkills(host: ToolHost): Promise<Skill[]> {
  const out: Skill[] = [];
  for (const rel of ['.harness/skills', '.claude/skills']) {
    out.push(...(host.remoteTool ? await companionSkills(host, rel, 'project') : await skillsIn(path.join(host.root, rel), 'project')));
  }
  return out;
}

export function skillsListing(skills: Skill[]): string {
  // Plugin guides are listed in the client block of the system prompt (one line per plugin), not here.
  const listed = skills.filter((s) => !s.guide);
  if (!listed.length) return '';
  return `<skills>\nSkills hold instructions for particular kinds of work. When a task matches one, load it with the skill tool before starting.\n${listed.map((s) => `- ${s.name}: ${s.description}`).join('\n')}\n</skills>`;
}

/** What follows a loaded skill: its scripts (to run with skill_script), what it uses, its other files. */
async function skillNotes(s: Skill, files: string[]): Promise<string> {
  const m = s.dir ? await readManifest(s.dir).catch(() => undefined) : undefined;
  const scripts = m?.scripts ?? [];
  const rest = files.filter((f) => !scripts.includes(f));
  return [
    scripts.length ? `\nScripts of this skill: run them with skill_script (skill "${s.name}", the script, its args): ${scripts.join(', ')}. They do the exact work; read a script with file=... only to see its options.` : '',
    m?.tools.length ? `\nIt uses the tools: ${m.tools.join(', ')}.` : '',
    m?.mcpServers.length ? `\nIt uses the MCP servers: ${m.mcpServers.join(', ')}.` : '',
    rest.length ? `\nFiles in this skill (load with file=...): ${rest.join(', ')}` : '',
  ].join('');
}

/**
 * Runs a script of a skill (scripts/ or tests/) where this session runs commands: the skill's folder is put into the
 * workspace (.harness/skills-run/<name>/, refreshed each time) and the script runs from the workspace, with the
 * interpreter its extension names, through the bash tool (so it is asked about, sandboxed and recorded like any
 * command). SKILL_DIR names the skill's folder there.
 */
export function makeSkillScriptTool(skills: Skill[]): Tool {
  const byName = new Map(skills.filter((s) => s.dir).map((s) => [s.name, s]));
  return {
    kind: 'exec', parallelSafe: false, remoteable: false, deferGroup: 'skills',
    spec: {
      name: 'skill_script',
      description: 'Run a script of a skill (scripts/ or tests/, e.g. scripts/convert.py) on the workspace, as the skill says. args go to it as they are; paths are relative to the workspace.',
      input_schema: {
        type: 'object',
        properties: {
          skill: { type: 'string', enum: [...byName.keys()] },
          script: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } },
          timeout_ms: { type: 'number' },
        },
        required: ['skill', 'script'],
      },
    },
    summarize: (i) => `${str(i.skill)}: ${str(i.script)} ${Array.isArray(i.args) ? i.args.join(' ') : ''}`.trim(),
    async run(input, ctx) {
      const s = byName.get(str(input.skill));
      if (!s?.dir) return { content: `No skill named "${str(input.skill)}" with scripts here.`, is_error: true };
      const rel = str(input.script).replace(/\\/g, '/');
      const kind = SCRIPT_KINDS[path.extname(rel)];
      if (!/^(scripts|tests)\/[^]+$/.test(rel) || rel.includes('..') || !kind) return { content: `${rel}: a script in scripts/ or tests/ of the skill (.py, .mjs, .js, .cjs, .ts, .sh, .ps1).`, is_error: true };
      const files = await skillFiles(s.dir);
      if (!files.includes(rel)) return { content: `${rel} is not in the skill ${s.name}: ${files.filter((f) => /^(scripts|tests)\//.test(f)).join(', ') || 'it has no scripts'}`, is_error: true };
      // The skill's folder where the session runs commands.
      const at = `.harness/skills-run/${s.name}`;
      for (const f of files) {
        const data = await fs.readFile(path.join(s.dir, ...f.split('/')));
        if (ctx.host.kind === 'companion') { if (!ctx.host.pushFile) return { content: 'This computer cannot receive the skill\'s files.', is_error: true }; await ctx.host.pushFile(`${at}/${f}`, data, ctx.signal); continue; }
        const real = path.join(ctx.host.root, ...at.split('/'), ...f.split('/'));
        await fs.mkdir(path.dirname(real), { recursive: true });
        await fs.writeFile(real, data);
      }
      const q = (x: string) => `'${x.replace(/'/g, `'\\''`)}'`;
      const args = (Array.isArray(input.args) ? input.args : []).map((a) => q(String(a))).join(' ');
      // The first interpreter of its kind this host has (python3, else python).
      const run = kind.run.length > 1 && kind.run[0] === 'python3' ? `"$(command -v python3 || command -v python)"` : kind.run.map(q).join(' ');
      const command = `SKILL_DIR=${q(at)} ${run} ${q(`${at}/${rel}`)} ${args}`.trim();
      const r = await skillShell(ctx, { command, ...(input.timeout_ms ? { timeout_ms: Number(input.timeout_ms) } : {}), description: `${s.name}: ${rel}` });
      return { content: r.content, ...(r.is_error ? { is_error: true } : {}) };
    },
  };
}

export function makeSkillTool(skills: Skill[]): Tool {
  const byName = new Map(skills.map((s) => [s.name, s]));
  return {
    kind: 'read', parallelSafe: true, remoteable: false,
    spec: {
      name: 'skill',
      description: 'Load a skill\'s instructions (listed in <skills>), or one of the files it references with `file`.',
      input_schema: {
        type: 'object',
        properties: { name: { type: 'string', enum: skills.map((s) => s.name) }, file: { type: 'string', description: 'A file inside the skill folder; omit for SKILL.md.' } },
        required: ['name'],
      },
    },
    summarize: (i) => `skill ${str(i.name)}${i.file ? `/${str(i.file)}` : ''}`,
    async run(input) {
      const s = byName.get(str(input.name));
      if (!s) return { content: `No skill named "${str(input.name)}". Available: ${[...byName.keys()].join(', ')}`, is_error: true };
      // A switched-off plugin's skill stays listed (the cached prefix is unchanged) and is not loaded.
      const off = switchedOff(s, `the ${s.name} skill`);
      if (off) return { content: off, is_error: true };
      const text = await s.load(str(input.file) || undefined);
      if (input.file) return { content: text.length > MAX_FILE ? text.slice(0, MAX_FILE) + '\n[truncated]' : text };
      const files = await s.files();
      return { content: `<skill name="${s.name}">\n${text}\n</skill>${await skillNotes(s, files)}` };
    },
  };
}
