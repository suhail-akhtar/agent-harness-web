// core.diagrams (DESIGN section 16): the spec and its validation (good, broken and hostile input),
// the layouts (ELK and the layered fallback; stable between versions), flow sequencing and playback,
// the version diff behind the "changed" badges, the drawing in Node (every view), the code map, and
// the speed of a 300-node diagram. The Electron run is in desktop-diagrams-e2e.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DIAGRAM_LIMITS, PLAYBACK_START, describeDiff, diffDiagrams, flowFrame, neighbourhood, playback, resolveFlow, stringifyDiagram, subDiagram, summarizeDiagram, summaryLine, unconnected, validateDiagram, withPositions,
  type DiagramSpec,
} from '../packages/plugin-ui/src/diagram.ts';
import { codeMapSpec, folderDepth, type ImportScan } from '../apps/desktop/renderer/src/builtins/diagrams/codemap.ts';
import { askMessage } from '../apps/desktop/renderer/src/builtins/diagrams/api-pure.ts';
import { DEPLOYMENT_WITH_CACHE, DIAGRAMS, HOSTILE, bigDiagram, json } from './fixtures/desktop/diagrams.ts';
import { loadUi, renderAll } from './fixtures/desktop/load-ui.ts';

const spec = (v: unknown): DiagramSpec => { const r = validateDiagram(typeof v === 'string' ? v : json(v)); assert.ok(r.spec, r.error); return r.spec!; };
type Rect = { x: number; y: number; w: number; h: number };
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (a: Rect, b: Rect) => a.x >= b.x - 0.5 && a.y >= b.y - 0.5 && a.x + a.w <= b.x + b.w + 0.5 && a.y + a.h <= b.y + b.h + 0.5;

test('spec: every view of the fixtures validates cleanly; aliases are mapped; the clean copy is bounded', () => {
  for (const [name, d] of Object.entries(DIAGRAMS)) {
    const r = validateDiagram(json(d));
    assert.ok(r.spec, `${name}: ${r.error}`);
    assert.deepEqual(r.warnings, [], `${name} has no warnings`);
    assert.equal(r.spec!.view, d.view);
    assert.equal(r.spec!.nodes.length, d.nodes.length);
  }
  const loose = validateDiagram({ view: 'architecture', nodes: [{ id: 'db', type: 'postgres', label: 'Main DB', status: 'WIP' }, { id: 'u', kind: 'user', title: 'Ann' }, { id: 'x', kind: 'teleporter', title: 'X' }], edges: [{ source: 'u', target: 'db', style: 'dashed', cardinality: 'N:1' }] });
  assert.ok(loose.spec, loose.error);
  assert.equal(loose.spec!.view, 'container');
  assert.deepEqual(loose.spec!.nodes.map((n) => [n.kind, n.title, n.status ?? '']), [['relational-db', 'Main DB', 'in-progress'], ['person', 'Ann', ''], ['custom', 'X', '']]);
  assert.equal(loose.spec!.edges![0]!.async, true);
  assert.equal(loose.spec!.edges![0]!.cardinality, 'n:1');
  assert.match(loose.warnings.join('\n'), /"x" has kind "teleporter"; drawn as "custom"/);
  const long = validateDiagram({ view: 'flow', nodes: [{ id: 'a', title: 'T'.repeat(5000), description: 'd'.repeat(9000) }] });
  assert.ok(long.spec!.nodes[0]!.title.length <= DIAGRAM_LIMITS.title);
  assert.ok(long.spec!.nodes[0]!.description!.length <= DIAGRAM_LIMITS.description);
  // Control characters and bidirectional overrides never reach a label.
  assert.equal(validateDiagram({ view: 'flow', nodes: [{ id: 'a', title: 'evil‮exe.txt\u0007' }] }).spec!.nodes[0]!.title, 'evilexe.txt');
});

