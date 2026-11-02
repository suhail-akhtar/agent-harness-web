// Investigations as co-pilot work (docs/swarm/SWARM.md, phase 6): agents gather evidence, rank leads and work through
// a coverage checklist; people make every identification, attribution and remediation decision. A lead is kept with
// its evidence in the harness's own queue (the plugin's data folder, never the workspace); deciding one asks the
// person, and is refused where nobody can be asked. All of it inside the mandate the person wrote.

import crypto from 'node:crypto';

const MANDATE = '.harness/investigation-mandate.json';
const CHECKLIST = 'investigation/checklist.md';

const store = (api, root) => `${api.dataDir}/leads-${crypto.createHash('sha256').update(root).digest('hex').slice(0, 16)}.json`;
async function load(api, root) { const fs = await import('node:fs/promises'); try { return JSON.parse(await fs.readFile(store(api, root), 'utf8')); } catch { return { leads: [] }; } }
async function save(api, root, q) { const fs = await import('node:fs/promises'); await fs.mkdir(api.dataDir, { recursive: true }); await fs.writeFile(store(api, root), JSON.stringify(q, null, 2)); }

async function mandate(api, host) {
  const fs = await import('node:fs/promises');
  let m;
  try { m = JSON.parse(await fs.readFile(await api.workspacePath(host, MANDATE), 'utf8')); } catch { return { why: `no mandate: the person writes ${MANDATE} ({"purpose": "...", "subjects": ["what may be looked at"], "authorizedBy": "<name>", "until": "YYYY-MM-DD"})` }; }
  if (typeof m.purpose !== 'string' || !Array.isArray(m.subjects) || !m.subjects.length || typeof m.authorizedBy !== 'string') return { why: `${MANDATE} needs "purpose", "subjects" and "authorizedBy"` };
  if (m.until && new Date().toISOString().slice(0, 10) > m.until) return { why: `the mandate ended on ${m.until}` };
  return { m };
}

