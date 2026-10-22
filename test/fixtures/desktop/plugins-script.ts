// The scripted model of the plugins journey (see plugins-engine.ts): every role it plays, by what it is asked.
import type { Provider, ProviderRequest, ProviderResponse } from '../../../src/providers/types.ts';
import type { Block, Message } from '../../../src/core/types.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const textOf = (b: Block[]) => b.filter((x) => x.type === 'text').map((x) => (x as { text: string }).text).join('\n');
const resultText = (m: Message | undefined) => (m?.content ?? []).map((b) => (b.type === 'tool_result' ? String((b as { content?: unknown }).content ?? '') : b.type === 'text' ? (b as { text: string }).text : '')).join('\n');

const SLUGIFY_V1 = `// slugify(text): lower-case ASCII words joined by dashes, at most 80 characters (REQ-1..REQ-3).
// TODO: transliterate more scripts than Latin.
export function slugify(text) {
  if (typeof text !== 'string') throw new TypeError('slugify expects text');
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '');
}
`;
const SLUGIFY_V2 = `// slugify(text): lower-case ASCII words joined by dashes, at most 80 characters (REQ-1..REQ-3).
// TODO: transliterate more scripts than Latin.
export function slugify(text) {
  if (typeof text !== 'string') throw new TypeError('slugify expects text');
  return text.normalize('NFKD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '');
}
`;
const TESTS = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slugify } from '../src/slugify.js';

test('REQ-1 words joined by dashes, lower case', () => { assert.equal(slugify('Hello World'), 'hello-world'); });
test('REQ-1 punctuation and spaces collapse', () => { assert.equal(slugify('  A -- B!!  '), 'a-b'); });
test('REQ-2 accents are removed', () => { assert.equal(slugify('Crème Brûlée'), 'creme-brulee'); });
test('REQ-3 at most 80 characters, never ending in a dash', () => { const s = slugify('word '.repeat(40)); assert.ok(s.length <= 80 && !s.endsWith('-')); });
`;

type Call = { name: string; input: Record<string, unknown> };
type Turn = { text?: string; calls?: Call[] };
const write = (p: string, content: string): Call => ({ name: 'write', input: { path: p, content } });

/** A build-feature agent: its steps by what its brief asks; the report when the steps are done. */
function featureAgent(brief: string, step: number): Turn | undefined {
  const plan: Array<[RegExp, Turn[], string]> = [
    [/Write docs\/requirements\.md for this request/, [{ calls: [write('docs/requirements.md', '# Requirements: slugify\n\n| ID | Requirement | Acceptance |\n|---|---|---|\n| REQ-1 | `slugify(text)` gives lower-case ASCII words joined by dashes | `slugify("Hello World")` is `hello-world` |\n| REQ-2 | Accents are removed | `slugify("Crème Brûlée")` is `creme-brulee` |\n| REQ-3 | At most 80 characters, never ending in a dash | a 200-character title gives 80 or fewer |\n\n## Assumptions\n- Node 22 or later, no dependencies.\n\n## Out of scope\n- Scripts other than Latin.\n')] }], 'REQ-1 words joined by dashes; REQ-2 accents removed; REQ-3 at most 80 characters. Assumption: Node 22, no dependencies.'],
    [/Design the solution for docs\/requirements\.md/, [{ calls: [write('docs/architecture.md', '# Architecture\n\nOne ES module, `src/slugify.js`, exporting `slugify(text)`; tests with `node:test` (`npm test`).\n\n## Error handling\nA non-string argument throws a `TypeError`.\n'), write('docs/adr/0001-no-dependencies.md', '# ADR 0001: No dependencies\n\nStatus: accepted\n\nUnicode normalisation (`String.prototype.normalize`) removes accents; no library is needed.\n')] }], 'Stack: Node 22, one ES module, node:test. ADR 0001: no dependencies.'],
    [/Write docs\/plan\.md/, [{ calls: [write('docs/plan.md', '# Plan\n\n1. Project setup: package.json with `npm test` (REQ-1..3)\n2. Tests first: test/slugify.test.js (REQ-1..3)\n3. src/slugify.js (REQ-1..3)\n')] }], '1. setup 2. tests first 3. implementation'],
    [/Implement docs\/plan\.md/, [{ calls: [write('package.json', '{\n  "name": "slugify",\n  "version": "1.0.0",\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n'), write('test/slugify.test.js', TESTS), write('src/slugify.js', SLUGIFY_V1)] }], 'Built src/slugify.js with test/slugify.test.js; npm test runs them.'],
    [/The quality gates failed/, [{ calls: [{ name: 'read', input: { path: 'src/slugify.js' } }] }, { calls: [write('src/slugify.js', SLUGIFY_V2)] }], 'REQ-2 failed: accents were dropped with the letters. Now the text is normalised (NFKD) and the combining marks removed first.'],
    [/Review the implementation against docs\/requirements\.md/, [{ calls: [write('docs/reviews/code-review.md', '# Code review\n\nEvery requirement is implemented and tested (REQ-1..REQ-3).\n\n- MINOR src/slugify.js:2 a TODO is left for other scripts (out of scope).\n\nVerdict: APPROVE\n')] }], 'All three requirements are covered by tests. One MINOR note.\n\nAPPROVE'],
    [/Review the implementation for security problems/, [{ calls: [write('docs/reviews/security-review.md', '# Security review\n\nNo input reaches a shell, a file or a network call; the output is bounded at 80 characters. Nothing found.\n\nVerdict: APPROVE\n')] }], 'Nothing found.\n\nAPPROVE'],
    [/Write or update README\.md/, [{ calls: [{ name: 'read', input: { path: 'README.md' } }] }, { calls: [write('README.md', '# slugify\n\n```js\nimport { slugify } from "./src/slugify.js";\nslugify("Crème Brûlée"); // "creme-brulee"\n```\n\nTest: `npm test`.\n'), write('CHANGELOG.md', '# Changelog\n\n## 1.0.0\n- slugify(text)\n')] }], 'README and CHANGELOG written; npm test confirmed.'],
    [/Write docs\/delivery-report\.md/, [{ calls: [write('docs/delivery-report.md', '# Delivery report - slugify\n\n## Summary\n`slugify(text)` is built, tested and reviewed.\n\n## Traceability\n| Requirement | Implemented in | Verified by |\n|---|---|---|\n| REQ-1 | src/slugify.js | test/slugify.test.js: REQ-1 (2 tests) |\n| REQ-2 | src/slugify.js | test/slugify.test.js: REQ-2 |\n| REQ-3 | src/slugify.js | test/slugify.test.js: REQ-3 |\n\n## Quality gates\nPASS node-test (4 tests: 4 passed)\n\n## Reviews\nCode review: APPROVE. Security review: APPROVE.\n')] }], 'Delivered: slugify with 4 passing tests, both reviews approved.'],
  ];
  for (const [re, steps, report] of plan) if (re.test(brief)) return step < steps.length ? steps[step] : { text: report };
  return undefined;
}

