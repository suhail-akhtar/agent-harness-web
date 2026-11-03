// The desktop's agent platform, the parts that are pure: what the Agents panel knows of
// sub-agents (live events, stored history, trace), cost per model, what desktop_describe /
// desktop_open / desktop_command see and check, the workflow graph's layout, breadcrumbs and the
// first-run model recommendation. The UI itself is driven in test/desktop-e2e-agents.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateUiManifest } from '../packages/plugin-ui/src/index.ts';
import { fromHistory } from '../packages/client/src/index.ts';
import { buildRegistry, type PluginEntry } from '../apps/desktop/renderer/src/registry/registry.ts';
import { activityLine, addModelUsage, agentMs, agentsFromItems, costByModel, foldAgent, modelColor, stragglers, withLive, withTrace, type Agents } from '../apps/desktop/renderer/src/state/agents.ts';
import { commandRefusal, describeForAgent, resolveOpen } from '../apps/desktop/renderer/src/registry/agent-surface.ts';
import { edgePath, layoutWorkflow, nodeState } from '../apps/desktop/renderer/src/components/workflow-layout.ts';
import { crumbsFor, pageTitle } from '../apps/desktop/renderer/src/registry/crumbs.ts';
import { recommendedModel } from '../apps/desktop/renderer/src/state/recommend.ts';

const native = (name: string, contributes: Record<string, unknown>, extra: Partial<PluginEntry> = {}): PluginEntry => ({
  name, source: 'builtin', enabled: true, ui: validateUiManifest({ trust: 'native', displayName: name.replace('core.', '').replace(/^./, (c) => c.toUpperCase()), contributes }, { trustCeiling: 'native' }), native: { components: {} }, ...extra,
});
const third = (name: string, ui: Record<string, unknown>): PluginEntry => ({ name, source: 'installed', enabled: true, ui: validateUiManifest(ui), uiHash: 'h' });

test('sub-agents from live events: started (type, model, worktree), cost per call, tool calls, the end', () => {
  let a: Agents = {};
  const t0 = 1_000_000;
  a = foldAgent(a, { kind: 'notice', level: 'info', text: 'Started review-2 (review, claude-sonnet-5-5) in worktree hw-sub-review-2: Review the change', agent: 'review-2' }, t0);
  a = foldAgent(a, { kind: 'usage', model: 'claude-sonnet-5-5', usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 5, reasoning: 0 }, cost: 0.012, contextTokens: 10, contextWindow: 1, agent: 'review-2' }, t0 + 10);
  a = foldAgent(a, { kind: 'tool_call', id: 'x', name: 'read', input: {}, agent: 'review-2' }, t0 + 20);
  a = foldAgent(a, { kind: 'usage', model: 'claude-sonnet-5-5', usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 5, reasoning: 0 }, cost: 0.008, contextTokens: 10, contextWindow: 1, agent: 'review-2' }, t0 + 30);
  assert.deepEqual({ ...a['review-2'] }, { name: 'review-2', type: 'review', model: 'claude-sonnet-5-5', worktree: 'hw-sub-review-2', description: 'Review the change', status: 'running', startedAt: t0, cost: 0.02, calls: 2, tools: 1, last: 'read', activity: { doing: 'model', since: t0 + 30, retries: 0 } });
  a = foldAgent(a, { kind: 'turn_end', reason: 'done', agent: 'review-2' }, t0 + 4000);
  assert.equal(a['review-2']!.status, 'done');
  assert.equal(agentMs(a['review-2']!), 4000);
  // The main agent's events and unrelated notices change nothing.
  assert.equal(foldAgent(a, { kind: 'usage', model: 'm', usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 0 }, cost: 1, contextTokens: 1, contextWindow: 1 }), a);
  assert.equal(foldAgent(a, { kind: 'notice', level: 'info', text: 'Something else', agent: 'review-2' }), a);
  // A background agent is a task too.
  a = foldAgent(a, { kind: 'task', phase: 'started', task: { id: 'general-3', kind: 'agent', description: 'Index the docs', status: 'running', startedAt: t0, owner: 'main' } });
  assert.equal(a['general-3']!.background, true);
  a = foldAgent(a, { kind: 'task', phase: 'finished', task: { id: 'general-3', kind: 'agent', description: 'Index the docs', status: 'failed', startedAt: t0, endedAt: t0 + 5, owner: 'main', cost: 0.5 } });
  assert.equal(a['general-3']!.status, 'failed');
  assert.equal(a['general-3']!.cost, 0.5);
});

