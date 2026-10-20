// An example trusted plugin. Load it with HARNESS_PLUGINS=examples/plugins.
// Everything a built-in can do goes through the same calls. No imports from
// the harness: the plugin works wherever it is installed.

export default {
  name: 'acme',
  setup(api) {
    // A tool the model can call. kind decides permissions: 'read' runs freely.
    api.registerTool({
      name: 'acme_word_count',
      description: 'Count the words in a text. Use it instead of counting yourself.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      kind: 'read',
      parallelSafe: true,
      run: async ({ text }) => `${String(text).trim().split(/\s+/).filter(Boolean).length} words`,
    });

    // A quality gate: proves something about the work (used by verification workflows).
    api.registerGate({
      name: 'acme-no-todo',
      description: 'No TODO markers left in source files.',
      async run({ host, signal }) {
        const r = await host.exec("grep -rIn --exclude-dir=node_modules --exclude-dir=.git 'TODO' . | head -20", { timeoutMs: 30_000, signal });
        const found = r.stdout.trim();
        return found ? { pass: false, summary: 'TODO markers found', details: found } : { pass: true, summary: 'no TODO markers' };
      },
    });

    // An in-process policy hook: block force-pushes, whatever the mode.
    api.on('PreToolUse', ({ input }) => {
      const cmd = String(input?.command ?? '');
      if (/git\s+push\b.*(--force|-f\b)/.test(cmd)) return { block: true, feedback: 'ACME policy: force-push is not allowed. Push normally or open a PR.' };
      return undefined;
    }, 'bash');

    api.log('ready');
  },
};
