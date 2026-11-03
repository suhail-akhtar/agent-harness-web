// Making skills (the skill-creator skill's tools): an agent builds a skill folder in the workspace, check_skill checks
// it (its frontmatter, the files it points to, its scripts' syntax, and its tests, run where the session runs
// commands), and save_skill keeps it in the person's library, checked again, for every conversation and agent of theirs.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveIn } from '../tools/paths.ts';
import type { Tool, ToolContext } from '../tools/types.ts';
import { str } from '../tools/types.ts';
import { checkSkillDir, type CheckReport, SCRIPT_KINDS, skillFiles } from './package.ts';
import { skillShell } from './skills.ts';

/** The harness's own skills (the skill-creator): listed in every conversation, after the person's and the project's. */
export const BUILTIN_SKILLS_DIR = fileURLToPath(new URL('./builtin', import.meta.url));

const q = (x: string) => `'${x.replace(/'/g, `'\\''`)}'`;

/** A skill folder in the workspace, checked: the files, then its tests run (each must exit 0). */
async function checkInWorkspace(rel: string, ctx: ToolContext): Promise<{ report: CheckReport; tests: { file: string; ok: boolean; out: string }[]; dir?: string }> {
  if (ctx.host.kind === 'companion') return { report: { ok: false, problems: ['skills are checked and kept from a folder on the server: copy it here first (copy_file)'], warnings: [] }, tests: [] };
  const dir = await resolveIn(ctx.host, rel);
  const report = await checkSkillDir(dir);
  const tests: { file: string; ok: boolean; out: string }[] = [];
  if (report.ok && report.manifest?.tests.length) {
    for (const t of report.manifest.tests) {
      const kind = SCRIPT_KINDS[path.extname(t)]!;
      const run = kind.run[0] === 'python3' ? '"$(command -v python3 || command -v python)"' : kind.run.map(q).join(' ');
      const r = await skillShell(ctx, { command: `SKILL_DIR=${q(rel)} ${run} ${q(`${rel}/${t}`)}`, timeout_ms: 120_000, description: `test ${t}` });
      tests.push({ file: t, ok: !r.is_error && !/exit code [1-9]|Exit code [1-9]|\[exit [1-9]/.test(r.content), out: r.content.slice(-800) });
    }
  }
  return { report, tests, dir };
}

const show = (c: Awaited<ReturnType<typeof checkInWorkspace>>) => {
  const m = c.report.manifest;
  return [
    c.report.ok && c.tests.every((t) => t.ok) ? 'The skill passes.' : 'The skill does not pass yet.',
    ...(m ? [`${m.name}: ${m.scripts.length} script(s), ${m.references.length} reference(s), ${m.assets.length} asset(s), ${m.tests.length} test(s)${m.tools.length ? `; uses tools ${m.tools.join(', ')}` : ''}${m.mcpServers.length ? `; MCP servers ${m.mcpServers.join(', ')}` : ''}.`] : []),
    ...c.report.problems.map((p) => `PROBLEM: ${p}`),
    ...c.tests.map((t) => `${t.ok ? 'PASS' : 'FAIL'} ${t.file}${t.ok ? '' : `\n${t.out}`}`),
    ...c.report.warnings.map((w) => `note: ${w}`),
  ].join('\n');
};

export function skillBuilderTools(): Tool[] {
  const check: Tool = {
    kind: 'exec', parallelSafe: false, remoteable: false, deferGroup: 'skills',
    spec: {
      name: 'check_skill',
      description: 'Check a skill folder (e.g. skills/<name>): SKILL.md, the files it names, the syntax of its scripts, mcp.json; then run its tests (each must exit 0). Fix what it lists before save_skill.',
      input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
    summarize: (i) => `check the skill in ${str(i.path)}`,
    async run(input, ctx) {
      const c = await checkInWorkspace(str(input.path), ctx);
      return { content: show(c), is_error: !(c.report.ok && c.tests.every((t) => t.ok)) };
    },
  };
  const save: Tool = {
    kind: 'edit', parallelSafe: false, remoteable: false, deferGroup: 'skills',
    persists: () => true,
    spec: {
      name: 'save_skill',
      description: 'Keep a skill folder in the person\'s skill library (checked and tested first), for all their conversations and agents. replace: true replaces one of the same name.',
      input_schema: { type: 'object', properties: { path: { type: 'string' }, replace: { type: 'boolean' } }, required: ['path'] },
    },
    summarize: (i) => `save the skill in ${str(i.path)}`,
    async run(input, ctx) {
      if (!ctx.services?.skills) return { content: 'Skills cannot be kept here.', is_error: true };
      const c = await checkInWorkspace(str(input.path), ctx);
      if (!c.report.ok || !c.tests.every((t) => t.ok) || !c.dir) return { content: `Not saved.\n${show(c)}`, is_error: true };
      const files = new Map<string, Buffer>();
      for (const f of await skillFiles(c.dir)) files.set(f, await fs.readFile(path.join(c.dir, ...f.split('/'))));
      const r = await ctx.services.skills.put({ name: c.report.manifest!.name, files }, input.replace === true);
      if (!r.ok) return { content: `Not saved: ${r.problems.join('; ')}`, is_error: true };
      return { content: `Saved "${c.report.manifest!.name}" to your skills: it is in your conversations from the next one on, and you can give it to your agents (their skills).\n${show(c)}` };
    },
  };
  return [check, save];
}