test('sub-agents from the stored history and the trace: id and worktree from the result, cost and model per agent', () => {
  const items = fromHistory([
    { role: 'user', content: [{ type: 'text', text: 'review' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_aaaa', name: 'agent', input: { description: 'Review', prompt: 'p', type: 'review', model: 'claude-sonnet-5-5' } }, { type: 'tool_use', id: 'call_bbbb', name: 'agent', input: { description: 'Look', prompt: 'p', run_in_background: true } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_aaaa', content: 'Found the off-by-one.\n\n(It worked in a git worktree: /w, branch hw-review-1, 1 commit(s). Review or merge that branch.)\n\n(agent id: review-1)' }, { type: 'tool_result', tool_use_id: 'call_bbbb', content: 'Started explore-2 in the background. Keep working.' }] },
  ] as never);
  let a = agentsFromItems(items, 'deepseek-flash');
  assert.deepEqual(Object.keys(a), ['review-1', 'explore-2']);
  assert.equal(a['review-1']!.worktree, 'hw-review-1');
  assert.equal(a['review-1']!.model, 'claude-sonnet-5-5');
  assert.equal(a['explore-2']!.model, 'deepseek-flash', 'no model named: the session\'s');
  assert.equal(a['explore-2']!.background, true);
  a = withTrace(a, [
    { type: 'model', at: 10, agent: 'review-1', model: 'claude-sonnet-5-5', ms: 1, usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 0 }, cost: 0.03, stop: 'end', retries: 0 },
    { type: 'tool', at: 20, agent: 'review-1', tool: 'read', ms: 1, error: false },
    { type: 'model', at: 30, agent: 'review-1', model: 'claude-sonnet-5-5', ms: 1, usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 0 }, cost: 0.02, stop: 'end', retries: 0 },
    { type: 'model', at: 30, agent: 'main', model: 'deepseek-flash', ms: 1, usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 0 }, cost: 0.001, stop: 'end', retries: 0 },
    { type: 'model', at: 40, agent: 'hook-check-4', model: 'deepseek-flash', ms: 1, usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 0 }, cost: 0.001, stop: 'end', retries: 0 },
  ]);
  assert.equal(a['review-1']!.cost, 0.05);
  assert.equal(a['review-1']!.calls, 2);
  assert.equal(a['review-1']!.tools, 1);
  assert.ok(!a.main && !a['hook-check-4'], 'the main agent and hook checks are not sub-agents');
});

