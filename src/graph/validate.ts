import { coerce, conditionRefs, FIELD_NAME, parseCondition, REDUCER_TYPE, REDUCERS, STATE_TYPES, templateRefs } from './state.ts';
import type { MapTemplate, Next, StateField, WorkflowDef, WorkflowNode } from './types.ts';

// A graph can be checked before it runs - one of the main reasons to use one.
// Every edge must point at a node, every node must be reachable from the
// start, an end must be reachable, and node fields must make sense. Declared
// state is checked too: field types and reducers, every write and output names
// a declared field, every {{state.x}} names a field or a node, and conditions parse.

function targets(n: Next | undefined): string[] {
  if (!n) return [];
  if (typeof n === 'string') return [n];
  return [...Object.values(n.on), ...(n.default ? [n.default] : [])];
}

const MAP_TEMPLATE_TYPES = ['agent', 'shell', 'code'];

/** Whether a workflow uses a node type anywhere, map templates included (trust checks: shell, code). */
export function usesNodeType(w: WorkflowDef, type: WorkflowNode['type']): boolean {
  return Object.values(w.nodes ?? {}).some((n) => n.type === type || (n.type === 'map' && n.node?.type === type));
}

function checkState(w: WorkflowDef, errors: string[]): Record<string, StateField> {
  const fields: Record<string, StateField> = {};
  if (w.state === undefined) return fields;
  if (!w.state || typeof w.state !== 'object' || Array.isArray(w.state)) { errors.push('state must be an object of fields'); return fields; }
  for (const [name, f] of Object.entries(w.state)) {
    const at = `state.${name}`;
    if (!FIELD_NAME.test(name)) { errors.push(`${at}: a field name is letters, digits and _ (not starting with a digit)`); continue; }
    if (w.nodes?.[name]) { errors.push(`${at}: a node has the same id, so {{state.${name}}} would be ambiguous; rename one`); continue; }
    if (!f || typeof f !== 'object') { errors.push(`${at}: needs { "type": ... }`); continue; }
    if (!STATE_TYPES.includes(f.type)) { errors.push(`${at}: type must be one of ${STATE_TYPES.join(', ')} (got ${JSON.stringify(f.type)})`); continue; }
    const reducer = f.reducer ?? 'replace';
    if (!REDUCERS.includes(reducer)) { errors.push(`${at}: reducer must be one of ${REDUCERS.join(', ')} (got ${JSON.stringify(f.reducer)})`); continue; }
    if (reducer !== 'replace' && REDUCER_TYPE[reducer] !== f.type) { errors.push(`${at}: the ${reducer} reducer needs a ${REDUCER_TYPE[reducer]} field, not a ${f.type}`); continue; }
    if (f.initial !== undefined) {
      const exact = { string: 'string', number: 'number', boolean: 'boolean' }[f.type as 'string'];
      const ok = exact ? typeof f.initial === exact : f.type === 'list' ? Array.isArray(f.initial) : !!f.initial && typeof f.initial === 'object' && !Array.isArray(f.initial);
      if (!ok) { errors.push(`${at}: initial ${JSON.stringify(f.initial)} is not a ${f.type}`); continue; }
      try { coerce(name, f, f.initial); } catch (e) { errors.push(`${at}: ${(e as Error).message}`); continue; }
    }
    fields[name] = f;
  }
  return fields;
}

