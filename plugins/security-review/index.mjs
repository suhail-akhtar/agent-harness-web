// Security review of the person's own code, gated by an oracle (docs/swarm/SWARM.md, phase 4). A finding counts
// only when its reproducer, run here by the harness, demonstrates it: the command exits 0 and prints the marker it
// names (a leaked value, "PWNED", the path it should not have reached). The harness keeps each run in its own ledger
// (the plugin's data folder, never the workspace): the command, its output, a hash. A finding without a reproducer
// that fires is "unconfirmed", for a person to judge. A fix is accepted when the reproducer no longer fires and the
// tests pass. All of it only inside the mandate the person wrote: the paths in scope and the dates it holds for.

import crypto from 'node:crypto';

const MANDATE = '.harness/security-mandate.json';

function ledgerFile(api, root) {
  const id = crypto.createHash('sha256').update(root).digest('hex').slice(0, 16);
  return `${api.dataDir}/findings-${id}.json`;
}
async function readLedger(api, root) {
  const fs = await import('node:fs/promises');
  try { return JSON.parse(await fs.readFile(ledgerFile(api, root), 'utf8')); } catch { return {}; }
}
async function writeLedger(api, root, ledger) {
  const fs = await import('node:fs/promises');
  await fs.mkdir(api.dataDir, { recursive: true });
  await fs.writeFile(ledgerFile(api, root), JSON.stringify(ledger, null, 2));
}

/** The person's mandate: { scope: ["src/**"], authorizedBy, from, until, network?: "none" }. Undefined with why. */
async function mandate(api, host) {
  const fs = await import('node:fs/promises');
  let m;
  try { m = JSON.parse(await fs.readFile(await api.workspacePath(host, MANDATE), 'utf8')); } catch { return { why: `no mandate: the person writes ${MANDATE} ({"scope": ["src/**"], "authorizedBy": "<name>", "from": "YYYY-MM-DD", "until": "YYYY-MM-DD"}) to authorize a review of this code` }; }
  const today = new Date().toISOString().slice(0, 10);
  if (!Array.isArray(m.scope) || !m.scope.length || typeof m.authorizedBy !== 'string' || !m.authorizedBy.trim()) return { why: `${MANDATE} needs "scope" (paths) and "authorizedBy"` };
  if ((m.from && today < m.from) || (m.until && today > m.until)) return { why: `the mandate holds from ${m.from ?? '-'} until ${m.until ?? '-'}; today is ${today}` };
  return { m };
}