test('a window opened mid-run: the server\'s live agents are running (not done after 1s), and a live call revives one the trace called done', () => {
  const span = (agent: string, at: number) => ({ type: 'model' as const, at, agent, model: 'deepseek-flash', ms: 1, usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 0 }, cost: 0.001, stop: 'tool_use', retries: 0 });
  // Two fan-out agents known only from the trace: both look done, from their first span to their last.
  let a = withTrace({}, [span('researcher-3', 1000), span('researcher-6', 1000), span('researcher-6', 5000)]);
  assert.equal(a['researcher-3']!.status, 'done');
  // The server says researcher-3 is at work since 500 (a fan-out child of the main agent, depth 1).
  a = withLive(withTrace(withLive({}, [{ name: 'researcher-3', type: 'researcher', model: 'deepseek-flash', startedAt: 500, parent: 'main', depth: 1, description: 'timelines' }]), [span('researcher-3', 1000)]), [{ name: 'researcher-3', type: 'researcher', model: 'deepseek-flash', startedAt: 500, parent: 'main', depth: 1 }]);
  assert.equal(a['researcher-3']!.status, 'running');
  assert.equal(a['researcher-3']!.startedAt, 500);
  assert.equal(a['researcher-3']!.endedAt, undefined);
  assert.equal(agentMs(a['researcher-3']!, 60_500), 60_000, 'its time runs from its start');
  // An older server (no live list): its next tool call shows it at work again.
  let b = withTrace({}, [span('researcher-6', 1000)]);
  b = foldAgent(b, { kind: 'tool_call', id: 't1', name: 'web_search', input: {}, agent: 'researcher-6' } as never, 9000);
  assert.equal(b['researcher-6']!.status, 'running');
  assert.equal(b['researcher-6']!.endedAt, undefined);
  assert.equal(b['researcher-6']!.calls, 1, 'the trace\'s model call kept');
  assert.equal(b['researcher-6']!.tools, 1, 'and the live tool call counted');
});

test('what a sub-agent at work is doing, in words: a tool and for how long, its model writing, waiting, or stalled with its retries', () => {
  let a = foldAgent({}, { kind: 'notice', level: 'info', text: 'Started researcher-3 (researcher, deepseek-flash): angle', agent: 'researcher-3' } as never, 0);
  a = foldAgent(a, { kind: 'tool_call', id: 't', name: 'web_fetch', input: {}, agent: 'researcher-3' } as never, 1000);
  assert.deepEqual(activityLine(a['researcher-3']!, 13_000), { text: 'running web_fetch · 12s', stalled: false });
  a = foldAgent(a, { kind: 'tool_result', id: 't', name: 'web_fetch', content: 'x', is_error: false, ms: 1, agent: 'researcher-3' } as never, 14_000);
  assert.deepEqual(activityLine(a['researcher-3']!, 44_000), { text: 'waiting on deepseek-flash · 30s', stalled: false });
  a = foldAgent(a, { kind: 'reasoning_delta', text: 'hm', agent: 'researcher-3' } as never, 50_000);
  assert.deepEqual(activityLine(a['researcher-3']!, 52_000), { text: 'writing', stalled: false });
  const same = foldAgent(a, { kind: 'text_delta', text: 'x', agent: 'researcher-3' } as never, 51_000);
  assert.equal(same, a, 'deltas within a few seconds change nothing (no re-render per token)');
  a = foldAgent(a, { kind: 'retry', attempt: 1, delayMs: 1000, reason: 'stream stalled for 180s (no reply yet)', agent: 'researcher-3' } as never, 240_000);
  assert.deepEqual(activityLine(a['researcher-3']!, 250_000), { text: 'no reply from deepseek-flash for 3m 20s · retry 1 (stream stalled for 180s (no reply yet))', stalled: true });
  a = foldAgent(a, { kind: 'turn_end', reason: 'done', agent: 'researcher-3' } as never, 260_000);
  assert.equal(activityLine(a['researcher-3']!, 261_000), undefined, 'nothing once it is done');
});

test('the swarm at a glance: stragglers are the agents at work well past their finished siblings', () => {
  const ag = (name: string, status: 'running' | 'done', startedAt: number, endedAt?: number) => ({ name, type: 'researcher', status, startedAt, ...(endedAt ? { endedAt } : {}), cost: 0, calls: 0, tools: 0 });
  const agents = [ag('r1', 'done', 0, 90_000), ag('r2', 'done', 0, 100_000), ag('r3', 'done', 0, 110_000), ag('r4', 'running', 0), ag('r5', 'running', 150_000)];
  assert.deepEqual([...stragglers(agents, 300_000)], ['r4'], 'r4 runs 300s against a 100s median; r5 only 150s');
  assert.deepEqual([...stragglers(agents.slice(0, 1).concat(agents[3]!), 300_000)], [], 'one finished sibling is no measure');
  assert.equal(modelColor('grok-4.7'), modelColor('grok-4.3'), 'one colour per company');
  assert.notEqual(modelColor('claude-sonnet-5-5'), modelColor('deepseek-flash'));
});

