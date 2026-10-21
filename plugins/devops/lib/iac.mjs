// Terraform / OpenTofu: fmt, validate, plan (summarised by resource, destroys
// first, no values ever shown) and apply of an approved plan file only - the
// file's SHA-256 must equal the hash the user approved, checked in the same
// command that applies it. State is never printed.

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fromVault, guard, need, newId, parseJson, q, relIn, seconds, sh, tail, UserError } from './common.mjs';

export const PLAN_DIR = '.harness/devops/plans';

/**
 * Plans made in this server process. The plan file itself (which holds every
 * variable's value, TF_VAR_* secrets included) never stays where the session's
 * commands run: its bytes are kept here, per session (keyed by the session's
 * runtime), and handed to the apply command on stdin. The workspace gets a record
 * of names and counts only.
 */
const sessionPlans = new WeakMap();
export const plansFor = (host) => {
  let m = sessionPlans.get(host);
  if (!m) sessionPlans.set(host, (m = new Map()));
  return m;
};
/** What the permission prompt shows for an apply, and which vault entries it needs (no values, no plan bytes). */
export const planInfo = new Map();
/** The vault entries an iac call reads: plan's env, or the env its plan was made with. */
export function iacVaultNames(input) {
  const action = String(input.action ?? '');
  if (action === 'plan') return Object.values(input.env && typeof input.env === 'object' ? input.env : {}).filter((v) => typeof v === 'string' && v !== '');
  if (action === 'apply') return Object.values(planInfo.get(String(input.planHash ?? '').trim().toLowerCase())?.env ?? {});
  return [];
}

const TF = ['tofu', 'terraform'];
const TF_WHAT = 'OpenTofu or Terraform (tofu / terraform)';

const OFFLINE_HINT = 'Providers other than hashicorp/null, local and random (baked into the ops image) are downloaded from the registry, which needs the network: ask the operator for an allowlist network that includes registry.opentofu.org (or registry.terraform.io), or a provider mirror.';

/** jq, else Python: only addresses and actions from `show -json` (never values). */
const PLAN_FILTER = [
  'if command -v jq >/dev/null 2>&1; then',
  '  jq -c \'{rc: [.resource_changes[]? | {a: .address, m: .mode, t: .type, act: .change.actions, ri: (.action_reason // null)}], oc: [(.output_changes // {}) | to_entries[] | {n: .key, act: .value.actions}], drift: [.resource_drift[]? | {a: .address, act: .change.actions}], err: (.errored // false)}\'',
  'else',
  '  python3 -c \'import json,sys\nd=json.load(sys.stdin)\nc=lambda r:(r.get("change") or {}).get("actions")\nprint(json.dumps({"rc":[{"a":r.get("address"),"m":r.get("mode"),"t":r.get("type"),"act":c(r),"ri":r.get("action_reason")} for r in d.get("resource_changes") or []],"oc":[{"n":k,"act":(v or {}).get("actions")} for k,v in (d.get("output_changes") or {}).items()],"drift":[{"a":r.get("address"),"act":c(r)} for r in d.get("resource_drift") or []],"err":d.get("errored",False)}))\'',
  'fi',
].join('\n');

/**
 * The plan in a few lines: counts, destroys first and loud, every change by
 * address, outputs by name only, and drift.
 */
