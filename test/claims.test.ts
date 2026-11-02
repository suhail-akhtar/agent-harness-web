import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { domainOf, extractClaims, judged, ledger, passageFor, verifyClaims } from '../src/research/claims.ts';
import { trailingJson } from '../src/agents/acceptance.ts';
import type { HarnessEvent } from '../src/core/types.ts';
import { runGates } from '../src/gates/gates.ts';
import { validateWorkflow } from '../src/graph/validate.ts';
import { createHarness } from '../src/kernel/harness.ts';
import { LocalHost } from '../src/runtime/host.ts';
import type { ToolServices } from '../src/tools/types.ts';
import { tempDir } from './helpers.ts';
import { OPERATOR, setupServer, waitFor } from './multi-helpers.ts';

// The claim ledger (docs/swarm/SWARM.md, phase 3): each cited sentence of a report judged against the passage of the
// page it cites, by a judge of another family that sees only the two; a "supported" must quote the page word for word.

const here = path.dirname(fileURLToPath(import.meta.url));

const REPORT = [
  '# Solar in 2026',
  '',
  'Global solar capacity passed 3 TW in 2026 [1]. Panel prices fell 12% that year [2].',
  'Most new capacity was in China [1][3]. Experts agree this will continue forever.',
  'See also [the agency summary](https://www.iea.org/solar).',
  '',
  '[1]: https://news.example.com/solar-3tw',
  '[2]: https://prices.example.org/panels',
  '[3]: https://www.energy.example.co.uk/china',
].join('\n');

test('claims: each cited sentence with its sources and independent sites; uncited sentences, headings and the reference list left out', () => {
  const c = extractClaims(REPORT);
  assert.deepEqual(c.map((x) => [x.line, x.sentence, x.urls.length, x.domains]), [
    [3, 'Global solar capacity passed 3 TW in 2026.', 1, ['example.com']],
    [3, 'Panel prices fell 12% that year.', 1, ['example.org']],
    [4, 'Most new capacity was in China.', 2, ['example.com', 'example.co.uk']],
    [5, 'See also the agency summary.', 1, ['iea.org']],
  ]);
  // A decimal stays in its sentence (seen live: "8,848.86 metres" was dropped whole), and a line without a stop counts.
  assert.deepEqual(extractClaims('Everest is 8,848.86 metres tall [1]. Growth was 3.5% [1]\n\n[1]: https://e.example/x\n').map((x) => x.sentence), ['Everest is 8,848.86 metres tall.', 'Growth was 3.5%']);
  // Abbreviations and sites named in the prose do not end a sentence (seen live: "Art. 5" and "artificialintelligenceact.eu" made fragments).
  assert.deepEqual(extractClaims('- Prohibitions (Art. 5), as adopted: 2 February 2025 [1].\nThe artificialintelligenceact.eu page says so, e.g. for Article 101 [1]. A second sentence here [1].\n\n[1]: https://x.example/a\n').map((x) => x.sentence), ['- Prohibitions (Art. 5), as adopted: 2 February 2025.', 'The artificialintelligenceact.eu page says so, e.g. for Article 101.', 'A second sentence here.']);
  // A URL with parentheses (seen live: a Wikipedia page cited as [n] was read as unread).
  const paren = extractClaims('Python was created by Guido van Rossum [1]. It is [widely taught](https://en.wikipedia.org/wiki/Python_(programming_language)).\n\n[1]: https://en.wikipedia.org/wiki/Python_(programming_language)\n');
  assert.deepEqual(paren.map((x) => x.urls), [['https://en.wikipedia.org/wiki/Python_(programming_language)'], ['https://en.wikipedia.org/wiki/Python_(programming_language)']]);
  assert.equal(domainOf('https://a.b.example.com/x'), 'example.com');
  assert.equal(domainOf('https://bbc.co.uk/news'), 'bbc.co.uk');
});

test('the passage a judge sees: the window of the page that shares most words with the claim', () => {
  const page = `${'Unrelated text about wind turbines and offshore farms. '.repeat(40)}In 2026 global solar capacity passed 3 TW for the first time, the agency said. ${'More filler about grids and storage. '.repeat(40)}`;
  const p = passageFor(page, 'Global solar capacity passed 3 TW in 2026.', 300, 1);
  assert.match(p, /global solar capacity passed 3 TW/);
  assert.ok(p.length < 600);
  // The page's own name is everywhere; the rare words find the sentence (seen live on Mount Everest's page).
  const everest = `${'Everest is a mountain. Everest climbers. Everest base camp is busy. '.repeat(30)}The official height of Everest, measured in 2020, is 8,848.86 metres. ${'Everest weather is cold. '.repeat(30)}${'Unrelated notes on the elevation of snow. '.repeat(3)}`;
  const e = passageFor(everest, "Mount Everest's official height is 8,848.86 metres.", 200);
  assert.match(e, /official height of Everest, measured in 2020, is 8,848\.86 metres/);
  assert.ok(e.split('\n[...]\n').length <= 3, 'at most three windows, apart');
});