test('cost per model: the session\'s byModel, live usage added per model, most expensive first', () => {
  let by = addModelUsage(undefined, { kind: 'usage', model: 'deepseek-flash', usage: { input: 100, cacheRead: 50, cacheWrite: 0, output: 10, reasoning: 0 }, cost: 0.001, contextTokens: 1, contextWindow: 1 });
  by = addModelUsage(by, { kind: 'usage', model: 'claude-sonnet-5-5', usage: { input: 10, cacheRead: 0, cacheWrite: 5, output: 20, reasoning: 0 }, cost: 0.02, contextTokens: 1, contextWindow: 1, agent: 'review-1' });
  by = addModelUsage(by, { kind: 'usage', model: 'deepseek-flash', usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 10, reasoning: 0 }, cost: 0.002, contextTokens: 1, contextWindow: 1 });
  assert.deepEqual(costByModel(by), [
    { model: 'claude-sonnet-5-5', cost: 0.02, requests: 1, input: 15, output: 20, cacheRead: 0 },
    { model: 'deepseek-flash', cost: 0.003, requests: 2, input: 200, output: 20, cacheRead: 50 },
  ]);
});

const agentReg = () => buildRegistry([
  native('core.shell', { commands: [
    { id: 'palette', title: 'Palette', handler: 'p' },
    { id: 'set-theme', title: 'Theme', handler: 't', agent: { description: 'Switch theme', inputSchema: { type: 'object', properties: { theme: { type: 'string', maxLength: 80 } }, required: ['theme'] } } },
  ], themes: [{ id: 'paper', label: 'Paper', mode: 'light', background: '#fff', foreground: '#000', accent: '#c00' }] }),
  native('core.chat', { navItems: [{ id: 'new', title: 'New chat', view: 'home' }], views: [{ id: 'home', title: 'New chat', kind: 'native', component: 'H' }, { id: 'session', title: 'Conversation', kind: 'native', component: 'S' }], commands: [{ id: 'new', title: 'New chat', handler: 'n', agent: { description: 'Open a new chat', inputSchema: { type: 'object', properties: { prompt: { type: 'string' } } } } }] }),
  native('core.artifacts', { navItems: [{ id: 'library', title: 'Library', view: 'library' }], views: [{ id: 'library', title: 'Library', kind: 'native', component: 'L' }], panels: [{ id: 'artifacts', title: 'Artifacts', kind: 'native', component: 'P', where: 'session' }], renderers: [{ id: 'card', for: { event: 'artifact' }, kind: 'native', component: 'C' }] }),
  native('core.projects', { navItems: [{ id: 'projects', title: 'Projects', view: 'projects' }], views: [{ id: 'projects', title: 'Projects', kind: 'native', component: 'Ps' }, { id: 'project', title: 'Project', kind: 'native', component: 'P' }] }),
  native('core.plugins', { navItems: [{ id: 'plugins', title: 'Plugins', view: 'plugins' }], views: [{ id: 'plugins', title: 'Plugins', kind: 'native', component: 'P' }] }),
  native('core.settings', { settings: [{ id: 'models', title: 'Models', scope: 'operator', component: 'M', group: 'agent' }], views: [{ id: 'about-page', title: 'About', kind: 'native', component: 'A' }] }),
  third('acme-notes', { displayName: 'Acme Notes', trust: 'frame', contributes: { navItems: [{ id: 'board', title: 'Board', view: 'board' }], views: [{ id: 'board', title: 'Board', kind: 'frame', entry: 'ui/b.html' }], renderers: [{ id: 'n', for: { fence: 'note' }, kind: 'frame', entry: 'ui/n.html' }] } }),
  native('core.inbox', {}, { enabled: false }),
]);