export function summarizePlan(p, { dir = '.', bin = 'tofu' } = {}) {
  const counts = { add: 0, change: 0, destroy: 0, replace: 0, read: 0, forget: 0 };
  const destroys = [];
  const lines = [];
  for (const r of p?.rc ?? []) {
    const act = (r.act ?? []).join(',');
    if (act === 'no-op' || !act) continue;
    let sym;
    if (act === 'create') { sym = '+'; counts.add++; }
    else if (act === 'update') { sym = '~'; counts.change++; }
    else if (act === 'delete') { sym = '-'; counts.destroy++; destroys.push(r.a); }
    else if (act === 'delete,create' || act === 'create,delete') { sym = act === 'delete,create' ? '-/+' : '+/-'; counts.add++; counts.destroy++; counts.replace++; destroys.push(`${r.a} (replaced)`); }
    else if (act === 'read') { sym = '<='; counts.read++; }
    else if (act === 'forget') { sym = '.'; counts.forget++; }
    else sym = act;
    lines.push({ sym, address: r.a, reason: r.ri });
  }
  const order = { '-': 0, '-/+': 1, '+/-': 1, '~': 2, '+': 3, '.': 4, '<=': 5 };
  lines.sort((a, b) => (order[a.sym] ?? 9) - (order[b.sym] ?? 9) || String(a.address).localeCompare(String(b.address)));
  const out = [`Plan for ${dir} (${bin}): ${counts.add} to add, ${counts.change} to change, ${counts.destroy} to destroy${counts.replace ? ` (${counts.replace} replaced)` : ''}${counts.forget ? `, ${counts.forget} to forget` : ''}.`];
  if (p?.err) out.push('WARNING: the plan errored part-way (it is incomplete).');
  if (destroys.length) out.push(`!! DESTROYS ${destroys.length} resource(s) - review these:`, ...destroys.slice(0, 50).map((d) => `   - ${d}`));
  if (lines.length) {
    out.push('Changes:', ...lines.slice(0, 120).map((l) => `  ${l.sym.padEnd(3)} ${l.address}${l.reason ? `  (${String(l.reason).replace(/_/g, ' ')})` : ''}`));
    if (lines.length > 120) out.push(`  ... and ${lines.length - 120} more`);
  } else out.push('No changes. The infrastructure matches the configuration.');
  const oc = (p?.oc ?? []).filter((o) => (o.act ?? []).join(',') !== 'no-op');
  if (oc.length) out.push(`Outputs changing (values not shown): ${oc.map((o) => `${o.n} (${(o.act ?? []).join('/')})`).join(', ')}`);
  const drift = p?.drift ?? [];
  if (drift.length) out.push(`Drift - changed outside this configuration since the last apply (${drift.length}): ${drift.slice(0, 20).map((d) => `${d.a} (${(d.act ?? []).join('/')})`).join(', ')}`);
  return { counts, destroys, text: out.join('\n'), changes: lines.length };
}

/** Diagnostics from `validate -json`, one line each with file:line. */
export function formatDiagnostics(v) {
  return (v?.diagnostics ?? []).map((d) => {
    const at = d.range ? `${d.range.filename}:${d.range.start?.line ?? '?'}: ` : '';
    return `${d.severity === 'error' ? 'ERROR' : 'WARNING'} ${at}${d.summary}${d.detail ? ` - ${String(d.detail).replace(/\s+/g, ' ').slice(0, 300)}` : ''}`;
  });
}

const varArgs = (vars) => Object.entries(vars ?? {}).map(([k, v]) => {
  if (!/^[A-Za-z_][\w-]*$/.test(k)) throw new UserError(`${k} is not a valid variable name`);
  return `-var ${q(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)}`;
}).join(' ');

async function varFileArgs(host, files, dir) {
  const out = [];
  for (const f of Array.isArray(files) ? files.slice(0, 10) : []) {
    const rel = await relIn(host, f);
    out.push(`-var-file=${q(path.posix.relative(dir === '.' ? '' : dir, rel) || rel)}`);
  }
  return out.join(' ');
}

/** Writes a small file into the workspace (with the runtime's shell on a companion). */
export async function writeWs(host, rel, text, signal) {
  if (host.kind !== 'companion') {
    const file = path.join(host.root, rel);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, text);
    return;
  }
  await sh(host, `mkdir -p ${q(path.posix.dirname(rel))} && printf '%s' ${q(Buffer.from(text).toString('base64'))} | base64 -d > ${q(rel)}`, { signal, timeoutMs: 30_000 });
}

/** Validates each module directory; the result per directory. */
export async function validateDir(host, bin, dir, signal) {
  const r = await sh(host, `cd ${q(dir)} && { ${bin} init -backend=false -input=false -no-color > /tmp/hw-tf-init.$$ 2>&1 || { echo __INIT_FAILED__; tail -n 40 /tmp/hw-tf-init.$$; rm -f /tmp/hw-tf-init.$$; exit 3; }; rm -f /tmp/hw-tf-init.$$; ${bin} validate -json -no-color; }`, { signal, timeoutMs: 600_000 });
  if (r.stdout.includes('__INIT_FAILED__')) {
    const why = tail(r.stdout.split('__INIT_FAILED__')[1] ?? r.output, 30);
    const offline = /Failed to (query|install)|could not connect|no such host|dial tcp|Could not retrieve the list of available versions|i\/o timeout/i.test(why);
    return { ok: false, initFailed: true, offline, text: `${dir}: init failed${offline ? ' (providers could not be downloaded)' : ''}:\n${why}${offline ? `\n${OFFLINE_HINT}` : ''}` };
  }
  const v = parseJson(r.stdout);
  if (!v) return { ok: false, text: `${dir}: validate gave no JSON (exit ${r.code}):\n${tail(r.output, 30)}` };
  const diags = formatDiagnostics(v);
  return v.valid
    ? { ok: true, text: `${dir}: valid${diags.length ? ` (${diags.length} warning(s))\n${diags.join('\n')}` : ''}` }
    : { ok: false, text: `${dir}: ${v.error_count} error(s)\n${diags.join('\n')}` };
}