test('a verdict held to the page: supported needs a quote that is in the source; an invented quote, an unreadable verdict or a bad status is unverifiable', () => {
  const [c] = extractClaims(REPORT);
  const src = ['In 2026 global solar capacity passed 3 TW for the first time.'];
  assert.equal(judged(c!, { status: 'supported', quote: 'global solar capacity passed 3 TW', why: 'it says so' }, src).status, 'supported');
  const fake = judged(c!, { status: 'supported', quote: 'solar capacity tripled to 3 TW', why: 'close enough' }, src);
  assert.deepEqual([fake.status, /its quote is not in the source/.test(fake.why)], ['unverifiable', true]);
  // An elided quote counts when each part is in the source in order (seen live: GPT quotes "a ... b").
  assert.equal(judged(c!, { status: 'supported', quote: 'In 2026 ... passed 3 TW', why: '' }, src).status, 'supported');
  assert.equal(judged(c!, { status: 'supported', quote: 'passed 3 TW ... In 2026', why: '' }, src).status, 'unverifiable', 'out of order');
  // A claim citing two pages, its quote a part of each (seen live in a deep-research run): each part verbatim on one of them.
  const two = ['From 2 August 2025, the obligations for providers of GPAI models entered into application.', 'From 2 August 2026, the Commission can fine providers.'];
  assert.equal(judged(c!, { status: 'supported', quote: 'the obligations for providers of GPAI models entered into application. ... the Commission can fine providers', why: '' }, two).status, 'supported');
  assert.equal(judged(c!, { status: 'supported', quote: 'the obligations for providers of GPAI models entered into application. ... the Commission can fine anyone', why: '' }, two).status, 'unverifiable', 'a part on neither page');
  // The same accented word in another Unicode form (seen live: "Sagarmāthā").
  assert.equal(judged(c!, { status: 'supported', quote: 'known in Nepali as Sagarmāthā, in Sherpa as Chamolangma, and in Tibetan as Jomolangma)', why: '' }, ['Mount Everest (known in Nepali as Sagarmāthā[a], in Sherpa as Chamolangma[4], and in Tibetan  as Jomolangma[b]) is high']).status, 'supported', 'and its footnote marks left out');
  // A table row quoted with its cell bars spaced otherwise (seen live: DeepSeek Flash on an infobox).
  assert.equal(judged(c!, { status: 'supported', quote: '|Designed by | Guido van Rossum |', why: '' }, ['Paradigm | Multi-paradigm\nDesigned by | Guido van Rossum\nDeveloper']).status, 'supported');
  assert.equal(judged(c!, { status: 'contradicted', why: 'the page says 2 TW' }, src).status, 'contradicted');
  assert.equal(judged(c!, undefined, src).status, 'unverifiable');
  assert.equal(judged(c!, { status: 'probably', quote: 'x' }, src).status, 'unverifiable');
  assert.match(ledger([{ ...c!, status: 'supported', quote: 'global solar capacity passed 3 TW', why: '' }]), /Claims: 1; supported 1[\s\S]*\| 1 \| 3 \| Global solar capacity passed 3 TW in 2026\. \| supported \| 1 \| "global solar capacity passed 3 TW" \|/);
});