test('desktop_describe: the live registry, compact - agent-callable commands with their args, what is on screen', () => {
  const d = describeForAgent(agentReg(), { view: 'core.chat:session', panel: 'core.artifacts:artifacts', split: null }, { name: 'Harness', version: '0.2.0' });
  assert.equal(d.app, 'Harness 0.2.0');
  assert.deepEqual(d.now, { view: 'core.chat:session', panel: 'core.artifacts:artifacts' });
  assert.deepEqual(d.commands.map((c) => c.id), ['core.shell:set-theme', 'core.chat:new'], 'only agent-callable commands');
  assert.ok(d.commands[0]!.args, 'with the schema of their args');
  assert.ok(d.panels.includes('core.artifacts:artifacts [conversation]'));
  assert.ok(d.views.includes('core.artifacts:library (Library)'));
  assert.deepEqual(d.off, ['core.inbox']);
  assert.deepEqual(d.renderers.fence, ['note']);
  assert.deepEqual(d.themes, ['light', 'dark', 'system', 'core.shell:paper']);
  assert.ok(JSON.stringify(d).length < 2500, `compact (${JSON.stringify(d).length} characters)`);
});

test('desktop_command: only agent-callable commands, args checked against their schema', () => {
  const r = agentReg();
  assert.equal(commandRefusal(r, 'core.shell:set-theme', { theme: 'dark' }), undefined);
  assert.match(commandRefusal(r, 'core.shell:palette', {})!, /not agent-callable/);
  assert.match(commandRefusal(r, 'core.nope:x', {})!, /No command core\.nope:x/);
  assert.match(commandRefusal(r, 'core.shell:set-theme', {})!, /args\.theme: is required/);
  assert.match(commandRefusal(r, 'core.shell:set-theme', { theme: 'dark', extra: 1 })!, /args\.extra: is not a field/);
  assert.match(commandRefusal(r, 'core.shell:set-theme', { theme: 'x'.repeat(81) })!, /args\.theme/);
});

test('desktop_open: views and panels resolved against the registry (full or short ids), files, artifacts, http(s) URLs only', () => {
  const r = agentReg();
  assert.deepEqual(resolveOpen(r, { target: 'view', id: 'core.artifacts:library' }), { target: 'view', view: 'core.artifacts:library' });
  assert.deepEqual(resolveOpen(r, { target: 'view', id: 'library' }), { target: 'view', view: 'core.artifacts:library' }, 'a short id that names one view');
  assert.deepEqual(resolveOpen(r, { target: 'view', id: 'core.chat:new' }), { target: 'view', view: 'core.chat:home' }, 'a nav item opens its view');
  assert.match((resolveOpen(r, { target: 'view', id: 'core.nope:x' }) as { error: string }).error, /No view "core\.nope:x"\. Views: .*core\.artifacts:library/);
  assert.deepEqual(resolveOpen(r, { target: 'panel', id: 'artifacts', params: { artifact: 'plan-1', n: 2, o: { x: 1 } } }), { target: 'panel', panel: 'core.artifacts:artifacts', params: { artifact: 'plan-1', n: '2' } });
  assert.deepEqual(resolveOpen(r, { target: 'file', path: 'src/a.ts' }), { target: 'file', path: 'src/a.ts' });
  assert.deepEqual(resolveOpen(r, { target: 'artifact', id: 'plan-1a2b' }), { target: 'artifact', id: 'plan-1a2b' });
  assert.match((resolveOpen(r, { target: 'artifact', id: '../x' }) as { error: string }).error, /needs id/);
  assert.deepEqual(resolveOpen(r, { target: 'url', url: 'https://example.com/a?b=1' }), { target: 'url', url: 'https://example.com/a?b=1' });
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'harness://app/api/sessions', 'mailto:a@b.c', 'not a url']) assert.ok('error' in resolveOpen(r, { target: 'url', url }), url);
  assert.ok('error' in resolveOpen(r, { target: 'shell' }));
});

