// Research pack: the tools and the gate that hold a report to its sources.
// The pages an agent read are kept by the harness (ctx.services.sources), not
// in the workspace, so a report cannot cite "sources" the agent wrote itself.

const REPORTS = ['research/report.md', 'report.md'];

async function readReport(api, host, rel) {
  const fs = await import('node:fs/promises');
  const real = await api.workspacePath(host, rel);
  return fs.readFile(real, 'utf8');
}

export default {
  name: 'research',
  setup(api) {
    api.registerTool({
      name: 'check_citations',
      description: 'Check a report\'s citations against the pages read in this session: every cited URL must have been fetched with web_fetch, every "quotation" must appear word for word in its source, and every figure in a cited sentence must appear in a source it cites (a computed figure goes in its own sentence ending "(derived: ...)"). Cite as [n] with a reference list of "[n]: URL" lines, or as inline Markdown links.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'The report, e.g. research/report.md' } }, required: ['path'] },
      kind: 'read', parallelSafe: true, untrusted: true,
      summarize: (i) => `check citations in ${i.path}`,
      async run(input, ctx) {
        const sources = ctx.services?.sources;
        if (!sources) return { content: 'Sources are not recorded in this session.', is_error: true };
        const text = await readReport(api, ctx.host, String(input.path ?? ''));
        const r = await sources.check(text);
        return { content: r.summary, is_error: r.issues.length > 0 };
      },
    });

    api.registerTool({
      name: 'sources',
      description: 'The pages read with web_fetch in this session (any agent\'s): "list" them, or "read" one by URL without fetching it again.',
      parameters: { type: 'object', properties: { command: { type: 'string', enum: ['list', 'read'], description: 'list the pages read in this session, or read one' }, url: { type: 'string', description: 'read: the URL of a page already read with web_fetch' }, offset: { type: 'number', description: 'read: the character to start at (default 0)' }, max_chars: { type: 'number', description: 'read: how many characters to return (default 20000, 1000 to 60000)' } }, required: ['command'] },
      kind: 'read', parallelSafe: true, untrusted: true,
      summarize: (i) => `sources ${i.command}${i.url ? ` ${i.url}` : ''}`,
      async run(input, ctx) {
        const sources = ctx.services?.sources;
        if (!sources) return { content: 'Sources are not recorded in this session.', is_error: true };
        if (input.command === 'list') {
          const all = await sources.list();
          if (!all.length) return 'No pages have been read in this session yet.';
          return all.map((s) => `- ${s.finalUrl}${s.title ? ` - ${s.title}` : ''} (${s.chars} chars, ${new Date(s.fetchedAt).toISOString().slice(0, 16)})`).join('\n');
        }
        const e = await sources.find(String(input.url ?? ''));
        if (!e) return { content: `${input.url} was not read in this session; fetch it with web_fetch.`, is_error: true };
        const text = await sources.text(e);
        const offset = Math.max(0, Math.floor(Number(input.offset) || 0));
        const max = Math.min(60_000, Math.max(1000, Math.floor(Number(input.max_chars) || 20_000)));
        const more = offset + max < text.length ? `\n[${text.length - offset - max} more characters; continue with offset=${offset + max}]` : '';
        return `<source url="${e.finalUrl}">\n${text.slice(offset, offset + max)}${more}\n</source>`;
      },
    });

    api.registerGate({
      name: 'citations',
      description: 'A research report cites only pages that were read, and its quotes and figures match them',
      async applies(host) {
        const fs = await import('node:fs/promises');
        for (const rel of REPORTS) {
          const real = await api.workspacePath(host, rel).catch(() => null);
          if (real && (await fs.stat(real).catch(() => null))?.isFile()) return true;
        }
        return false;
      },
      async run({ host, services }) {
        if (!services?.sources) return { pass: false, summary: 'sources are not recorded here, so citations cannot be checked' };
        const fs = await import('node:fs/promises');
        for (const rel of REPORTS) {
          const real = await api.workspacePath(host, rel).catch(() => null);
          if (!real || !(await fs.stat(real).catch(() => null))?.isFile()) continue;
          const r = await services.sources.check(await fs.readFile(real, 'utf8'));
          if (!r.citations) return { pass: false, summary: `${rel} cites no sources`, details: 'Cite every factual claim as [n], with a reference list of "[n]: URL" lines for pages you read with web_fetch.' };
          return r.issues.length
            ? { pass: false, summary: `${rel}: ${r.issues.length} citation problem(s)`, details: r.summary }
            : { pass: true, summary: `${rel}: ${r.citations} citation(s), ${r.sentencesChecked} cited sentence(s) match the pages read` };
        }
        return { pass: false, summary: 'no report found (research/report.md)' };
      },
    });
  },
};
