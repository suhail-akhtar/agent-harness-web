// Runbooks and whether they are safe to run: every change behind a human
// approval, every change followed by a verification. Two forms are checked:
// markdown runbooks (.harness/ops/runbooks/*.md, tagged steps) and workflows
// whose change nodes say so ("change": true) - verification there is a gate
// node or a node marked "verify": true.

export const TAGS = ['check', 'approval', 'change', 'verify'];

/** Parses a markdown runbook: title, sections, and the tagged numbered steps. */
export function parseRunbook(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const title = /^#\s+Runbook:\s*(.+)$/im.exec(text)?.[1]?.trim();
  const sections = {};
  let cur;
  let fence = false;
  for (const l of lines) {
    if (/^\s*```/.test(l)) fence = !fence;
    const h = !fence && /^##\s+(.+?)\s*$/.exec(l);
    if (h) { cur = h[1].toLowerCase(); sections[cur] = []; continue; }
    if (cur) sections[cur].push(l);
  }
  const steps = [];
  for (const l of sections.steps ?? []) {
    const m = /^\s*(\d+)[.)]\s+(?:\*\*)?\[([a-z]+)\](?:\*\*)?\s*(.*)$/i.exec(l);
    if (m) { steps.push({ n: Number(m[1]), tag: m[2].toLowerCase(), text: m[3] }); continue; }
    const plain = /^\s*(\d+)[.)]\s+(.*)$/.exec(l);
    if (plain) { steps.push({ n: Number(plain[1]), tag: '', text: plain[2] }); continue; }
    // An indented line continues the step above it.
    if (steps.length && /^\s{2,}\S/.test(l)) steps[steps.length - 1].text += `\n${l.trim()}`;
  }
  return { title, sections: Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, v.join('\n').trim()])), steps };
}

/** The runbook-safe rules for a markdown runbook: { errors, warnings, steps }. */
export function checkRunbook(text, file = 'runbook') {
  const rb = parseRunbook(text);
  const errors = []; const warnings = [];
  if (!rb.title) errors.push(`${file}: the title must be "# Runbook: <name>"`);
  if (!rb.steps.length) errors.push(`${file}: "## Steps" needs a numbered list of tagged steps ([check], [approval], [change], [verify])`);
  for (const s of rb.steps) if (!TAGS.includes(s.tag)) errors.push(`${file}: step ${s.n} has no tag (start it with ${TAGS.map((t) => `[${t}]`).join(', ')})`);
  let approvedSinceChange = false;
  let pendingVerify;
  for (const s of rb.steps) {
    if (s.tag === 'approval') approvedSinceChange = true;
    if (s.tag === 'verify') pendingVerify = undefined;
    if (s.tag === 'change') {
      if (pendingVerify) errors.push(`${file}: step ${pendingVerify.n} [change] is not verified before step ${s.n} changes something else (add a [verify] step after it)`);
      if (!approvedSinceChange) errors.push(`${file}: step ${s.n} [change] has no [approval] step before it${rb.steps.some((x) => x.tag === 'change' && x.n < s.n) ? ' since the previous change (one approval covers one change)' : ''}`);
      if (!/`[^`]+`/.test(s.text)) errors.push(`${file}: step ${s.n} [change] needs the exact command or tool call in backticks`);
      approvedSinceChange = false;
      pendingVerify = s;
    }
  }
  if (pendingVerify) errors.push(`${file}: step ${pendingVerify.n} [change] is the last change and nothing verifies it (add a [verify] step after it)`);
  const rollback = rb.sections.rollback;
  if (rb.steps.some((s) => s.tag === 'change') && !rollback) errors.push(`${file}: "## Rollback" is missing or empty: say how to undo each change`);
  for (const sec of ['when to use', 'preconditions', 'verify']) if (!(sec in rb.sections)) warnings.push(`${file}: no "## ${sec[0].toUpperCase()}${sec.slice(1)}" section`);
  return { errors, warnings, steps: rb.steps, title: rb.title };
}

const targets = (n) => (!n ? [] : typeof n === 'string' ? [n] : [...Object.values(n.on ?? {}), ...(n.default ? [n.default] : [])]);

/** Successors of a node, parallel branches included (a branch continues where its parallel node does). */
function successorsOf(w) {
  const parentOf = {};
  for (const [id, n] of Object.entries(w.nodes)) if (n.type === 'parallel') for (const b of n.branches ?? []) parentOf[b] = id;
  return (id, { skipApproveEdge = false } = {}) => {
    const n = w.nodes[id];
    if (!n) return [];
    let out;
    if (skipApproveEdge && n.type === 'approval') {
      const nx = n.next;
      out = typeof nx === 'string' ? [] : [...Object.entries(nx?.on ?? {}).filter(([k]) => k !== 'approve').map(([, v]) => v), ...(nx?.default ? [nx.default] : [])];
    } else out = targets(n.next);
    if (n.type === 'parallel') out = [...out, ...(n.branches ?? [])];
    if (parentOf[id]) out = [...out, ...targets(w.nodes[parentOf[id]].next)];
    return out;
  };
}

const isChange = (n) => n?.change === true || (n?.type === 'map' && n.node?.change === true);
const isVerify = (n) => n?.verify === true || n?.type === 'gate';

/**
 * The runbook-safe rules for a workflow: every node marked "change": true is
 * reachable only through an approval's "approve" edge, and from every change
 * a successful end is reachable only through a verify step.
 */
export function checkWorkflowSafety(w) {
  const errors = [];
  const nodes = w.nodes ?? {};
  const changes = Object.keys(nodes).filter((id) => isChange(nodes[id]));
  const succ = successorsOf(w);
  // From the start, never taking an approval's approve edge: any change reached is unapproved.
  const seen = new Set();
  const stack = [w.start];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id) || !nodes[id]) continue;
    seen.add(id);
    stack.push(...succ(id, { skipApproveEdge: true }));
  }
  for (const c of changes) if (seen.has(c)) errors.push(`${w.name}: change step "${c}" can run without passing an approval (put an approval node before it, and route only "approve" to it)`);
  // An approval approves the change right after it: two changes in a row need two approvals.
  for (const c of changes) {
    const after = new Set(); const st = succ(c);
    while (st.length) {
      const id = st.pop();
      if (after.has(id) || !nodes[id] || nodes[id].type === 'approval') continue;
      after.add(id);
      if (isChange(nodes[id]) && id !== c) { errors.push(`${w.name}: change step "${id}" follows change step "${c}" with no approval between them`); continue; }
      st.push(...succ(id));
    }
  }
  for (const c of changes) {
    const vis = new Set(); const st = succ(c);
    let unverified;
    while (st.length && !unverified) {
      const id = st.pop();
      if (vis.has(id) || !nodes[id]) continue;
      vis.add(id);
      const n = nodes[id];
      if (isVerify(n)) continue;
      if (n.type === 'end' && n.status !== 'failed') { unverified = id; break; }
      st.push(...succ(id));
    }
    if (unverified) errors.push(`${w.name}: after change step "${c}" the run can reach "${unverified}" without a verify step (a gate node or a node with "verify": true)`);
  }
  return { errors, changes };
}