export function validateWorkflow(w: WorkflowDef): string[] {
  const errors: string[] = [];
  const ids = Object.keys(w.nodes ?? {});
  if (!w.name || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(w.name)) errors.push('name must be a simple identifier');
  if (!w.nodes || !ids.length) return [...errors, 'a workflow needs nodes'];
  if (!w.nodes[w.start]) errors.push(`start node "${w.start}" does not exist`);
  const fields = checkState(w, errors);
  const declared = new Set(Object.keys(w.state ?? {}));

  /** References in a template: state.x must be a field or a node; item/index only in a map item; output only in writes. */
  const checkRefs = (where: string, refs: string[], ctx: { item: boolean; output: boolean }) => {
    for (const r of refs) {
      const [root, name] = r.split('.');
      if (root === 'state' && (!name || (!declared.has(name) && !w.nodes[name]))) errors.push(`${where}: {{${r}}} is not a declared state field or a node`);
      if ((root === 'item' || root === 'index') && !ctx.item) errors.push(`${where}: {{${r}}} only exists inside a map node's item`);
      if (root === 'output' && !ctx.output) errors.push(`${where}: {{${r}}} only exists in writes`);
    }
  };
  const checkWrites = (where: string, writes: unknown, item: boolean) => {
    if (writes === undefined) return;
    if (!writes || typeof writes !== 'object' || Array.isArray(writes)) { errors.push(`${where}: writes must be an object of field: template`); return; }
    for (const [k, t] of Object.entries(writes)) {
      if (!fields[k]) errors.push(`${where}: writes "${k}", which is not a declared state field`);
      if (typeof t !== 'string') errors.push(`${where}: writes.${k} must be a template string`);
      else checkRefs(`${where}: writes.${k}`, templateRefs(t), { item, output: true });
    }
  };
  /** The fields of one node that do work: shared by top-level nodes and map items. */
  const checkWork = (where: string, n: WorkflowNode | MapTemplate, item: boolean) => {
    const refs = (t: string | undefined) => checkRefs(where, templateRefs(t ?? ''), { item, output: false });
    if (n.type === 'agent') {
      if (!n.prompt?.trim()) errors.push(`${where}: agent node needs a prompt`);
      refs(n.prompt);
      if (n.outputs !== undefined) {
        if (!Array.isArray(n.outputs) || !n.outputs.length) errors.push(`${where}: outputs must be a list of declared state fields`);
        else for (const o of n.outputs) if (!fields[o]) errors.push(`${where}: outputs "${o}", which is not a declared state field`);
      }
    }
    if (n.type === 'shell') { if (!n.command?.trim()) errors.push(`${where}: shell node needs a command`); refs(n.command); }
    if (n.type === 'approval') refs(n.message);
    checkWrites(where, (n as { writes?: unknown }).writes, item);
  };

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
    if (n.type !== 'end') checkWork(id, n, false);
    if (n.type === 'gate' && !(n.gates === 'applicable' || (Array.isArray(n.gates) && n.gates.length))) errors.push(`${id}: gate node needs gates`);
    if (n.type === 'approval' && !n.message?.trim()) errors.push(`${id}: approval node needs a message`);
    if (n.type === 'branch') {
      const hasValue = typeof n.value === 'string' && !!n.value.trim();
      const hasWhen = typeof n.when === 'string' && !!n.when.trim();
      if (hasValue === hasWhen || typeof n.next === 'string' || !n.next) errors.push(`${id}: branch node needs a value or a when (one of them) and next.on`);
      if (hasValue) checkRefs(id, templateRefs(n.value!), { item: false, output: false });
      if (hasWhen) {
        try {
          for (const r of conditionRefs(parseCondition(n.when!))) checkRefs(`${id}: when`, [r], { item: false, output: false });
        } catch (e) { errors.push(`${id}: when "${n.when}": ${(e as Error).message}`); }
        if (typeof n.next === 'object' && n.next.on && !n.next.default && !(n.next.on.true && n.next.on.false)) errors.push(`${id}: a when branch routes "true" and "false" (or has a default)`);
      }
    }
    if (n.type === 'map') {
      if (typeof n.over !== 'string' || !n.over.trim()) errors.push(`${id}: map node needs over (a list, e.g. "{{state.items}}")`);
      else {
        checkRefs(`${id}: over`, templateRefs(n.over), { item: false, output: false });
        const one = /^\s*\{\{\s*state\.([a-zA-Z_]\w*)\s*\}\}\s*$/.exec(n.over);
        if (one && fields[one[1]!] && fields[one[1]!]!.type !== 'list') errors.push(`${id}: over names state.${one[1]}, a ${fields[one[1]!]!.type}, not a list`);
      }
      const t = n.node;
      if (!t || typeof t !== 'object' || !MAP_TEMPLATE_TYPES.includes(t.type)) errors.push(`${id}: map node needs a node (an agent, shell or code step) to run per item`);
      else {
        if ((t as { next?: unknown }).next !== undefined) errors.push(`${id}: the map's node must not have its own next (the map node routes)`);
        checkWork(`${id}.node`, t, true);
      }
      if (n.concurrency !== undefined && !(Number.isInteger(n.concurrency) && n.concurrency >= 1 && n.concurrency <= 50)) errors.push(`${id}: concurrency must be a whole number from 1 to 50`);
      if (n.collect !== undefined) {
        const f = fields[n.collect];
        if (!f) errors.push(`${id}: collect "${n.collect}" is not a declared state field`);
        else if (f.type !== 'list') errors.push(`${id}: collect "${n.collect}" must be a list field, not a ${f.type}`);
      }
    }
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