test('workflow graph: layers from the start, side by side, loops drawn back around; node state from the history', () => {
  const nodes = [
    { id: 'plan', type: 'agent', agent: 'planner', model: 'claude-sonnet-5-5', next: ['build'] },
    { id: 'build', type: 'agent', next: ['test'] },
    { id: 'test', type: 'gate', next: ['review', 'build'] },
    { id: 'review', type: 'parallel', next: ['a', 'b', 'done'] },
    { id: 'a', type: 'agent' }, { id: 'b', type: 'agent' },
    { id: 'done', type: 'end' },
    { id: 'orphan', type: 'shell' },
  ];
  const l = layoutWorkflow(nodes, 'plan');
  assert.deepEqual(l.layers, [['plan'], ['build'], ['test'], ['review'], ['a', 'b', 'done'], ['orphan']]);
  assert.equal(l.edges.find((e) => e.from === 'test' && e.to === 'build')!.back, true, 'the fix loop goes back');
  assert.equal(l.edges.filter((e) => e.back).length, 1);
  assert.ok(l.nodes.a!.x < l.nodes.b!.x && l.nodes.b!.x < l.nodes.done!.x, 'a layer side by side');
  assert.equal(l.nodes.plan!.x, l.nodes.build!.x, 'a lone node is centred');
  assert.match(edgePath(l, l.edges.find((e) => e.back)!), /^M[\d.]+,[\d.]+ C/);
  assert.deepEqual(nodeState([{ node: 'build', status: 'failed', outcome: 'fail' }, { node: 'build', status: 'done', outcome: 'ok' }], 'build'), { status: 'done', outcome: 'ok', runs: 2 });
  assert.deepEqual(nodeState([], 'plan', 'plan'), { status: 'running', runs: 0 });
  assert.deepEqual(nodeState([], 'x'), { status: 'pending', runs: 0 });
  assert.deepEqual(layoutWorkflow([], undefined).layers, []);
});

test('breadcrumbs: page > subpage, never the same word twice; the window title follows the page', () => {
  const r = agentReg();
  assert.deepEqual(crumbsFor(r, { view: 'core.plugins:plugins' }, null), { title: 'Plugins' }, 'not "Plugins > Plugins"');
  assert.deepEqual(crumbsFor(r, { view: 'core.projects:project', params: { path: '/w' } }, { view: 'core.projects:project', title: 'my-app' }), { parent: { label: 'Projects', route: { view: 'core.projects:projects' } }, title: 'my-app' });
  assert.deepEqual(crumbsFor(r, { view: 'acme-notes:board' }, null), { parent: { label: 'Acme Notes' }, title: 'Board' }, 'a third-party page names its plugin');
  assert.deepEqual(crumbsFor(r, { view: 'core.settings:about-page' }, null), { title: 'About' });
  assert.deepEqual(crumbsFor(r, { view: 'core.chat:session' }, { view: 'core.projects:project', title: 'stale' }, 'Fix the bug'), { title: 'Fix the bug' }, 'a crumb of another page is ignored');
  assert.equal(pageTitle(r, { view: 'core.chat:home' }, null), '');
  assert.equal(pageTitle(r, { view: 'core.artifacts:library' }, null), 'Library');
});

test('first run: Claude Sonnet 5.5 is recommended with an Anthropic key, else DeepSeek Flash, else the first model with a key', () => {
  const m = (id: string, provider: string, available: boolean) => ({ id, provider, available });
  assert.equal(recommendedModel([m('deepseek-flash', 'deepseek', true), m('claude-sonnet-5-5', 'anthropic', true)])?.id, 'claude-sonnet-5-5');
  assert.equal(recommendedModel([m('deepseek-flash', 'deepseek', true), m('claude-sonnet-5-5', 'anthropic', false)])?.id, 'deepseek-flash');
  assert.equal(recommendedModel([m('deepseek-flash', 'deepseek', false), m('kimi-k2.6', 'moonshot', true)])?.id, 'kimi-k2.6');
  assert.equal(recommendedModel([m('deepseek-flash', 'deepseek', false)]), undefined);
});