/** Root module directories (with .tf files), outside .terraform and modules/ folders. */
export async function moduleDirs(host, signal, max = 8) {
  const r = await sh(host, "find . \\( -name .terraform -o -name .git -o -name node_modules -o -name .harness \\) -prune -o -type f -name '*.tf' -print 2>/dev/null | sed 's|/[^/]*$||' | sort -u | head -50", { signal, timeoutMs: 60_000 });
  return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/^\.\/?/, '') || '.').filter((d) => !/(^|\/)modules(\/|$)/.test(d)).slice(0, max);
}

async function plan(input, ctx, bin) {
  const { host, signal } = ctx;
  const dir = await relIn(host, input.dir);
  const env = input.env && typeof input.env === 'object' ? input.env : {};
  const secrets = await fromVault(ctx, env, `iac plan in ${dir}`);
  const id = newId();
  const args = [varArgs(input.vars), await varFileArgs(host, input.varFiles, dir), input.destroy === true ? '-destroy' : '', input.refresh === false ? '-refresh=false' : '', ...(Array.isArray(input.targets) ? input.targets.slice(0, 20).map((t) => `-target=${q(t)}`) : [])].filter(Boolean).join(' ');
  // The plan file is made in a private folder outside the workspace and removed by the same command:
  // its bytes come back to the server (base64), which keeps them for apply.
  const cmd = [
    '__pd=$(mktemp -d) || exit 97',
    'trap \'rm -rf "$__pd" "${__hw_t:-}"\' EXIT',
    `__log="$__pd/log"; __plan="$__pd/plan.tfplan"`,
    `cd ${q(dir)} || exit 2`,
    `${bin} init -input=false -no-color > "$__log" 2>&1 || { echo __INIT_FAILED__; tail -n 40 "$__log"; exit 3; }`,
    `${bin} plan -input=false -no-color -lock-timeout=60s -detailed-exitcode -out="$__plan" ${args} > "$__log" 2>&1; rc=$?`,
    'if [ $rc = 1 ]; then echo __PLAN_FAILED__; tail -n 60 "$__log"; exit 4; fi',
    `echo __PLAN_JSON__; ${bin} show -json -no-color "$__plan" | { ${PLAN_FILTER}\n}`,
    'echo __PLAN_SHA__; sha256sum "$__plan" | cut -d\' \' -f1',
    'echo __PLAN_B64__; base64 < "$__plan" | tr -d \'\\n\'; echo; echo __PLAN_END__',
  ].join('\n');
  const r = await sh(host, cmd, { signal, timeoutMs: seconds(input.timeoutSec, 900, 3600) * 1000, env: secrets, raw: true });
  if (r.stdout.includes('__INIT_FAILED__')) {
    const why = tail(r.stdout.split('__INIT_FAILED__')[1], 30);
    return { content: `${bin} init failed in ${dir}:\n${why}${/Failed to (query|install)|could not connect|no such host|dial tcp/i.test(why) ? `\n${OFFLINE_HINT}` : ''}`, is_error: true };
  }
  if (r.stdout.includes('__PLAN_FAILED__')) return { content: `${bin} plan failed in ${dir}:\n${tail(r.stdout.split('__PLAN_FAILED__')[1], 50)}`, is_error: true };
  if (r.timedOut) return { content: `${bin} plan timed out in ${dir}.`, is_error: true };
  const json = parseJson(r.stdout.split('__PLAN_JSON__')[1]?.split('__PLAN_SHA__')[0]);
  const hash = (r.stdout.split('__PLAN_SHA__')[1] ?? '').trim().split(/\s+/)[0];
  if (!json || !/^[0-9a-f]{64}$/.test(hash)) return { content: `Could not read the plan (exit ${r.code}):\n${tail(r.output, 30)}`, is_error: true };
  const bytes = Buffer.from((r.rawStdout.split('__PLAN_B64__')[1] ?? '').split('__PLAN_END__')[0].trim(), 'base64');
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== hash) return { content: `The plan file could not be brought back whole (${bytes.length} bytes; a plan over about 3 MB is too large to keep): nothing to apply. Plan a smaller part (targets) or a smaller module.`, is_error: true };
  const s = summarizePlan(json, { dir, bin });
  const entry = { id, hash, dir, bin, bytes, counts: s.counts, destroys: s.destroys, summary: s.text, env, destroyPlan: input.destroy === true, createdAt: Date.now() };
  plansFor(host).set(hash, entry);
  planInfo.set(hash, { hash, dir, counts: s.counts, destroys: s.destroys, env: { ...env } });
  const record = { id, hash, dir, bin, counts: s.counts, destroys: s.destroys, summary: s.text, env: Object.keys(env), destroyPlan: entry.destroyPlan, createdAt: entry.createdAt };
  await writeWs(host, `${PLAN_DIR}/${id}.json`, JSON.stringify(record, null, 1), signal);
  await writeWs(host, `${PLAN_DIR}/latest.json`, JSON.stringify(record, null, 1), signal);
  const applyHint = s.changes
    ? `To apply exactly this plan: iac {"action": "apply", "planHash": "${hash}"}${s.destroys.length ? ' with "allowDestroy": true (it destroys resources)' : ''}. The user approves it; the plan file is kept by the server (outside the workspace) until then.`
    : 'Nothing to apply.';
  await writeWs(host, `${PLAN_DIR}/latest.md`, `# Plan ${id}\n\n\`\`\`\n${s.text}\n\`\`\`\n\nsha256: \`${hash}\`\n`, signal);
  return `${s.text}\n\nPlan ${id} (kept by the server, outside the workspace)\nsha256: ${hash}\n${applyHint}`;
}