let incidentId = '';
/** /incident: read, open, record, decide, write, resolve. */
function incidentFlow(step: number, last: Message | undefined, all: Message[]): Turn {
  const evidence = [...new Set(all.flatMap((m) => resultText(m).match(/\bev-[0-9a-f]{6}\b/g) ?? []))];
  const cite = evidence.slice(0, 3).map((e) => `[${e}]`).join(' ');
  const opened = /Opened (inc-[a-z0-9-]+)/.exec(all.map(resultText).join('\n'))?.[1];
  if (opened) incidentId = opened;
  const id = opened ?? incidentId;
  switch (step) {
    case 0: return { text: 'Reading the alerts, the SLOs and the dependencies first.', calls: [{ name: 'alerts', input: { action: 'list' } }, { name: 'slo_status', input: { service: 'checkout' } }, { name: 'topology', input: { action: 'dependencies', service: 'checkout' } }] };
    case 1: return { calls: [{ name: 'incident', input: { action: 'open', title: 'Checkout payments failing after v42', severity: 'sev2', services: ['checkout', 'payments'], summary: '21% of checkout requests fail since the v42 deploy.' } }] };
    case 2: return { calls: [{ name: 'incident', input: { action: 'update', id, kind: 'evidence', note: `checkout error ratio 0.21 for 6 minutes, SLO burn above 10x; checkout depends on payments and orders-db ${cite}` } }] };
    case 3: return { calls: [{ name: 'incident', input: { action: 'update', id, kind: 'hypothesis', note: `Refuter: SURVIVES - the errors start 2 minutes after the v42 deploy, only checkout's payment calls fail, and payments' own error ratio is normal ${cite}` } }] };
    case 4: return { calls: [{ name: 'incident', input: { action: 'update', id, status: 'identified', kind: 'note', note: `Root cause: the v42 deploy of checkout ships payment client 3.2, whose retries exhaust its connection pool to payments ${cite}. Confidence: high - metrics, the change timeline and the dependency graph agree.` } }] };
    case 5: return { calls: [write(`.harness/ops/runbooks/remediate-${id}.md`, `# Remediate ${id}: roll checkout back to v41\n\n1. [check] \`prometheus_query(query="checkout_error_ratio")\` - above 0.05\n2. [approval] Roll checkout back to v41 (outside a maintenance window)\n3. [change] \`service_control(service="checkout", action="restart")\` with image v41\n4. [verify] \`ops_check(service="checkout")\` - no critical alert\n\n## Rollback\nRedeploy v42.\n`)] };
    case 6: return { calls: [{ name: 'incident', input: { action: 'resolve', id, root_cause: `The v42 deploy of checkout ships payment client 3.2, whose retries exhaust its connection pool to payments ${cite}`, resolution: 'Rolled checkout back to v41; payment client pinned to 3.1.' } }] };
    case 7: return { calls: [{ name: 'incident', input: { action: 'postmortem', id, summary: 'A client upgrade in the v42 deploy exhausted the connection pool to payments.', impact: ['21% of checkout requests failed for 14 minutes'], detection: ['CheckoutErrorRatio fired 2 minutes after the deploy'], went_well: ['The change timeline pointed at the deploy at once'], went_wrong: ['The canary did not exercise payments'], action_items: [{ action: 'Add a payments call to the checkout canary', type: 'detect', owner: 'team-shop', priority: 'P1' }], evidence: evidence.slice(0, 3) } }] };
    default: return { text: `Incident ${id} is resolved: the v42 deploy's payment client exhausted the pool to payments ${cite}. The runbook, the timeline and the postmortem are in the workspace.` };
  }
}

