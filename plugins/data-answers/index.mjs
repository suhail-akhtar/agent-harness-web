// Data answers: questions over the person's own database, answered so that every number can be traced and was
// recomputed independently (docs/swarm/SWARM.md, phase 2). The queries, their cells and the checks are the harness's
// (ctx.services.answers): cells live in the session's folder, where the agent cannot edit them.

const ANSWER = 'data/answer.md';

async function readFile(api, host, rel) {
  const fs = await import('node:fs/promises');
  return fs.readFile(await api.workspacePath(host, rel), 'utf8');
}
async function writeFile(api, host, rel, text) {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const real = await api.workspacePath(host, rel);
  await fs.mkdir(path.dirname(real), { recursive: true });
  await fs.writeFile(real, text);
}

/** The provenance rule over an answer file: a summary, and whether it holds. */
async function provenance(api, host, services, rel) {
  const text = await readFile(api, host, rel);
  const r = await services.answers.provenance(text);
  const cells = await services.answers.cells();
  if (!r.issues.length) return { pass: true, summary: `${rel}: ${r.numbers} number(s) in ${r.sentences} sentence(s), each from a query cell (${cells.size} cell(s) in this session)` };
  return { pass: false, summary: `${rel}: ${r.issues.length} number(s) without a source`, details: r.issues.map((i) => `- line ${i.line}: "${i.text}" ${i.problem}`).join('\n') };
}

/** A line of the answer file: "Question: ...", "Database: ...", "Interpretation: ...". */
const field = (text, name) => new RegExp(`^${name}:\\s*(.+)$`, 'im').exec(text)?.[1]?.trim();

/** The independent recomputation: an agent of another family, from the question and the definitions only. */
async function recompute(api, host, services, rel, signal) {
  const text = await readFile(api, host, rel);
  const question = field(text, 'Question'); const db = field(text, 'Database');
  if (!question || !db) return { pass: false, summary: `${rel} needs a "Question:" line and a "Database:" line at the top`, text: '' };
  const interpretation = field(text, 'Interpretation');
  let semantics = '';
  for (const s of [`${db.replace(/\.(db|sqlite3?)$/i, '')}.semantics.md`, `${db.includes('/') ? db.slice(0, db.lastIndexOf('/') + 1) : ''}semantics.md`]) {
    try { semantics = await readFile(api, host, s); break; } catch { /* next */ }
  }
  const brief = [
    `Answer this question from the database ${db}, on your own: find the tables with data_schema, query with sql_query, check what the checks say.`,
    '', '<question>', question, '</question>',
    ...(interpretation ? ['', `Read it this way: ${interpretation}`] : []),
    ...(semantics ? ['', '<definitions>', semantics.slice(0, 12_000), '</definitions>'] : []),
    '', 'Report the answer in a few lines, then end with exactly one line of JSON and nothing after it: {"figures": {"<short name>": <number>, ...}} with each figure the question asks for (as plain numbers: 1234.5, not "1,234.5" or "$1.2k"). If the data cannot answer it, end with {"figures": {}, "unanswerable": "<why>"}.',
  ].join('\n');
  const r = await services.crossAgent({ type: 'data-checker', prompt: brief, description: 'recompute the answer' }, signal);
  const cmp = services.answers.compare(text, r.report);
  const una = (t) => /"unanswerable"\s*:/.test(t.trim().split('\n').at(-1) ?? '');
  const bothUnanswerable = una(text) && una(r.report);
  const pass = bothUnanswerable || (!!cmp.a && Object.keys(cmp.a).length > 0 && !cmp.disagree.length && !cmp.unmatched.some((u) => !/only in the recomputation/.test(u)));
  const lines = [
    `Recomputed on ${r.model} from the question and the definitions alone (it never saw this answer's queries).`,
    bothUnanswerable ? 'Both say the data cannot answer it.' : '',
    !cmp.a ? `${rel} ends with no {"figures": ...} line: add one with the figures the answer gives.` : '',
    cmp.agree.length ? `Agree: ${cmp.agree.join('; ')}` : '',
    cmp.disagree.length ? `DISAGREE: ${cmp.disagree.join('; ')}` : '',
    cmp.unmatched.length ? `Unmatched: ${cmp.unmatched.join('; ')}` : '',
    '', 'The recomputation\'s report:', r.report.split('\n\n---\n')[0].slice(0, 3000),
  ].filter((l) => l !== '');
  const out = lines.join('\n');
  await writeFile(api, host, 'data/recompute.md', `# Recomputation of ${rel}\n\n${out}\n`);
  return { pass, summary: pass ? `${rel}: the figures agree with an independent recomputation on ${r.model}` : `${rel}: the figures do not agree with an independent recomputation on ${r.model}`, text: out };
}