test('verifying a report: every claim judged (at most so many at once), an unread source makes its claim unverifiable, past the limit listed not dropped', async () => {
  const pages: Record<string, string> = { 'https://news.example.com/solar-3tw': 'In 2026 global solar capacity passed 3 TW. China installed most of it.', 'https://prices.example.org/panels': 'Panel prices rose 5% in 2026.' };
  let at = 0; let most = 0;
  const r = await verifyClaims(REPORT, {
    text: async (u) => pages[u], parse: trailingJson, concurrency: 2, max: 3,
    judge: async (brief) => {
      at++; most = Math.max(most, at); await new Promise((x) => setTimeout(x, 20)); at--;
      if (/Panel prices fell 12%/.test(brief)) return { text: '{"status": "contradicted", "why": "the page says prices rose 5%"}', by: 'j' };
      if (/Most new capacity was in China/.test(brief)) return { text: '{"status": "supported", "quote": "China installed most of it", "why": "it says so"}', by: 'j' };
      return { text: '{"status": "supported", "quote": "global solar capacity passed 3 TW", "why": "it says so"}', by: 'j' };
    },
  });
  assert.deepEqual(r.judged.map((c) => c.status), ['supported', 'contradicted', 'supported', 'unverifiable']);
  assert.match(r.judged[3]!.why, /past the 3 claims checked/);
  assert.ok(most <= 2, `at most 2 at once (${most})`);
  // A stored page keeps link targets after link words; the judge's quote is matched as a reader sees the page (seen live).
  const linked = await verifyClaims('Eiffel named it [1].\n\n[1]: https://w.example/e\n', {
    text: async () => 'It is named after the engineer Gustave Eiffel (https://w.example/wiki/Gustave_Eiffel), whose company built it.', parse: trailingJson,
    judge: async (brief) => { assert.doesNotMatch(brief, /wiki\/Gustave_Eiffel/); return { text: '{"status": "supported", "quote": "named after the engineer Gustave Eiffel, whose company built it", "why": "x"}', by: 'j' }; },
  });
  assert.equal(linked.judged[0]!.status, 'supported');
  // A reply with no readable verdict is asked once more (seen live: Grok 4.7).
  let asks = 0;
  const again = await verifyClaims('Eiffel named it [1].\n\n[1]: https://w.example/e\n', {
    text: async () => 'Named after Gustave Eiffel.', parse: trailingJson,
    judge: async () => ({ text: ++asks === 1 ? 'I think it is supported.' : '{"status": "supported", "quote": "Named after Gustave Eiffel", "why": "x"}', by: 'j' }),
  });
  assert.deepEqual([again.judged[0]!.status, asks], ['supported', 2]);
  assert.match(r.ledger, /Claims: 4; supported 2, partial 0, unsupported 0, contradicted 1, unverifiable 1; backed by two or more independent sites: 1\./);
});