test('spec: broken and hostile input gives a readable error naming the mistake (unknown ids, cycles, sizes), never a throw', () => {
  const err = (v: unknown) => { const r = validateDiagram(v); assert.equal(r.spec, undefined, `expected an error for ${JSON.stringify(v).slice(0, 80)}`); return r.error!; };
  assert.match(err(HOSTILE.unknownEdge), /edge 1 \("sql"\) goes to "dbx", which is not a node id \(nodes: web, api\)/);
  assert.match(err(HOSTILE.unknownGroup), /node "proxy" is in group "dmzz", which is not a group id \(groups: dmz\)/);
  assert.match(err(HOSTILE.groupCycle), /contain each other in a cycle/);
  assert.match(err(HOSTILE.duplicateIds), /two nodes have the id "x"/);
  assert.match(err(HOSTILE.protoId), /"__proto__" cannot be an id/);
  assert.match(err(HOSTILE.badFlow), /flow "F" step 1 names edge "nope", which is not an edge id \(edges: ab\)/);
  assert.match(err(HOSTILE.notJson), /not valid JSON/);
  assert.match(err(HOSTILE.noNodes), /"nodes" is empty/);
  assert.match(err(HOSTILE.badView), /"view" is "galaxy": use one of context, container/);
  assert.match(err({ view: 'container', nodes: [{ id: 'a', title: 'A' }], edges: [{ from: 'a', to: 'g' }], groups: [{ id: 'g', kind: 'zone', label: 'G' }] }), /goes to "g", which is not a node id \(it is a group: connect a node inside it\)/);
  assert.match(err({ view: 'container', nodes: [{ id: 'a b', title: 'A' }] }), /may only use letters/);
  assert.match(err(null), /JSON object/);
  assert.match(err([1, 2]), /JSON object/);
  assert.match(err('   '), /empty/);
  // Bounded: huge graphs are refused with the bound they broke.
  assert.match(err(bigDiagram(DIAGRAM_LIMITS.nodes + 1, 10)), /601 nodes: at most 600/);
  assert.match(err(bigDiagram(50, DIAGRAM_LIMITS.edges + 1)), /2001 edges: at most 2000/);
  assert.match(err('x'.repeat(DIAGRAM_LIMITS.source + 1)), /KB of JSON; at most/);
  assert.match(err({ view: 'data', nodes: [{ id: 't', kind: 'table', title: 'T', fields: Array.from({ length: 201 }, (_, i) => ({ name: `c${i}` })) }] }), /201 fields: at most 200/);
  const deep = Array.from({ length: 10 }, (_, i) => ({ id: `g${i}`, kind: 'zone', label: `G${i}`, ...(i ? { parent: `g${i - 1}` } : {}) }));
  assert.match(err({ view: 'deployment', groups: deep, nodes: [{ id: 'n', title: 'N', group: 'g9' }] }), /nest more than 8 deep/);
  // Links: http(s) and workspace paths only.
  const links = validateDiagram(HOSTILE.badLinks);
  assert.deepEqual(links.spec!.nodes[0]!.links, [{ url: 'https://ok.example.com/x' }, { file: 'src/ok.ts' }]);
  assert.match(links.warnings.join(' '), /links other than http\(s\) addresses and workspace files were left out/);
  // Saved positions: only for nodes that exist, numbers only.
  const pos = validateDiagram({ view: 'flow', nodes: [{ id: 'a', title: 'A' }], layout: { positions: { a: { x: 1.4, y: 2 }, gone: { x: 0, y: 0 }, __proto__: { x: 1, y: 1 } } } });
  assert.deepEqual(pos.spec!.layout!.positions, { a: { x: 1, y: 2 } });
  assert.match(err({ view: 'flow', nodes: [{ id: 'a', title: 'A' }], layout: { positions: { a: { x: 'NaN', y: 0 } } } }), /finite numbers/);
});