export class ScriptedProvider implements Provider {
  private n = 0;
  async send(req: ProviderRequest): Promise<ProviderResponse> {
    const first = req.messages.find((m) => m.role === 'user');
    const brief = first ? textOf(first.content) : '';
    const last = req.messages[req.messages.length - 1];
    const step = req.messages.filter((m) => m.role === 'assistant').length;
    const said = last && last.role === 'user' && !last.content.some((b) => b.type === 'tool_result') ? textOf(last.content) : '';
    const afterTool = !!last && last.role === 'user' && last.content.some((b) => b.type === 'tool_result');
    let turn: Turn | undefined = featureAgent(brief, step);
    if (!turn) {
      // The main conversation: what the person (or a panel) asked last.
      const asked = said || [...req.messages].reverse().map((m) => (m.role === 'user' ? textOf(m.content) : '')).find((t) => t.trim()) || '';
      const sinceAsk = (() => { let k = 0; for (let i = req.messages.length - 1; i >= 0; i--) { const m = req.messages[i]!; if (m.role === 'user' && textOf(m.content).trim() && !m.content.some((b) => b.type === 'tool_result')) break; if (m.role === 'assistant') k++; } return k; })();
      const gate = /Run the quality gates? (.+?) again \(quality_gates tool with gates: (\[[^\]]*\])\)/.exec(asked);
      if (/Open an incident for:/.test(asked)) turn = incidentFlow(sinceAsk, last, req.messages.slice(req.messages.findLastIndex((m) => m.role === 'user' && /Open an incident for:/.test(textOf(m.content)))));
      else if (gate || /Run every applicable quality gate again|Run the quality gates \(quality_gates tool\)/.test(asked)) {
        turn = !afterTool ? { calls: [{ name: 'quality_gates', input: gate ? { gates: JSON.parse(gate[2]!) as string[] } : {} }] } : { text: `The gates ran again:\n\n${resultText(last).split('\n').filter((l) => /^(PASS|FAIL|WARN)/.test(l)).map((l) => `- ${l}`).join('\n') || 'none applied'}` };
      } else if (/^Show incident (\S+) in the app/.test(asked)) {
        // The Operations page through the app (desktop_command, an agent-callable command of the aiops manifest).
        const id = /^Show incident (\S+) in the app/.exec(asked)![1]!;
        turn = sinceAsk === 0 ? { calls: [{ name: 'desktop_command', input: { command: 'aiops:open-incident', args: { id } } }] } : { text: `In the app: ${resultText(last).replace(/\s+/g, ' ').slice(0, 600)}` };
      } else if (/^Review the (changes|delivered changes)/.test(asked)) turn = { text: 'Reviewed against docs/requirements.md: no BLOCKING or MAJOR finding.\n\nAPPROVE' };
      else if (/incident-response workflow/.test(asked)) turn = { text: 'I would start the incident-response workflow with this symptom; it gathers evidence read-only and asks you before any change.' };
      else turn = { text: afterTool ? 'Done.' : 'Hello! This is the scripted engine.' };
    }
    const content: Block[] = [];
    if (turn.text) { req.onText?.(turn.text); content.push({ type: 'text', text: turn.text }); }
    for (const c of turn.calls ?? []) content.push({ type: 'tool_use', id: `call_${++this.n}`, name: c.name, input: c.input });
    await wait(40);
    return { message: { role: 'assistant', content, raw: { provider: 'deepseek', model: req.model.id, payload: { role: 'assistant', content: turn.text ?? null } } } as never, stop: turn.calls?.length ? 'tool_use' : 'end', usage: { input: 1200, cacheRead: 800, cacheWrite: 0, output: 60, reasoning: 0 } };
  }
}