test('in a conversation: verify_claims judges on another provider than the conversation\'s (Claude here), writes research/claims.md, and flags what to fix', async () => {
  const t = await setupServer({ plugins: [path.join(here, '..', 'plugins', 'research')] });
  try {
    assert.equal((await t.call(OPERATOR, 'PUT', '/api/me/settings', { delegation: { allowedModels: ['claude-sonnet-5-5'] } })).status, 200);
    const dir = await tempDir('hw-claims-');
    await fs.mkdir(path.join(dir, 'research'), { recursive: true });
    await fs.writeFile(path.join(dir, 'research', 'report.md'), 'Solar passed 3 TW in 2026 [1]. Prices fell 12% [2].\n\n[1]: https://a.example.com/x\n[2]: https://b.example.org/y\n');
    const made = await t.call(OPERATOR, 'POST', '/api/sessions', { model: 'deepseek-flash', runtime: 'local', path: dir, mode: 'bypass' });
    const s = t.harness.sessions.get(made.body.id)!;
    const ev: HarnessEvent[] = [];
    s.subscribe(0, ({ event }) => ev.push(event));
    const store = (s as unknown as { sources: { recordFetch(e: { url: string; finalUrl: string; text: string }): Promise<unknown> } }).sources;
    await store.recordFetch({ url: 'https://a.example.com/x', finalUrl: 'https://a.example.com/x', text: 'Global solar passed 3 TW in 2026, a first.' });
    await store.recordFetch({ url: 'https://b.example.org/y', finalUrl: 'https://b.example.org/y', text: 'Prices rose 5% in 2026.' });
    t.ds.scripts.lead = [{ calls: [{ name: 'verify_claims', input: { path: 'research/report.md' } }] }, { text: 'Checked.' }];
    // The judge (on Claude) sees a claim and its passage only: its brief routes by the claim's words.
    t.an.scripts.main = [
      (req) => (/Prices fell 12%/.test(JSON.stringify(req.messages)) ? { text: '{"status": "contradicted", "why": "it says rose 5%"}' } : { text: '{"status": "supported", "quote": "solar passed 3 TW in 2026", "why": "it says so"}' }),
      (req) => (/Prices fell 12%/.test(JSON.stringify(req.messages)) ? { text: '{"status": "contradicted", "why": "it says rose 5%"}' } : { text: '{"status": "supported", "quote": "solar passed 3 TW in 2026", "why": "it says so"}' }),
    ];
    await s.send('[[lead]] Check the report.');
    await waitFor(() => ev.some((e) => e.kind === 'turn_end' && (!('agent' in e) || !e.agent)), 'the turn');
    const res = ev.find((e): e is Extract<HarnessEvent, { kind: 'tool_result' }> => e.kind === 'tool_result' && e.name === 'verify_claims')!;
    assert.equal(res.is_error, true);
    assert.match(res.content, /supported 1, partial 0, unsupported 0, contradicted 1[\s\S]*Fix or remove: claim 2 \(line 1, contradicted: it says rose 5%\)/);
    assert.equal(t.an.requests.length, 2, 'judged on Claude, one judge per claim');
    assert.equal(t.ds.requests.filter((r) => /<claim>/.test(JSON.stringify(r.messages))).length, 0, 'never on the conversation\'s own provider');
    assert.ok(!JSON.stringify(t.an.requests[0]!.messages).includes('Check the report'), 'the judge sees the claim and its passage, not the conversation');
    assert.match(await fs.readFile(path.join(dir, 'research', 'claims.md'), 'utf8'), /# Claim ledger for research\/report\.md/);
  } finally { await t.close(); }
});

test('the claims gate: only where a workflow names it (it calls models), fails on a contradicted claim with what to fix, and deep-research runs it before the fact-check', async () => {
  const h = await createHarness({ dataDir: await tempDir(), plugins: [path.join(here, '..', 'plugins', 'research')], search: null });
  try {
    const root = await tempDir();
    await fs.mkdir(path.join(root, 'research'));
    await fs.writeFile(path.join(root, 'research', 'report.md'), 'Prices fell 12% in 2026 [1].\n\n[1]: https://b.example.org/y\n');
    const host = new LocalHost(root);
    let verdict = '{"status": "contradicted", "why": "it says rose 5%"}';
    const services = { claims: (report: string) => verifyClaims(report, { text: async () => 'Prices rose 5% in 2026.', judge: async () => ({ text: verdict, by: 'j' }), parse: trailingJson }) } as unknown as ToolServices;
    const signal = new AbortController().signal;
    assert.ok(!(await runGates(h.registry, host, 'applicable', signal, services)).some((g) => g.name === 'claims'), 'not on every turn');
    const [bad] = await runGates(h.registry, host, ['claims'], signal, services);
    assert.deepEqual([bad!.pass, bad!.summary], [false, 'research/report.md: 1 claim(s), 1 unsupported or contradicted']);
    assert.match(bad!.details ?? '', /Fix or remove: claim 1 \(line 1, contradicted: it says rose 5%\)/);
    verdict = '{"status": "supported", "quote": "Prices rose 5% in 2026", "why": "x"}';
    assert.equal((await runGates(h.registry, host, ['claims'], signal, services))[0]!.pass, true);
    // At high stakes (min_sites 2) a supported claim on one site is not enough: the tool says which.
    const two = await h.registry.tools.get('verify_claims')!.run({ path: 'research/report.md', min_sites: 2 }, { host, signal, services } as unknown as import('../src/tools/types.ts').ToolContext);
    assert.equal(two.is_error, true);
    assert.match(two.content, /Backed by fewer than 2 independent sites[^:]*: claim 1 \(line 1\)/);
    const w = h.registry.workflows.get('deep-research')!;
    assert.deepEqual(validateWorkflow(w), []);
    const n = w.nodes as Record<string, { next?: { on?: Record<string, string> } | string; gates?: string[]; agent?: string }>;
    // After the ledger, a search for counter-evidence, then the fact-check (which reads it).
    assert.deepEqual([n['cite-check']!.next, n.ledger!.gates, n.ledger!.next, n.counter!.agent, n.counter!.next], [{ on: { pass: 'ledger', fail: 'fix-citations', exhausted: 'failed' } }, ['claims'], { on: { pass: 'counter', fail: 'fix-claims', exhausted: 'counter' } }, 'counter-evidence', 'fact-check']);
    // The end goes through the ledger again: "Report ready" only with no unsupported or contradicted claim left (seen live: a fact-checker approved with two left).
    const ends = Object.entries(w.nodes as Record<string, { next?: { on?: Record<string, string>; default?: string } }>).flatMap(([k, v]) => [...Object.values(v.next?.on ?? {}), v.next?.default].filter((x) => x === 'done').map(() => k));
    assert.deepEqual(ends, ['final-ledger']);
    assert.deepEqual([n['final-ledger']!.gates, n['final-ledger']!.next], [['claims'], { on: { pass: 'done', fail: 'fix-claims-final', exhausted: 'done-with-findings' } }]);
  } finally { await h.close(); }
});