test('render: script in labels stays text; a spec with unknown ids draws a readable error card, not a picture', async () => {
  const { ui, React } = await loadUi();
  const hostile = await renderAll(React.createElement(ui.DiagramBlock, { source: json(HOSTILE.scriptTitle) }));
  assert.deepEqual(hostile.errors, []);
  assert.doesNotMatch(hostile.html, /<script|<img|<svg onload|\sonerror="|\sonload="/i);
  assert.match(hostile.html, /&lt;script&gt;alert\(&quot;xss&quot;\)&lt;\/script&gt;|&lt;script&gt;alert\(“xss”\)/);
  const card = await renderAll(React.createElement(ui.DiagramBlock, { source: json(HOSTILE.unknownEdge) }));
  assert.match(card.html, /data-diagram-error/);
  assert.match(card.html, /This diagram could not be drawn/);
  assert.match(card.html, /goes to &quot;dbx&quot;, which is not a node id/);
  assert.doesNotMatch(card.html, /data-diagram-svg/);
  // Through Markdown (a ```diagram block): the same card, inside the artifact frame.
  const md = await renderAll(React.createElement(ui.Markdown, { text: `Here:\n\n\`\`\`diagram\n${json(HOSTILE.groupCycle)}\n\`\`\`` }));
  assert.match(md.html, /data-artifact="diagram"/);
  assert.match(md.html, /data-diagram-error/);
  const xss = await renderAll(React.createElement(ui.Markdown, { text: `\`\`\`diagram\n${json(HOSTILE.scriptTitle)}\n\`\`\`` }));
  assert.doesNotMatch(xss.html, /<script|<img|\sonerror="/i);
});

test('render: every view draws its nodes, groups, edges and labels (deployment zones, ER keys, code counts, flows)', async () => {
  const { ui, React } = await loadUi();
  for (const [name, d] of Object.entries(DIAGRAMS)) {
    const { html, errors } = await renderAll(React.createElement(ui.DiagramBlock, { source: json(d) }));
    assert.deepEqual(errors, [], name);
    assert.match(html, new RegExp(`data-diagram-block="${d.view}"`), name);
    assert.equal((html.match(/data-node-id="/g) ?? []).length, d.nodes.length, `${name}: every node`);
    assert.equal((html.match(/data-edge-id="/g) ?? []).length, (d as { edges?: unknown[] }).edges?.length ?? 0, `${name}: every edge`);
    assert.match(html, /Open interactive/);
  }
  const dep = (await renderAll(React.createElement(ui.DiagramBlock, { source: json(DIAGRAMS.deployment) }))).html;
  for (const t of ['DMZ ZONE', 'subnet dmz 10.42.10.0/24', 'VM-PROD-01', 'REVERSE PROXY', 'nginx 1.27 · TLS', '10.42.29.3:5432', 'https 443', 'RELATIONAL DATABASE']) assert.ok(dep.includes(t), `deployment shows ${t}`);
  assert.match(dep, /data-group-kind="host"/);
  assert.equal((dep.match(/data-group-kind="zone"/g) ?? []).length, 3);
  assert.match(dep, /data-status="done"/);
  assert.match(dep, /data-status="in-progress"/);
  assert.match(dep, /class="dg-card int"/, 'integrated systems are dashed');
  assert.match(dep, /data-kind="person"/);
  assert.match(dep, /data-findings="1"/);
  assert.match(dep, /dg-edge async/, 'asynchronous edges are dashed');
  const er = (await renderAll(React.createElement(ui.DiagramBlock, { source: json(DIAGRAMS.data) }))).html;
  for (const t of ['>PK<', '>FK<', '>UK<', '>pii<', '+ <!-- -->3<!-- --> more', 'citext', 'numeric(12,2)']) assert.ok(er.includes(t), `ER shows ${t}`);
  const code = (await renderAll(React.createElement(ui.DiagramBlock, { source: json(DIAGRAMS.code) }))).html;
  assert.match(code, />64</, 'import counts on the edges');
  assert.match(code, /FOLDER · 61 FILES/);
  const sum = (d: unknown) => summaryLine(summarizeDiagram(spec(d)), spec(d).view);
  assert.equal(sum(DIAGRAMS.container), '6 built · 2 integrated · 9 relations · 1 flow · 1 finding');
  assert.equal(sum(DIAGRAMS.deployment), '4 built · 2 integrated · 7 relations · 1 flow · 1 finding');
  assert.equal(sum(DIAGRAMS.data), '5 tables · 6 relations');
  assert.deepEqual(unconnected(spec(DIAGRAMS.code)), ['scripts', 'bench']);
  assert.deepEqual(unconnected(spec(DIAGRAMS.context)), ['erp']);
  // The canvas (server render): controls, legend, summary, the not-connected chip.
  const canvas = (await renderAll(React.createElement(ui.DiagramCanvas, { spec: spec(DIAGRAMS.context), onAsk: () => {} }))).html;
  for (const t of ['data-mode-button="overview"', 'data-mode-button="neighbourhood"', 'data-diagram-zoom-label', 'data-diagram-fit', 'data-diagram-details-toggle', "data-diagram-lonely=\"1\"", 'dashed = integrated / bought', 'dashed line = asynchronous', 'data-diagram-ask', 'data-diagram-zoom="in"', 'data-diagram-minimap']) assert.ok(canvas.includes(t), `canvas has ${t}`);
  assert.match(canvas, /1(<!-- -->)? not connected/);
  // Changed badges.
  const marked = (await renderAll(React.createElement(ui.DiagramBlock, { source: json(DEPLOYMENT_WITH_CACHE), changed: { nodes: ['cache'], edges: ['e3', 'e8'], note: 'v2: 1 added (Cache)' } }))).html;
  assert.equal((marked.match(/data-changed=""/g) ?? []).length, 1);
  assert.match(marked, /dg-edge new/);
  assert.match(marked, /v2: 1 added \(Cache\)/);
});

test('layout: groups hold their members and no boxes overlap, with ELK and with the layered fallback', async () => {
  const { ui } = await loadUi();
  for (const [name, d] of Object.entries(DIAGRAMS)) {
    const s = spec(d);
    for (const scene of [ui.layoutDiagramSync(s), await ui.layoutDiagram(s, { elk: ui.elkLayout })]) {
      const tag = `${name} (${scene.engine})`;
      for (let i = 0; i < scene.nodes.length; i++) for (let j = i + 1; j < scene.nodes.length; j++) assert.ok(!overlap(scene.nodes[i], scene.nodes[j]), `${tag}: ${scene.nodes[i].id} overlaps ${scene.nodes[j].id}`);
      for (const n of scene.nodes) if (n.parent) assert.ok(inside(n, scene.groups.find((g: { id: string }) => g.id === n.parent)), `${tag}: ${n.id} inside ${n.parent}`);
      for (const g of scene.groups) if (g.group.parent) assert.ok(inside(g, scene.groups.find((x: { id: string }) => x.id === g.group.parent)), `${tag}: group ${g.id} inside ${g.group.parent}`);
      for (const e of scene.edges) {
        assert.ok(e.points.length >= 4, `${tag}: ${e.id} is routed`);
        for (let i = 2; i < e.points.length; i += 2) assert.ok(Math.abs(e.points[i] - e.points[i - 2]) < 0.6 || Math.abs(e.points[i + 1] - e.points[i - 1]) < 0.6, `${tag}: ${e.id} is orthogonal`);
      }
    }
  }
  const elk = await ui.layoutDiagram(spec(DIAGRAMS.deployment), { elk: ui.elkLayout });
  assert.equal(elk.engine, 'elk');
  assert.ok(elk.edges.find((e: { id: string }) => e.id === 'e1').label.text === 'https 443');
});

test('layout is stable between versions: adding a node keeps every other box within a few px, and the new one lands by its neighbours', async () => {
  const { ui } = await loadUi();
  const before = spec(DIAGRAMS.deployment);
  const after = spec(DEPLOYMENT_WITH_CACHE);
  for (const engine of ['layered', 'elk'] as const) {
    const a = engine === 'elk' ? await ui.layoutDiagram(before, { elk: ui.elkLayout }) : ui.layoutDiagramSync(before);
    const b = await ui.layoutDiagram(after, { previous: a, elk: ui.elkLayout });
    assert.equal(b.engine, 'positions', 'the previous layout is kept');
    for (const n of a.nodes) {
      const m = b.nodes.find((x: { id: string }) => x.id === n.id);
      assert.ok(Math.abs(m.x - n.x) <= 2 && Math.abs(m.y - n.y) <= 2, `${engine}: ${n.id} stayed (${n.x},${n.y} -> ${m.x},${m.y})`);
    }
    const cache = b.nodes.find((x: { id: string }) => x.id === 'cache');
    for (const n of b.nodes) if (n.id !== 'cache') assert.ok(!overlap(cache, n), `${engine}: the cache does not sit on ${n.id}`);
    assert.ok(inside(cache, b.groups.find((g: { id: string }) => g.id === 'data')), `${engine}: the cache is in the data zone`);
    const web = b.nodes.find((x: { id: string }) => x.id === 'web'); const db = b.nodes.find((x: { id: string }) => x.id === 'db');
    const near = (p: Rect, q: Rect) => Math.hypot(p.x - q.x, p.y - q.y);
    assert.ok(near(cache, db) < 700 && near(cache, web) < 900, `${engine}: near its neighbours`);
    // Edges whose ends did not move keep their routes.
    const keep = a.edges.find((e: { id: string }) => e.id === 'e1'); const kept = b.edges.find((e: { id: string }) => e.id === 'e1');
    assert.deepEqual(kept.points, keep.points);
  }
  // Saved positions (a drag) win over any layout, exactly.
  const positions = { user: { x: 0, y: 0 }, proxy: { x: 300, y: 0 }, web: { x: 600, y: 0 }, backup: { x: 600, y: 200 }, db: { x: 900, y: 0 }, secrets: { x: 900, y: 200 }, bucket: { x: 1200, y: 200 } };
  const saved = spec(JSON.parse(withPositions(json(DIAGRAMS.deployment), positions)));
  const s = await ui.layoutDiagram(saved, { elk: ui.elkLayout });
  assert.equal(s.engine, 'positions');
  for (const [id, p] of Object.entries(positions)) { const n = s.nodes.find((x: { id: string }) => x.id === id); assert.deepEqual([n.x, n.y], [p.x, p.y], id); }
  // A drag moves one box: its edges re-route, its group re-fits, nothing else moves.
  const vg = ui.visibleGraph(saved);
  const moved = ui.moveNodes(s, vg, new Map([['web', { x: 640, y: 40 }]]));
  assert.deepEqual([moved.nodes.find((n: { id: string }) => n.id === 'web').x, moved.nodes.find((n: { id: string }) => n.id === 'db').x], [640, 900]);
  assert.notDeepEqual(moved.edges.find((e: { id: string }) => e.id === 'e2').points, s.edges.find((e: { id: string }) => e.id === 'e2').points);
  assert.deepEqual(moved.edges.find((e: { id: string }) => e.id === 'e6').points, s.edges.find((e: { id: string }) => e.id === 'e6').points);
});

test('positions are saved compactly into the spec JSON and read back', () => {
  const text = withPositions(json(DIAGRAMS.context), { rep: { x: 10.4, y: -3 }, crm: { x: 400, y: 20 } });
  assert.match(text, /"rep": \{ "x": 10, "y": -3 \}/);
  assert.deepEqual(validateDiagram(text).spec!.layout!.positions, { rep: { x: 10, y: -3 }, crm: { x: 400, y: 20 } });
  assert.equal(validateDiagram(text).spec!.nodes.length, DIAGRAMS.context.nodes.length);
  assert.ok(stringifyDiagram(spec(DIAGRAMS.flow)).startsWith('{\n  "version": 1,'));
});

test('flows: steps resolve to edges (replies run backwards), the frame lights the path so far, playback steps, pauses and stops at the end', () => {
  const s = spec(DIAGRAMS.deployment);
  const steps = resolveFlow(s, 'login');
  assert.deepEqual(steps.map((x) => [x.edge, x.reversed, x.from, x.to]), [['e1', false, 'user', 'proxy'], ['e2', false, 'proxy', 'web'], ['e4', false, 'web', 'secrets'], ['e3', false, 'web', 'db'], ['e3', true, 'db', 'web'], ['e1', true, 'proxy', 'user']]);
  assert.equal(steps[3]!.label, 'connect 10.42.20.5 -> 10.42.29.3:5432 as crm_app');
  assert.deepEqual(resolveFlow(s, 'nope'), []);
  assert.equal(flowFrame(steps, -1).shown.length, 0);
  const f2 = flowFrame(steps, 1);
  assert.deepEqual([...f2.lit].sort(), ['proxy', 'user', 'web']);
  assert.deepEqual([...f2.litEdges].sort(), ['e1', 'e2']);
  assert.equal(f2.current!.index, 1);
  assert.equal(flowFrame(steps, 99).shown.length, 6, 'clamped to the last step');
  // A step between nodes with no edge is drawn on its own (no edge id), with a warning.
  const free = validateDiagram({ view: 'flow', nodes: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }], flows: [{ id: 'f', title: 'F', steps: [{ from: 'a', to: 'b', label: 'hop' }] }] });
  assert.match(free.warnings.join(' '), /no edge between them/);
  assert.equal(resolveFlow(free.spec!, 'f')[0]!.edge, undefined);
  // Playback.
  let p = playback(PLAYBACK_START, { type: 'play' });
  assert.equal(p.playing, false, 'nothing to play before a flow is chosen');
  p = playback(p, { type: 'select', flow: 'login', length: steps.length });
  assert.deepEqual([p.step, p.playing], [-1, false]);
  p = playback(p, { type: 'play' });
  assert.deepEqual([p.step, p.playing], [0, true]);
  for (let i = 0; i < 4; i++) p = playback(p, { type: 'tick' });
  assert.deepEqual([p.step, p.playing], [4, true]);
  p = playback(p, { type: 'tick' });
  assert.deepEqual([p.step, p.playing], [5, false], 'stops on the last step');
  p = playback(p, { type: 'tick' });
  assert.equal(p.step, 5);
  p = playback(p, { type: 'play' });
  assert.deepEqual([p.step, p.playing], [0, true], 'playing at the end starts over');
  p = playback(p, { type: 'pause' });
  p = playback(p, { type: 'next' }); p = playback(p, { type: 'next' });
  assert.deepEqual([p.step, p.playing], [2, false]);
  p = playback(p, { type: 'prev' }); p = playback(p, { type: 'prev' }); p = playback(p, { type: 'prev' }); p = playback(p, { type: 'prev' });
  assert.equal(p.step, -1, 'back to before the first step, no further');
  p = playback(p, { type: 'goto', step: 3 });
  assert.equal(p.step, 3);
  assert.equal(playback(p, { type: 'speed', speed: 2 }).speed, 2);
  assert.equal(playback(p, { type: 'speed', speed: 7 }).speed, 1, 'only the offered speeds');
  assert.deepEqual([playback(p, { type: 'reset' }).step, playback(p, { type: 'select', flow: null, length: 0 }).flow], [-1, null]);
});

test('version diff: the added and changed nodes get the badge; new edges are marked; a layout-only change marks nothing', () => {
  const a = spec(DIAGRAMS.deployment);
  const b = spec(DEPLOYMENT_WITH_CACHE);
  const d = diffDiagrams(a, b);
  assert.deepEqual(d.added, ['cache']);
  assert.deepEqual(d.changed, []);
  assert.deepEqual(d.removed, []);
  assert.deepEqual(d.edgesAdded.sort(), ['e3', 'e8']);
  assert.equal(d.edgesRemoved, 1, 'web -> db went');
  assert.deepEqual(d.marked, ['cache']);
  assert.equal(describeDiff(d, b), '1 added (Cache), 2 new relations, 1 relation removed');
  // A changed field marks that node.
  const c = spec({ ...DIAGRAMS.deployment, nodes: DIAGRAMS.deployment.nodes.map((n) => (n.id === 'db' ? { ...n, tech: 'PostgreSQL 17' } : n)) });
  assert.deepEqual(diffDiagrams(a, c).marked, ['db']);
  // Positions alone: nothing to mark.
  const moved = spec(JSON.parse(withPositions(json(DIAGRAMS.deployment), { web: { x: 1, y: 2 } })));
  const none = diffDiagrams(a, moved);
  assert.deepEqual([none.marked, none.edgesAdded, none.edgesRemoved], [[], [], 0]);
  assert.equal(describeDiff(none, moved), 'only the layout changed');
  const gone = diffDiagrams(b, a);
  assert.deepEqual(gone.removed, ['cache']);
});

test('neighbourhood: a node and N hops, as its own smaller diagram (groups around them, flows that fit)', () => {
  const s = spec(DIAGRAMS.deployment);
  assert.deepEqual([...neighbourhood(s, 'db', 1)].sort(), ['backup', 'db', 'web']);
  assert.deepEqual([...neighbourhood(s, 'db', 2)].sort(), ['backup', 'bucket', 'db', 'proxy', 'secrets', 'web']);
  const sub = subDiagram(s, neighbourhood(s, 'db', 1));
  assert.deepEqual(sub.nodes.map((n) => n.id), ['web', 'backup', 'db']);
  assert.deepEqual(sub.groups!.map((g) => g.id).sort(), ['app', 'data', 'host']);
  assert.deepEqual(sub.edges!.map((e) => e.id), ['e3', 'e5']);
  assert.equal(sub.flows!.length, 0, 'the login flow leaves the neighbourhood');
});

test('code map: files aggregate into folders deep enough to read, edges count imports, top folders group them', () => {
  const files = [
    ['src/core/session.ts', ['src/core/types.ts', 'src/tools/read.ts', 'src/util/log.ts']], ['src/core/types.ts', []], ['src/tools/read.ts', ['src/util/log.ts', 'src/core/types.ts']],
    ['src/util/log.ts', []], ['src/server/app.ts', ['src/core/session.ts', 'src/core/types.ts', 'packages/ui/src/index.ts']], ['packages/ui/src/index.ts', ['packages/ui/src/x.ts']], ['packages/ui/src/x.ts', []],
    ['scripts/build.mjs', []], ['main.py', ['pkg/a.py']], ['pkg/a.py', []],
  ] as const;
  const scan: ImportScan = { root: '.', files: files.map(([p, imports]) => ({ path: p, lang: p.endsWith('.py') ? 'py' : 'ts', lines: 100, imports: [...imports] })), external: [['react', 3]], truncated: false };
  assert.equal(folderDepth(scan, 80), 3);
  const s = codeMapSpec(scan, { title: 'demo - code map', maxNodes: 80 });
  const v = validateDiagram(json(s));
  assert.ok(v.spec, v.error);
  assert.equal(s.view, 'code');
  const ids = s.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ['_root', 'packages/ui/src', 'pkg', 'scripts', 'src/core', 'src/server', 'src/tools', 'src/util']);
  const edge = (a: string, b: string) => s.edges!.find((e) => e.from === a && e.to === b)?.count;
  assert.equal(edge('src/server', 'src/core'), 2);
  assert.equal(edge('src/core', 'src/tools'), 1);
  assert.equal(edge('src/tools', 'src/util'), 1);
  assert.equal(edge('_root', 'pkg'), 1);
  assert.equal(edge('src/core', 'src/core'), undefined, 'imports inside a folder are not edges');
  assert.deepEqual(s.groups!.map((g) => g.id), ['dir:src']);
  assert.equal(s.nodes.find((n) => n.id === 'src/core')!.group, 'dir:src');
  assert.equal(s.nodes.find((n) => n.id === 'src/core')!.title, 'core');
  assert.match(s.nodes.find((n) => n.id === 'src/core')!.tech!, /^2 files · 200 lines · ts$/);
  assert.deepEqual(s.nodes.find((n) => n.id === 'src/core')!.links!.map((l) => l.file), ['src/core/session.ts', 'src/core/types.ts']);
  assert.deepEqual(unconnected(s), ['scripts']);
  assert.match(s.description!, /Outside packages: react \(3\)/);
  // A tighter budget aggregates higher up.
  assert.deepEqual(codeMapSpec(scan, { maxNodes: 5 }).nodes.map((n) => n.id).sort(), ['_root', 'packages', 'pkg', 'scripts', 'src']);
});

test('the ask box message names the artifact and how to change it', () => {
  const m = askMessage('add a cache in front of the database', { id: 'crm-deploy-1a2b', title: 'CRM', version: 3 });
  assert.match(m, /^add a cache in front of the database/);
  assert.match(m, /id crm-deploy-1a2b, now v3/);
  assert.match(m, /artifact tool: get it first/);
  assert.match(m, /Keep the ids/);
  assert.match(askMessage('make it blue', { title: 'X' }), /Save the changed diagram as an artifact of kind "diagram"/);
});

test('speed: 300 nodes and 600 edges validate, lay out and draw quickly (ELK too)', async () => {
  const { ui, React } = await loadUi();
  const big = bigDiagram(300, 600);
  let t = performance.now();
  const s = spec(big);
  const tValidate = performance.now() - t;
  t = performance.now();
  const scene = ui.layoutDiagramSync(s);
  const tLayered = performance.now() - t;
  assert.equal(scene.nodes.length, 300);
  assert.equal(scene.edges.length, 600);
  t = performance.now();
  const elk = await ui.layoutDiagram(s, { elk: ui.elkLayout });
  const tElk = performance.now() - t;
  assert.equal(elk.engine, 'elk');
  t = performance.now();
  const { html, errors } = await renderAll(React.createElement(ui.DiagramDrawing, { scene: elk, view: 'container', fitToBox: true }));
  const tDraw = performance.now() - t;
  assert.deepEqual(errors, []);
  assert.equal((html.match(/data-node-id="/g) ?? []).length, 300);
  // A drag of one box re-routes only its edges.
  t = performance.now();
  for (let i = 0; i < 30; i++) ui.moveNodes(elk, ui.visibleGraph(s), new Map([['n7', { x: 100 + i, y: 50 }]]));
  const tDrag = (performance.now() - t) / 30;
  console.log(`300/600: validate ${tValidate.toFixed(0)} ms, layered ${tLayered.toFixed(0)} ms, ELK ${tElk.toFixed(0)} ms, draw ${tDraw.toFixed(0)} ms, a drag frame ${tDrag.toFixed(1)} ms`);
  assert.ok(tValidate < 500, `validate ${tValidate} ms`);
  assert.ok(tLayered < 5000, `layered ${tLayered} ms`);
  assert.ok(tElk < 30_000, `ELK ${tElk} ms`);
  assert.ok(tDrag < 50, `a drag frame ${tDrag} ms`);
});