async function apply(input, ctx, bin) {
  const { host, signal } = ctx;
  const hash = String(input.planHash ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) return { content: 'apply needs planHash: the sha256 the plan action printed (the plan the user approved). Make a plan first with {"action": "plan"}.', is_error: true };
  const plans = plansFor(host);
  const entry = plans.get(hash);
  if (!entry) return { content: `No plan with sha256 ${hash.slice(0, 12)}... was made in this session (plans are kept until applied or the server restarts). Make the plan again with {"action": "plan"} and have it approved.`, is_error: true };
  if (entry.destroys.length && input.allowDestroy !== true) return { content: `This plan destroys ${entry.destroys.length} resource(s): ${entry.destroys.slice(0, 10).join(', ')}. Apply it only if destroying them is intended, with "allowDestroy": true.`, is_error: true };
  if (crypto.createHash('sha256').update(entry.bytes).digest('hex') !== hash) {
    plans.delete(hash);
    return { content: `Refused: the kept plan no longer matches the approved plan (sha256 ${hash.slice(0, 12)}...). Make a new plan and have it approved.`, is_error: true };
  }
  const secrets = await fromVault(ctx, entry.env, `iac apply in ${entry.dir}`);
  // The plan travels on stdin into the command's private folder, is checked against the approved hash there, and is gone when the command ends.
  const cmd = [
    'base64 -d < "$HW_TF_PLAN_B64" > "$__hw_t/plan.tfplan" || exit 5',
    `echo "${hash}  $__hw_t/plan.tfplan" | sha256sum -c --status - 2>/dev/null || { echo __HASH_MISMATCH__; exit 5; }`,
    `cd ${q(entry.dir)} || exit 2`,
    `${entry.bin} apply -input=false -no-color -lock-timeout=60s "$__hw_t/plan.tfplan" 2>&1`,
  ].filter(Boolean).join('\n');
  const r = await sh(host, cmd, { signal, timeoutMs: seconds(input.timeoutSec, 1800, 7200) * 1000, env: secrets, files: { HW_TF_PLAN_B64: entry.bytes.toString('base64') } });
  if (r.stdout.includes('__HASH_MISMATCH__')) {
    plans.delete(hash);
    return { content: `Refused: the plan that reached the command does not match the approved plan (sha256 ${hash.slice(0, 12)}...). Make a new plan and have it approved.`, is_error: true };
  }
  // Resource lines and the summary; output values are not repeated (names only).
  const lines = stripOutputs(r.output);
  if (r.code !== 0) return { content: `${entry.bin} apply failed (exit ${r.code}${r.timedOut ? ', timed out' : ''}) in ${entry.dir}:\n${tail(lines, 60)}\nThe plan is kept; a partial apply may have happened - run a new plan to see where things stand.`, is_error: true };
  plans.delete(hash);
  planInfo.delete(hash);
  await writeWs(host, `${PLAN_DIR}/last-apply.json`, JSON.stringify({ hash, dir: entry.dir, appliedAt: new Date().toISOString(), counts: entry.counts, destroys: entry.destroys }, null, 1), signal);
  return `Applied plan ${hash.slice(0, 12)}... in ${entry.dir}.\n${tail(lines, 40)}`;
}

