// Plugin development for agents: start a plugin from the template (plugin_new), run its tests
// (plugin_test) and review it deeply (plugin_review: manifest, tools, routes, pages, permissions, code,
// skills and its tests, each finding with what to do). With the build-a-plugin skill (the procedure and
// the whole SDK reference), an agent can build a complete plugin for the harness and the desktop app.
//
// plugin_test and plugin_review run the plugin's code, on the computer the harness runs on: only for a
// session working on this computer without a sandbox (a sandboxed session's files would otherwise run
// outside its sandbox). They are asked about like a command.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffold } from '../../src/plugins/scaffold.ts';
import { reviewInChild, formatReview } from '../../src/plugins/review.ts';
import { runPluginTests } from '../../src/plugins/run-tests.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const UNSANDBOXED_ONLY = 'This runs the plugin\'s code on the computer the harness runs on, so it is only for a session that works on this computer without a sandbox (this one runs in a sandbox or on another computer). Ask the person to review it from the desktop app (Plugins > Developer > Load a plugin folder, which reviews it), or to run `npm run plugin -- check <folder> --deep` in the harness checkout.';
const runsHere = (host) => host.kind === 'local' && !host.sandboxed;

export default {
  name: 'plugin-dev',
  setup(api) {
    api.registerTool({
      name: 'plugin_new',
      description: 'Start a new harness plugin from the template: a complete, working plugin (tools, versioned data, routes, a skill, a guide for agents, a desktop page built on the UI kit, and tests) in a new folder of the workspace, to change into the plugin the person wants. Use it first when asked to build a plugin; then load the build-a-plugin skill and change the files.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The plugin\'s name: lowercase letters, digits and dashes, starting with a letter (e.g. "habit-tracker")' },
          folder: { type: 'string', description: 'Where to write it, relative to the workspace (default plugins/<name>); it must not exist or be empty' },
          language: { type: 'string', enum: ['typescript', 'javascript'], description: 'TypeScript (default) or plain JavaScript with JSDoc types' },
        },
        required: ['name'],
      },
      kind: 'edit',
      sendsOut: false,
      summarize: (i) => `new plugin ${i.name}`,
      async run(input, ctx) {
        const name = String(input.name ?? '');
        const rel = String(input.folder || `plugins/${name}`);
        let dir;
        try { dir = await api.workspacePath(ctx.host, rel); } catch (e) { return { content: `${rel}: ${e.message}`, is_error: true }; }
        if (ctx.host.kind === 'companion') return { content: 'plugin_new writes files on the server; this session works on another computer. Write the files with the file tools instead (the build-a-plugin skill has the template).', is_error: true };
        try {
          const files = await scaffold(dir, name, { js: input.language === 'javascript', repoRoot });
          return [
            `Wrote ${files.length} files in ${rel}:`, ...files.map((f) => `  ${f}`), '',
            'Next: load the build-a-plugin skill (it has the procedure and the whole SDK), change the template into the plugin asked for, then plugin_test and plugin_review until the review says OK.',
          ].join('\n');
        } catch (e) { return { content: e.message, is_error: true }; }
      },
    });

    api.registerTool({
      name: 'plugin_test',
      description: 'Run a plugin\'s own tests (test/**/*.test.ts|mjs|js, on the test kit) and return the result. Use after changing a plugin, before plugin_review. Runs the plugin\'s code on this computer.',
      parameters: { type: 'object', properties: { folder: { type: 'string', description: 'The plugin folder, relative to the workspace (the one with harness-plugin.json)' } }, required: ['folder'] },
      kind: 'exec',
      sendsOut: false,
      summarize: (i) => `test plugin ${i.folder}`,
      async run(input, ctx) {
        if (!runsHere(ctx.host)) return { content: UNSANDBOXED_ONLY, is_error: true };
        let dir;
        try { dir = await api.workspacePath(ctx.host, String(input.folder)); } catch (e) { return { content: e.message, is_error: true }; }
        if (!(await fs.stat(path.join(dir, 'harness-plugin.json')).catch(() => null))) return { content: `${input.folder} has no harness-plugin.json.`, is_error: true };
        const r = await runPluginTests(dir, [], { capture: true, timeoutMs: 5 * 60_000 });
        const lines = r.output.split('\n').filter((l) => !/^\s+at /.test(l) && !/^\s*(duration_ms|type|location|failureType|exitCode|signal|code|stack):/.test(l));
        const summary = lines.filter((l) => /^# (tests|pass|fail)/.test(l)).join(', ');
        const failing = lines.filter((l) => /^not ok/.test(l));
        const body = r.code === 0 ? `PASS ${summary}` : `FAIL ${summary}\n${failing.join('\n')}\n\n${lines.slice(-60).join('\n')}`;
        return { content: body.slice(0, 12_000), ...(r.code === 0 ? {} : { is_error: true }) };
      },
    });

    api.registerTool({
      name: 'plugin_review',
      description: 'Review a plugin deeply before anyone uses it: loads it into a throwaway harness, calls its read tools and routes, checks its manifest, tool descriptions and schemas, pages (SDK calls vs capabilities, routes they call, theme), permissions declared vs used, code that reaches past the api (processes, environment), secrets in files, skills, and runs its tests. Returns OK / NOT READY, a score and each finding with what to do. Use when a plugin is written or changed; fix every error and the warnings you can, then review again.',
      parameters: {
        type: 'object',
        properties: {
          folder: { type: 'string', description: 'The plugin folder, relative to the workspace' },
          tests: { type: 'boolean', description: 'Also run its tests (default true)' },
        },
        required: ['folder'],
      },
      kind: 'exec',
      sendsOut: false,
      summarize: (i) => `review plugin ${i.folder}`,
      async run(input, ctx) {
        if (!runsHere(ctx.host)) return { content: UNSANDBOXED_ONLY, is_error: true };
        let dir;
        try { dir = await api.workspacePath(ctx.host, String(input.folder)); } catch (e) { return { content: e.message, is_error: true }; }
        const r = await reviewInChild(dir, { runTests: input.tests !== false });
        return { content: formatReview(r).slice(0, 16_000), ...(r.ok ? {} : { is_error: false }) };
      },
    });
  },
};