export default {
  name: 'investigations',
  setup(api) {
    api.registerTool({
      name: 'add_lead',
      description: `Add a lead to the investigation's queue: what it is, the evidence behind it (each item: where it was found, and the exact words or the record), how strong it is (0 to 1) and why. A lead is a question for the person, never a conclusion: never name a person as responsible, never attribute. Only inside the mandate (${MANDATE}).`,
      parameters: { type: 'object', properties: {
        title: { type: 'string', description: 'The lead, as a question or an observation (e.g. "the 03:12 login from a new country preceded the export")' },
        evidence: { type: 'array', items: { type: 'object', properties: { source: { type: 'string' }, quote: { type: 'string' } } }, description: 'Each piece: where it was found (a file and line, a URL, a record id) and the exact words' },
        score: { type: 'number', description: 'How strong the lead is, 0 to 1' },
        why: { type: 'string', description: 'Why it matters, in one sentence' },
      }, required: ['title', 'evidence', 'score', 'why'] },
      kind: 'edit', parallelSafe: false,
      summarize: (i) => `lead: ${String(i.title ?? '').slice(0, 100)}`,
      async run(input, ctx) {
        const md = await mandate(api, ctx.host);
        if (!md.m) return { content: `Not added: ${md.why}.`, is_error: true };
        const evidence = (Array.isArray(input.evidence) ? input.evidence : []).filter((e) => e && typeof e.source === 'string' && e.source.trim()).slice(0, 20);
        if (!evidence.length) return { content: 'A lead needs evidence: at least one item with where it was found (source) and the exact words (quote).', is_error: true };
        const root = await api.workspacePath(ctx.host, '.');
        const q = await load(api, root);
        const id = `L${q.leads.length + 1}`;
        const score = Math.max(0, Math.min(1, Number(input.score) || 0));
        q.leads.push({ id, title: String(input.title).slice(0, 300), evidence: evidence.map((e) => ({ source: String(e.source).slice(0, 300), quote: String(e.quote ?? '').slice(0, 1000), hash: crypto.createHash('sha256').update(String(e.quote ?? '')).digest('hex').slice(0, 16) })), score, why: String(input.why ?? '').slice(0, 400), status: 'open', at: new Date().toISOString() });
        await save(api, root, q);
        return `${id} added to the queue (score ${score.toFixed(2)}, ${evidence.length} piece(s) of evidence). A person decides it.`;
      },
    });

    api.registerTool({
      name: 'leads',
      description: 'The investigation\'s queue: leads ranked by strength, with their evidence and what the person decided.',
      parameters: { type: 'object', properties: {} },
      kind: 'read', parallelSafe: true,
      summarize: () => 'list the leads',
      async run(_i, ctx) {
        const q = await load(api, await api.workspacePath(ctx.host, '.'));
        if (!q.leads.length) return 'No leads yet.';
        return [...q.leads].sort((a, b) => b.score - a.score).map((l) => `- ${l.id} [${l.status}${l.decidedBy ? ` by ${l.decidedBy}` : ''}] (${l.score.toFixed(2)}) ${l.title}\n  why: ${l.why}\n${l.evidence.map((e) => `  evidence: ${e.source}: "${e.quote.slice(0, 200)}"`).join('\n')}${l.note ? `\n  the person's note: ${l.note}` : ''}`).join('\n');
      },
    });

    api.registerTool({
      name: 'decide_lead',
      description: 'Put a lead to the person to decide (confirmed, dismissed, or needs more evidence): identifications, attributions and remediations are theirs alone. It asks them itself, with the evidence of the lead: do not ask them first with ask_user. The decision is whatever they answer; where nobody can be asked, nothing is decided.',
      parameters: { type: 'object', properties: { id: { type: 'string' }, recommendation: { type: 'string', description: 'What you would recommend, and why, in one or two sentences' } }, required: ['id'] },
      kind: 'meta', parallelSafe: false,
      summarize: (i) => `ask the person to decide ${i.id}`,
      async run(input, ctx) {
        const root = await api.workspacePath(ctx.host, '.');
        const q = await load(api, root);
        const l = q.leads.find((x) => x.id === input.id);
        if (!l) return { content: `No lead ${input.id}.`, is_error: true };
        if (!ctx.askUser) return { content: `Not decided: ${l.id} waits for a person (nobody can be asked from here). Leave it open in the report.`, is_error: true };
        const options = ['Confirmed', 'Dismissed', 'Needs more evidence'];
        const answer = await ctx.askUser(`Decide lead ${l.id}: ${l.title}\n\nEvidence:\n${l.evidence.map((e) => `- ${e.source}: "${e.quote.slice(0, 300)}"`).join('\n')}${input.recommendation ? `\n\nThe agent recommends: ${String(input.recommendation).slice(0, 500)}` : ''}`, options);
        const a = typeof answer === 'string' ? { answered: answer } : answer;
        if ('skipped' in a) return { content: `${l.id} is not decided: the person skipped it. Leave it open.`, is_error: true };
        const said = 'answered' in a ? a.answered : a.replied;
        const status = /^confirmed/i.test(said) ? 'confirmed' : /^dismissed/i.test(said) ? 'dismissed' : /^needs more/i.test(said) ? 'needs more evidence' : 'open';
        l.status = status; l.decidedBy = 'the person'; l.decidedAt = new Date().toISOString(); l.note = ('note' in a && a.note) ? a.note : status === 'open' ? said : undefined;
        await save(api, root, q);
        // Said in full: the question went to the person, not through the agent (seen live: an agent that only read
        // "confirmed by the person" doubted it had asked, and asked again).
        const note = 'note' in a && a.note ? ` Their note: "${String(a.note).slice(0, 300)}".` : '';
        return `${l.id} was put to the person (the question appeared to them with its evidence${input.recommendation ? ' and your recommendation' : ''}). They answered "${said.slice(0, 300)}": ${status === 'open' ? 'it stays open' : `${status}, by the person`}.${note}`;
      },
    });

    // Coverage: every item of the checklist is done or says why it does not apply.
    api.registerGate({
      name: 'coverage',
      description: `Every item of ${CHECKLIST} is checked ([x]) or marked N/A with a reason`,
      async applies(host) {
        const fs = await import('node:fs/promises');
        const real = await api.workspacePath(host, CHECKLIST).catch(() => null);
        return !!real && !!(await fs.stat(real).catch(() => null))?.isFile();
      },
      async run({ host }) {
        const fs = await import('node:fs/promises');
        const items = (await fs.readFile(await api.workspacePath(host, CHECKLIST), 'utf8')).split('\n').filter((l) => /^\s*[-*]\s+\[[ xX]\]/.test(l));
        if (!items.length) return { pass: false, summary: `${CHECKLIST} has no items ("- [ ] what to check")` };
        const open = items.filter((l) => /\[ \]/.test(l) && !/\bN\/A:\s*\S/.test(l));
        return open.length ? { pass: false, summary: `${CHECKLIST}: ${open.length} of ${items.length} item(s) not covered`, details: open.map((l) => l.trim()).join('\n') } : { pass: true, summary: `${CHECKLIST}: all ${items.length} item(s) covered` };
      },
    });
  },
};