export default {
  name: 'data-answers',
  setup(api) {
    api.registerTool({
      name: 'data_schema',
      description: 'The tables of a SQLite database file in the workspace, with their columns and row counts.',
      parameters: { type: 'object', properties: { db: { type: 'string', description: 'The database file, e.g. data/shop.db' } }, required: ['db'] },
      kind: 'read', parallelSafe: true,
      summarize: (i) => `schema of ${i.db}`,
      async run(input, ctx) {
        if (!ctx.services?.answers) return { content: 'Data answers are not available in this session.', is_error: true };
        try { return { content: await ctx.services.answers.schema(String(input.db ?? '')) }; } catch (e) { return { content: e.message, is_error: true }; }
      },
    });

    api.registerTool({
      name: 'sql_query',
      description: 'Run one read-only SELECT on a SQLite database file in the workspace. The result is kept as a query cell [qN] (cite it next to each number you take from it), and the database itself is checked for what commonly makes an answer wrong: a join that repeats rows, groups that repeat, a period the data does not cover. Read every CHECKS line.',
      parameters: { type: 'object', properties: { db: { type: 'string', description: 'The database file, e.g. data/shop.db' }, sql: { type: 'string', description: 'One SELECT (or WITH ... SELECT)' }, purpose: { type: 'string', description: 'What this query is for, in a few words' } }, required: ['db', 'sql'] },
      kind: 'read', parallelSafe: false,
      summarize: (i) => `query ${i.db}: ${String(i.sql ?? '').replace(/\s+/g, ' ').slice(0, 100)}`,
      async run(input, ctx) {
        if (!ctx.services?.answers) return { content: 'Data answers are not available in this session.', is_error: true };
        try {
          const c = await ctx.services.answers.query(String(input.db ?? ''), String(input.sql ?? ''), input.purpose ? String(input.purpose) : undefined);
          const cell = (v) => String(v ?? 'NULL').replace(/\|/g, '\\|').slice(0, 80);
          return { content: [`[${c.id}] ${c.count} row(s)${c.truncated ? ' (the cell keeps the first 500)' : ''}`, ...(c.checks.length ? ['CHECKS:', ...c.checks.map((x) => `- ${x}`)] : []), '', `| ${c.columns.join(' | ')} |`, `|${c.columns.map(() => '---').join('|')}|`, ...c.rows.slice(0, 40).map((r) => `| ${r.map(cell).join(' | ')} |`), ...(c.count > 40 ? [`(${c.count - 40} more rows in the cell)`] : []), '', `Cite it as [${c.id}] next to each number you take from it.`].join('\n') };
        } catch (e) { return { content: `Query refused or failed: ${e.message}`, is_error: true }; }
      },
    });

    api.registerTool({
      name: 'draft_semantics',
      description: 'Write a first semantics file for a database (its tables, and the definitions for the person to write or confirm), marked draft: the person approves it before agents query. Never overwrites one.',
      parameters: { type: 'object', properties: { db: { type: 'string' } }, required: ['db'] },
      kind: 'edit', parallelSafe: false,
      summarize: (i) => `draft the semantics of ${i.db}`,
      async run(input, ctx) {
        if (!ctx.services?.answers) return { content: 'Data answers are not available in this session.', is_error: true };
        const db = String(input.db ?? '');
        const rel = `${db.replace(/\.(db|sqlite3?)$/i, '')}.semantics.md`;
        try { await readFile(api, ctx.host, rel); return { content: `${rel} exists already: the person edits it.`, is_error: true }; } catch { /* none */ }
        try {
          const schema = await ctx.services.answers.schema(db);
          const text = [`# Semantics of ${db}`, '', 'Status: draft (the person reviews the definitions below, then changes this line to "Status: approved"; until then agents do not query)', '', '## Tables', '', ...schema.split('\n').map((l) => `- ${l}`), '', '## Definitions', '', '- <term>: <how it is computed: the table, the filter, the grain>', '', '## Pitfalls', '', '- <joins that repeat rows, which date column, which periods are complete>', ''].join('\n');
          await writeFile(api, ctx.host, rel, text);
          return { content: `Wrote ${rel} (draft). Ask the person to review the definitions and approve it before querying.` };
        } catch (e) { return { content: e.message, is_error: true }; }
      },
    });

    api.registerTool({
      name: 'check_answer',
      description: `The provenance rule over an answer file (${ANSWER}): every number cites the query cell it came from ([q3]) and appears in it, or its sentence ends "(derived: <the arithmetic>)" and cites the cells it used. Run it before you finish.`,
      parameters: { type: 'object', properties: { path: { type: 'string', description: `The answer, e.g. ${ANSWER}` } }, required: ['path'] },
      kind: 'read', parallelSafe: true,
      summarize: (i) => `check the numbers in ${i.path}`,
      async run(input, ctx) {
        if (!ctx.services?.answers) return { content: 'Data answers are not available in this session.', is_error: true };
        try { const r = await provenance(api, ctx.host, ctx.services, String(input.path ?? ANSWER)); return { content: `${r.summary}${r.details ? `\n${r.details}` : ''}`, is_error: !r.pass }; } catch (e) { return { content: e.message, is_error: true }; }
      },
    });

    api.registerTool({
      name: 'recompute_answer',
      description: `An independent recomputation of an answer file's figures (${ANSWER}) by an agent of another model family that sees only the question, the stated interpretation and the definitions (never these queries); the figures are compared in code. Writes data/recompute.md.`,
      parameters: { type: 'object', properties: { path: { type: 'string', description: `The answer, e.g. ${ANSWER}` } }, required: ['path'] },
      kind: 'read', parallelSafe: false,
      summarize: (i) => `recompute ${i.path}`,
      async run(input, ctx) {
        if (!ctx.services?.answers || !ctx.services.crossAgent) return { content: 'Recomputation is not available in this session.', is_error: true };
        try { const r = await recompute(api, ctx.host, ctx.services, String(input.path ?? ANSWER), ctx.signal); return { content: `${r.summary}\n\n${r.text}`, is_error: !r.pass }; } catch (e) { return { content: e.message, is_error: true }; }
      },
    });

    api.registerGate({
      name: 'provenance',
      description: `Every number in ${ANSWER} comes from a query cell of this session (or is marked derived)`,
      async applies(host) {
        const fs = await import('node:fs/promises');
        const real = await api.workspacePath(host, ANSWER).catch(() => null);
        return !!real && !!(await fs.stat(real).catch(() => null))?.isFile();
      },
      async run({ host, services }) {
        if (!services?.answers) return { pass: false, summary: 'query cells are not kept here' };
        return provenance(api, host, services, ANSWER);
      },
    });

    // A model runs it, so only where a workflow names it.
    api.registerGate({
      name: 'recompute',
      description: `${ANSWER}'s figures agree with an independent recomputation on another model family`,
      applies: async () => false,
      async run({ host, services, signal }) {
        if (!services?.answers || !services.crossAgent) return { pass: false, summary: 'recomputation is not available here' };
        const r = await recompute(api, host, services, ANSWER, signal);
        return { pass: r.pass, summary: r.summary, details: r.text };
      },
    });
  },
};
