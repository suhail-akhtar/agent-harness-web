import fs from 'node:fs/promises';
import path from 'node:path';
import type { ToolHost } from '../runtime/host.ts';
import type { Tool } from '../tools/types.ts';
import { str } from '../tools/types.ts';
import { within } from '../tools/paths.ts';
import { parseFrontmatter } from '../util/frontmatter.ts';
import { fileURLToPath } from 'node:url';

// Skills are folders of instructions (SKILL.md + any files it references) that
// the agent loads only when a task needs them: the context carries one line per
// skill until then. That is how the harness gains domain know-how (a stack, a
// file format, a company's conventions) without paying for it on every request.

export interface Skill {
  name: string;
  description: string;
  source: string;
  /** Returns SKILL.md's body, or another file in the skill's folder. */
  load(file?: string): Promise<string>;
  files(): Promise<string[]>;
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
    name, description: description.slice(0, 400), source,
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
  if (!skills.length) return '';
  return `<skills>\nSkills hold instructions for particular kinds of work. When a task matches one, load it with the skill tool before starting.\n${skills.map((s) => `- ${s.name}: ${s.description}`).join('\n')}\n</skills>`;
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
      const text = await s.load(str(input.file) || undefined);
      if (input.file) return { content: text.length > MAX_FILE ? text.slice(0, MAX_FILE) + '\n[truncated]' : text };
      const files = await s.files();
      return { content: `<skill name="${s.name}">\n${text}\n</skill>${files.length ? `\nFiles in this skill (load with file=...): ${files.join(', ')}` : ''}` };
    },
  };
}