/** Apply output without output values: "Outputs:" lines become names only. */
export function stripOutputs(text) {
  const out = [];
  let inOutputs = false;
  for (const line of String(text).split('\n')) {
    if (/^Outputs:\s*$/.test(line)) { inOutputs = true; out.push('Outputs (values not shown):'); continue; }
    if (inOutputs) {
      const m = /^([A-Za-z_][\w-]*)\s*=/.exec(line);
      if (m) out.push(`  ${m[1]}`);
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

export async function runIac(input, ctx) {
  return guard(async () => {
    const { host, signal } = ctx;
    const action = String(input.action ?? '');
    const pref = input.binary === 'terraform' ? ['terraform'] : input.binary === 'tofu' ? ['tofu'] : TF;
    const n = await need(host, pref, TF_WHAT, signal);
    if (n.error) return n.error;
    const bin = n.bin;
    if (action === 'fmt') {
      const dir = await relIn(host, input.dir);
      const r = await sh(host, `cd ${q(dir)} && ${bin} fmt ${input.write === true ? '' : '-check '}-recursive -list=true -no-color`, { signal, timeoutMs: 120_000 });
      const files = r.stdout.trim().split('\n').filter(Boolean);
      if (input.write === true) return r.code === 0 ? `${bin} fmt: ${files.length ? `formatted ${files.length} file(s): ${files.join(', ')}` : 'everything was already formatted'}` : { content: `${bin} fmt failed:\n${tail(r.output, 30)}`, is_error: true };
      if (r.code === 0) return `${bin} fmt: every file in ${dir} is formatted.`;
      if (r.code === 3 || files.length) return { content: `${bin} fmt: ${files.length} file(s) are not formatted: ${files.join(', ')}. Fix with {"action": "fmt", "write": true}.`, is_error: true };
      return { content: `${bin} fmt failed:\n${tail(r.output, 30)}`, is_error: true };
    }
    if (action === 'validate') {
      const dirs = input.dir ? [await relIn(host, input.dir)] : await moduleDirs(host, signal);
      if (!dirs.length) return { content: 'No .tf files in the workspace.', is_error: true };
      const res = [];
      for (const d of dirs) res.push(await validateDir(host, bin, d, signal));
      const bad = res.filter((x) => !x.ok);
      return { content: `${bin} validate: ${dirs.length - bad.length} of ${dirs.length} module(s) valid.\n${res.map((x) => x.text).join('\n')}`, is_error: bad.length > 0 };
    }
    if (action === 'plan') return plan(input, ctx, bin);
    if (action === 'apply') return apply(input, ctx, bin);
    return { content: `Unknown action ${action}: use fmt, validate, plan or apply.`, is_error: true };
  });
}

/** The permission prompt's line for an apply: the plan the user is approving. */
export function describeApply(input) {
  const e = planInfo.get(String(input.planHash ?? '').trim().toLowerCase());
  if (!e) return `apply plan ${String(input.planHash ?? '?').slice(0, 12)} (unknown plan: will be refused)`;
  const c = e.counts;
  return `APPLY plan ${e.hash.slice(0, 12)} in ${e.dir}: +${c.add} ~${c.change} -${c.destroy}${e.destroys.length ? ` DESTROYS ${e.destroys.slice(0, 5).join(', ')}${e.destroys.length > 5 ? '...' : ''}` : ''}`;
}

export const iacParameters = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['fmt', 'validate', 'plan', 'apply'] },
    dir: { type: 'string', description: 'The module directory (default: the workspace root; validate without dir checks every root module)' },
    binary: { type: 'string', enum: ['auto', 'tofu', 'terraform'], description: 'Default auto: tofu, else terraform' },
    write: { type: 'boolean', description: 'fmt: rewrite the files instead of checking' },
    vars: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] }, description: 'plan: non-secret -var values' },
    varFiles: { type: 'array', items: { type: 'string' }, description: 'plan: .tfvars files in the workspace' },
    env: { type: 'object', additionalProperties: { type: 'string' }, description: 'plan: environment variables from the Key Vault, { "AWS_ACCESS_KEY_ID": "<secret name>", "TF_VAR_db_password": "<secret name>" }. Values never appear in output; apply reuses them.' },
    targets: { type: 'array', items: { type: 'string' }, description: 'plan: -target addresses (exceptional use)' },
    destroy: { type: 'boolean', description: 'plan: a destroy plan' },
    refresh: { type: 'boolean', description: 'plan: false skips refreshing state' },
    planHash: { type: 'string', description: 'apply: the sha256 the plan printed - the plan the user approved' },
    allowDestroy: { type: 'boolean', description: 'apply: required when the plan destroys or replaces resources' },
    timeoutSec: { type: 'number' },
  },
  required: ['action'],
  additionalProperties: false,
};