const globRe = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}$`);
const inScope = (m, file) => m.scope.some((g) => globRe(g).test(file.replace(/\\/g, '/').replace(/^\.\//, '')));

/** Runs a reproducer where the workspace's commands run; it fires when it exits 0 and prints its marker. */
async function fire(host, command, marker, signal) {
  const r = await host.exec(command, { timeoutMs: 60_000, signal });
  const out = `${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ''}`.slice(0, 4000);
  return { fired: r.code === 0 && out.includes(marker), code: r.code, out };
}

export default {
  name: 'security-review',
  setup(api) {
    api.registerTool({
      name: 'confirm_finding',
      description: `Confirm a security finding in the person's own code by running its reproducer here: a command (a script or a test in the workspace) that exits 0 and prints the marker when the vulnerability is real (the leaked value, "PWNED", the file it should not reach). The harness runs it, keeps the run in its own ledger, and reports CONFIRMED or UNCONFIRMED. Only inside the person's mandate (${MANDATE}). Never point a reproducer at anything outside this workspace.`,
      parameters: { type: 'object', properties: {
        id: { type: 'string', description: 'A short id for the finding, e.g. F1' },
        title: { type: 'string', description: 'What is wrong, in a few words (e.g. "path traversal in /files")' },
        file: { type: 'string', description: 'The file where the flaw is' },
        kind: { type: 'string', description: 'The class (CWE if you know it): path traversal, SQL injection, command injection, secret in code, ...' },
        reproducer: { type: 'string', description: 'The command that demonstrates it' },
        marker: { type: 'string', description: 'What its output contains when it is demonstrated' },
      }, required: ['id', 'title', 'file', 'reproducer', 'marker'] },
      kind: 'exec', parallelSafe: false,
      summarize: (i) => `confirm ${i.id}: ${i.title}`,
      async run(input, ctx) {
        const md = await mandate(api, ctx.host);
        if (!md.m) return { content: `Not run: ${md.why}.`, is_error: true };
        const file = String(input.file ?? '');
        if (!inScope(md.m, file)) return { content: `Not run: ${file} is outside the mandate's scope (${md.m.scope.join(', ')}).`, is_error: true };
        const marker = String(input.marker ?? '');
        if (marker.length < 3) return { content: 'The marker must be at least 3 characters (something the output only contains when the flaw is demonstrated).', is_error: true };
        const root = await api.workspacePath(ctx.host, '.');
        const ledger = await readLedger(api, root);
        const id = String(input.id ?? '').slice(0, 20) || `F${Object.keys(ledger).length + 1}`;
        // A finding confirmed once stays confirmed: run again after a fix, it is a fix to check, not a finding gone
        // (seen live: a re-run after the patch erased a confirmed SQL injection from the ledger).
        const prev = ledger[id];
        if (prev?.confirmed) return { content: `${id} was confirmed already (its reproducer fired). To check a fix of it, use check_fix: it runs the reproducer again and the tests.`, is_error: true };
        const r = await fire(ctx.host, String(input.reproducer), marker, ctx.signal);
        ledger[id] = { id, title: String(input.title ?? ''), file, kind: String(input.kind ?? ''), reproducer: String(input.reproducer), marker, confirmed: r.fired, runs: [...(prev?.runs ?? []), { at: new Date().toISOString(), what: 'confirm', fired: r.fired, code: r.code, hash: crypto.createHash('sha256').update(r.out).digest('hex').slice(0, 16) }] };
        await writeLedger(api, root, ledger);
        return { content: `${id} ${r.fired ? 'CONFIRMED' : 'UNCONFIRMED'}: the reproducer ${r.fired ? 'fired' : `did not fire (exit ${r.code}${r.code === 0 ? ', no marker in its output' : ''})`}.\n\n${r.out.slice(0, 1500)}`, is_error: !r.fired };
      },
    });

    api.registerTool({
      name: 'check_fix',
      description: 'After a patch: run a confirmed finding\'s reproducer again (it must no longer fire) and the project\'s tests (they must pass). The harness keeps the run in its ledger.',
      parameters: { type: 'object', properties: { id: { type: 'string' }, tests: { type: 'string', description: 'The command that runs the project\'s tests, e.g. npm test' } }, required: ['id', 'tests'] },
      kind: 'exec', parallelSafe: false,
      summarize: (i) => `check the fix of ${i.id}`,
      async run(input, ctx) {
        const md = await mandate(api, ctx.host);
        if (!md.m) return { content: `Not run: ${md.why}.`, is_error: true };
        const root = await api.workspacePath(ctx.host, '.');
        const ledger = await readLedger(api, root);
        const f = ledger[String(input.id ?? '')];
        if (!f?.confirmed) return { content: `${input.id} is not a confirmed finding (confirm_finding first): a fix is checked against a reproducer that fired.`, is_error: true };
        const r = await fire(ctx.host, f.reproducer, f.marker, ctx.signal);
        const t = await ctx.host.exec(String(input.tests ?? ''), { timeoutMs: 600_000, signal: ctx.signal });
        const fixed = !r.fired && t.code === 0;
        f.fixed = fixed;
        f.runs.push({ at: new Date().toISOString(), what: 'fix', fired: r.fired, tests: t.code, hash: crypto.createHash('sha256').update(r.out).digest('hex').slice(0, 16) });
        await writeLedger(api, root, ledger);
        return { content: `${f.id} ${fixed ? 'FIXED' : 'NOT FIXED'}: the reproducer ${r.fired ? 'still fires' : 'no longer fires'}; the tests ${t.code === 0 ? 'pass' : `fail (exit ${t.code})`}.${t.code !== 0 ? `\n\n${`${t.stdout}${t.stderr}`.slice(-1500)}` : ''}`, is_error: !fixed };
      },
    });

    api.registerTool({
      name: 'findings',
      description: 'The findings the harness has run reproducers for in this workspace: confirmed, unconfirmed, fixed.',
      parameters: { type: 'object', properties: {} },
      kind: 'read', parallelSafe: true,
      summarize: () => 'list the findings',
      async run(_input, ctx) {
        const ledger = await readLedger(api, await api.workspacePath(ctx.host, '.'));
        const all = Object.values(ledger);
        if (!all.length) return 'No findings have been run yet.';
        return all.map((f) => `- ${f.id} [${f.fixed ? 'FIXED' : f.confirmed ? 'CONFIRMED' : 'UNCONFIRMED'}] ${f.title} (${f.file}${f.kind ? `, ${f.kind}` : ''}); reproducer: ${f.reproducer}`).join('\n');
      },
    });

    // The report holds up: every finding it calls confirmed was confirmed by the harness, and none it calls fixed is not.
    api.registerGate({
      name: 'findings-confirmed',
      description: 'security/findings.md calls a finding CONFIRMED (or FIXED) only when the harness ran its reproducer and it fired (or no longer fires)',
      async applies(host) {
        const fs = await import('node:fs/promises');
        const real = await api.workspacePath(host, 'security/findings.md').catch(() => null);
        return !!real && !!(await fs.stat(real).catch(() => null))?.isFile();
      },
      async run({ host }) {
        const fs = await import('node:fs/promises');
        const text = await fs.readFile(await api.workspacePath(host, 'security/findings.md'), 'utf8');
        const ledger = await readLedger(api, await api.workspacePath(host, '.'));
        const problems = [];
        for (const m of text.matchAll(/\b(F\d+)\b[^\n]*\b(CONFIRMED|FIXED)\b/g)) {
          const f = ledger[m[1]];
          if (m[2] === 'CONFIRMED' && !f?.confirmed) problems.push(`${m[1]} is called CONFIRMED, but its reproducer ${f ? 'did not fire' : 'was never run'} (confirm_finding)`);
          if (m[2] === 'FIXED' && !f?.fixed) problems.push(`${m[1]} is called FIXED, but check_fix ${f ? 'did not pass' : 'was never run'}`);
        }
        const confirmed = Object.values(ledger).filter((f) => f.confirmed);
        const missing = confirmed.filter((f) => !new RegExp(`\\b${f.id}\\b`).test(text));
        for (const f of missing) problems.push(`${f.id} (${f.title}) was confirmed but is not in the report`);
        // Coverage: a review that looked at nothing must not read as a clean bill (seen live: no plan, no file reviewed,
        // "none confirmed", and the workflow succeeded). Every file of the plan is in the report.
        const plan = await fs.readFile(await api.workspacePath(host, 'security/plan.md'), 'utf8').catch(() => '');
        const files = [...new Set([...plan.matchAll(/^\s*[-*]\s+`?([\w./\\-]+\.[\w]+)`?\s*:/gm)].map((m) => m[1].replace(/\\/g, '/')))];
        if (!files.length) problems.push('security/plan.md lists no files (one line per file in scope: "- <path>: <why>"): a review must say what it covered');
        for (const f of files) if (!text.replace(/\\/g, '/').includes(f)) problems.push(`${f} is on the plan but not in the report (under a finding, or under "Reviewed with nothing found")`);
        return problems.length ? { pass: false, summary: `security/findings.md: ${problems.length} problem(s)`, details: problems.map((p) => `- ${p}`).join('\n') } : { pass: true, summary: `security/findings.md: ${confirmed.length} confirmed finding(s), each with a reproducer that fired` };
      },
    });
  },
};
