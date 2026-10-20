import type { Next, WorkflowDef } from './types.ts';

// A graph can be checked before it runs - one of the main reasons to use one.
// Every edge must point at a node, every node must be reachable from the
// start, an end must be reachable, and node fields must make sense.

function targets(n: Next | undefined): string[] {
  if (!n) return [];
  if (typeof n === 'string') return [n];
  return [...Object.values(n.on), ...(n.default ? [n.default] : [])];
}

export function validateWorkflow(w: WorkflowDef): string[] {
  const errors: string[] = [];
  const ids = Object.keys(w.nodes ?? {});
  if (!w.name || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(w.name)) errors.push('name must be a simple identifier');
  if (!w.nodes || !ids.length) return [...errors, 'a workflow needs nodes'];
  if (!w.nodes[w.start]) errors.push(`start node "${w.start}" does not exist`);
  const inBranch = new Set<string>();
  for (const [id, n] of Object.entries(w.nodes)) {
    if (n.type === 'parallel') {
      if (!n.branches?.length) errors.push(`${id}: parallel needs branches`);
      for (const b of n.branches ?? []) {
        const bn = w.nodes[b];
        if (!bn) errors.push(`${id}: branch "${b}" does not exist`);
        else if (bn.next) errors.push(`${id}: branch "${b}" must not have its own next (the parallel node routes)`);
        else if (bn.type === 'end' || bn.type === 'parallel' || bn.type === 'approval') errors.push(`${id}: branch "${b}" cannot be a ${bn.type} node`);
        inBranch.add(b);
      }
    }
    if (n.type === 'agent' && !n.prompt?.trim()) errors.push(`${id}: agent node needs a prompt`);
    if (n.type === 'gate' && !(n.gates === 'applicable' || (Array.isArray(n.gates) && n.gates.length))) errors.push(`${id}: gate node needs gates`);
    if (n.type === 'approval' && !n.message?.trim()) errors.push(`${id}: approval node needs a message`);
    if (n.type === 'shell' && !n.command?.trim()) errors.push(`${id}: shell node needs a command`);
    if (n.type === 'branch' && (!n.value?.trim() || typeof n.next === 'string')) errors.push(`${id}: branch node needs a value and next.on`);
    if (n.type !== 'end' && !inBranch.has(id) && !n.next) errors.push(`${id}: needs a next`);
    for (const t of targets(n.next)) if (!w.nodes[t]) errors.push(`${id}: next "${t}" does not exist`);
  }
  // Reachability from start, through edges and parallel branches.
  const seen = new Set<string>();
  const stack = [w.start];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id) || !w.nodes[id]) continue;
    seen.add(id);
    const n = w.nodes[id]!;
    stack.push(...targets(n.next));
    if (n.type === 'parallel') stack.push(...n.branches);
  }
  for (const id of ids) if (!seen.has(id)) errors.push(`${id}: not reachable from ${w.start}`);
  if (![...seen].some((id) => w.nodes[id]!.type === 'end')) errors.push('no end node is reachable');
  return errors;
}
