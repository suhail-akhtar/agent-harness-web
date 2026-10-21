// The DevOps quality gates. Each applies only when its kind of file is in
// the workspace, runs where the session's commands run, and says "not checked"
// (advisory, never a pass) when its program is not installed there.

import { locate, missing, parseJson, q, sh, tail } from './common.mjs';
import { countLine, hadolint, trivy } from './container.mjs';
import { actionlint } from './ci.mjs';
import { moduleDirs, PLAN_DIR, summarizePlan, validateDir } from './iac.mjs';
import { findCharts, findManifests, kubeconform } from './k8s.mjs';

const PRUNE = ['node_modules', '.git', '.harness', '.terraform', 'vendor', 'dist', 'build', '.venv', 'venv', '__pycache__', 'coverage', 'target']
  .map((d) => `-name ${q(d)}`).join(' -o ');

/** Workspace files matching a find expression (paths without ./), outside dependencies and build output. */
export async function findFiles(host, expr, signal, max = 100) {
  const r = await sh(host, `find . \\( ${PRUNE} \\) -prune -o -type f \\( ${expr} \\) -print 2>/dev/null | head -${max}`, { signal, timeoutMs: 60_000 });
  return r.stdout.split('\n').map((l) => l.trim().replace(/^\.\//, '')).filter(Boolean);
}

const notChecked = (host, what) => ({ pass: false, severity: 'advisory', summary: `not checked: ${what} is not installed in this runtime`, details: missing(host, what) });
const has = async (host, expr, signal) => { try { return (await findFiles(host, expr, signal, 1)).length > 0; } catch { return false; } };

const TF = "-name '*.tf'";
const DOCKERFILES = "-name Dockerfile -o -name 'Dockerfile.*' -o -name '*.Dockerfile' -o -name Containerfile";
const SHELL = "-name '*.sh' -o -name '*.bash'";

/** The run's policy, written by a workflow's first step: { allowDestroy }. */
async function runPolicy(host, signal) {
  const r = await sh(host, 'cat .harness/devops/run-policy.json 2>/dev/null', { signal, timeoutMs: 15_000 });
  return parseJson(r.stdout) ?? {};
}

/** The latest plan the iac tool made, if its file is still there unchanged. */
async function latestPlan(host, signal) {
  const r = await sh(host, `f=${PLAN_DIR}/latest.json; [ -f "$f" ] || exit 1; cat "$f"`, { signal, timeoutMs: 15_000 });
  const p = parseJson(r.stdout);
  if (!p?.file || !/^[0-9a-f]{64}$/.test(String(p.hash))) return undefined;
  const c = await sh(host, `echo ${q(`${p.hash}  ${p.file}`)} | sha256sum -c --status - 2>/dev/null`, { signal, timeoutMs: 30_000 });
  return c.code === 0 ? p : undefined;
}

/** A plan made by the gate itself: no lock, a throwaway file, only addresses and actions read. */
async function freshPlan(host, bin, dir, signal) {
  const cmd = [
    `cd ${q(dir)} || exit 2`, 'p=$(mktemp -u).tfplan; l=$(mktemp)',
    `${bin} init -input=false -no-color > "$l" 2>&1 || { echo __INIT_FAILED__; tail -n 20 "$l"; rm -f "$l"; exit 3; }`,
    `${bin} plan -input=false -no-color -lock=false -out="$p" > "$l" 2>&1 || { echo __PLAN_FAILED__; tail -n 30 "$l"; rm -f "$l" "$p"; exit 4; }`,
    `echo __PLAN_JSON__; ${bin} show -json "$p" | python3 -c 'import json,sys\nd=json.load(sys.stdin)\nprint(json.dumps({"rc":[{"a":r.get("address"),"act":(r.get("change") or {}).get("actions")} for r in d.get("resource_changes") or []]}))' 2>/dev/null || ${bin} show -json "$p" | jq -c '{rc: [.resource_changes[]? | {a: .address, act: .change.actions}]}'`,
    'rm -f "$p" "$l"',
  ].join('\n');
  const r = await sh(host, cmd, { signal, timeoutMs: 900_000 });
  if (r.stdout.includes('__INIT_FAILED__') || r.stdout.includes('__PLAN_FAILED__')) return { error: tail(r.stdout.replace(/__(INIT|PLAN)_FAILED__/, ''), 20) };
  const json = parseJson(r.stdout.split('__PLAN_JSON__')[1]);
  return json ? { summary: summarizePlan(json, { dir, bin }) } : { error: tail(r.output, 10) };
}

export const gates = [
  {
    name: 'terraform-valid',
    description: 'Every Terraform/OpenTofu root module initialises (without its backend) and validates.',
    applies: (host, signal) => has(host, TF, signal),
    async run({ host, signal }) {
      const dirs = await moduleDirs(host, signal);
      if (!dirs.length) return { pass: true, summary: 'no .tf files in the workspace' };
      const bin = await locate(host, ['tofu', 'terraform'], signal);
      if (!bin) return notChecked(host, 'OpenTofu or Terraform');
      const res = [];
      for (const d of dirs) res.push(await validateDir(host, bin, d, signal));
      const bad = res.filter((r) => !r.ok && !r.offline);
      const offline = res.filter((r) => r.offline);
      if (!bad.length && offline.length) return { pass: false, severity: 'advisory', summary: `not checked: ${offline.length} module(s) need providers that could not be downloaded here`, details: offline.map((r) => r.text).join('\n') };
      return bad.length
        ? { pass: false, summary: `${bad.length} of ${dirs.length} module(s) invalid`, details: `${bad.map((r) => r.text).join('\n')}\nRun the iac tool: {"action": "validate"}.` }
        : { pass: true, summary: `${dirs.length} module(s) valid (${bin}): ${dirs.join(', ')}` };
    },
  },
  {
    name: 'tf-plan-no-destroy',
    description: 'The Terraform/OpenTofu plan destroys or replaces nothing (blocking unless the run allows destroys: .harness/devops/run-policy.json {"allowDestroy": true}, which the ship-change workflow writes from its input).',
    applies: (host, signal) => has(host, TF, signal),
    async run({ host, signal }) {
      const policy = await runPolicy(host, signal);
      const allowed = policy.allowDestroy === true;
      const latest = await latestPlan(host, signal);
      let destroys = [];
      let from;
      if (latest) {
        destroys = latest.destroys ?? [];
        from = `the approved-for-review plan ${latest.file} (sha256 ${latest.hash.slice(0, 12)})`;
      } else {
        const dirs = await moduleDirs(host, signal);
        if (!dirs.length) return { pass: true, summary: 'no .tf files in the workspace' };
        const bin = await locate(host, ['tofu', 'terraform'], signal);
        if (!bin) return notChecked(host, 'OpenTofu or Terraform');
        const errs = [];
        for (const d of dirs) {
          const p = await freshPlan(host, bin, d, signal);
          if (p.error) errs.push(`${d}: ${p.error}`);
          else destroys.push(...p.summary.destroys.map((x) => `${d}: ${x}`));
        }
        if (errs.length && !destroys.length) return { pass: false, severity: 'advisory', summary: 'not checked: a plan could not be made here (backend credentials or providers missing?)', details: `${errs.join('\n')}\nMake the plan with the iac tool (it takes Key Vault credentials); this gate then judges that plan.` };
        from = `a fresh plan of ${dirs.join(', ')}`;
      }
      if (!destroys.length) return { pass: true, summary: `no destroys in ${from}` };
      if (allowed) return { pass: true, severity: 'advisory', summary: `${destroys.length} destroy(s), allowed by this run`, details: destroys.join('\n') };
      return { pass: false, summary: `${destroys.length} resource(s) would be destroyed or replaced`, details: `${destroys.join('\n')}\nFrom ${from}. If this is intended, the run must allow destroys (ship-change input allowDestroy=yes); otherwise change the configuration (moved blocks, lifecycle prevent_destroy, avoid forcing replacement).` };
    },
  },
  {
    name: 'k8s-manifests-valid',
    description: 'Kubernetes manifests and rendered Helm charts validate against the Kubernetes schemas (kubeconform, strict: unknown fields are errors).',
    applies: async (host, signal) => { try { return (await findManifests(host, signal, 1)).length > 0 || (await findCharts(host, signal)).length > 0; } catch { return false; } },
    async run({ host, signal }) {
      const files = await findManifests(host, signal);
      const charts = await findCharts(host, signal);
      if (!files.length && !charts.length) return { pass: true, summary: 'no Kubernetes manifests or charts in the workspace' };
      if (!(await locate(host, 'kubeconform', signal))) return notChecked(host, 'kubeconform');
      const problems = [];
      const skipped = [];
      let valid = 0;
      if (files.length) {
        const rep = await kubeconform(host, files, signal);
        problems.push(...rep.lines); skipped.push(...rep.skipped); valid += rep.valid;
      }
      for (const c of charts) {
        if (!(await locate(host, 'helm', signal))) { problems.push(`chart ${c}: helm is not installed here, so it was not rendered`); continue; }
        const rep = await kubeconform(host, [], signal, { stdinCmd: `helm template hw ${q(c)}` });
        problems.push(...rep.lines.map((l) => `chart ${c}: ${l}`)); skipped.push(...rep.skipped); valid += rep.valid;
      }
      const note = skipped.length ? `\nNot validated (no schema here: CRDs or uncached kinds): ${skipped.slice(0, 20).join(', ')}` : '';
      return problems.length
        ? { pass: false, summary: `${problems.length} invalid resource(s)`, details: `${problems.join('\n')}${note}` }
        : { pass: true, summary: `${valid} resource(s) valid in ${files.length} file(s)${charts.length ? ` and ${charts.length} chart(s)` : ''}`, ...(note ? { details: note.trim() } : {}) };
    },
  },
  {
    name: 'dockerfile-lint',
    description: 'Dockerfiles pass hadolint: no errors or warnings (info and style are reported, not blocking).',
    applies: (host, signal) => has(host, DOCKERFILES, signal),
    async run({ host, signal }) {
      const files = await findFiles(host, DOCKERFILES, signal, 30);
      if (!files.length) return { pass: true, summary: 'no Dockerfiles in the workspace' };
      const h = await hadolint(host, files, signal);
      if (h.error) return /not installed/.test(h.error.content) ? notChecked(host, 'hadolint') : { pass: false, summary: 'hadolint failed', details: h.error.content };
      const { by, lines, blocking } = h.report;
      const sum = `${by.error} error(s), ${by.warning} warning(s), ${by.info} info, ${by.style} style in ${files.length} Dockerfile(s)`;
      return blocking ? { pass: false, summary: sum, details: lines.join('\n') } : { pass: true, summary: sum, ...(lines.length ? { details: lines.join('\n') } : {}) };
    },
  },
  {
    name: 'shell-lint',
    description: 'Shell scripts (*.sh, *.bash) pass shellcheck at warning level.',
    applies: (host, signal) => has(host, SHELL, signal),
    async run({ host, signal }) {
      const files = await findFiles(host, SHELL, signal, 200);
      if (!files.length) return { pass: true, summary: 'no shell scripts in the workspace' };
      if (!(await locate(host, 'shellcheck', signal))) return notChecked(host, 'shellcheck');
      const r = await sh(host, `shellcheck -f json1 -S warning ${files.map(q).join(' ')}`, { signal, timeoutMs: 300_000 });
      const j = parseJson(r.stdout);
      if (!j) return { pass: false, summary: `shellcheck failed (exit ${r.code})`, details: tail(r.output, 20) };
      const c = j.comments ?? [];
      return c.length
        ? { pass: false, summary: `${c.length} shellcheck problem(s) in ${new Set(c.map((x) => x.file)).size} of ${files.length} script(s)`, details: c.slice(0, 60).map((x) => `${x.file}:${x.line}:${x.column} ${x.level} SC${x.code}: ${x.message}`).join('\n') }
        : { pass: true, summary: `${files.length} script(s) pass shellcheck` };
    },
  },
  {
    name: 'workflow-lint',
    description: 'GitHub Actions workflows (.github/workflows) pass actionlint (syntax, expressions, runner labels, and shellcheck on run: scripts).',
    applies: async (host, signal) => (await sh(host, "ls .github/workflows/*.yml .github/workflows/*.yaml 2>/dev/null | head -1", { signal, timeoutMs: 15_000 })).stdout.trim() !== '',
    async run({ host, signal }) {
      const r = await sh(host, 'ls .github/workflows/*.yml .github/workflows/*.yaml 2>/dev/null', { signal, timeoutMs: 15_000 });
      const files = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      if (!files.length) return { pass: true, summary: 'no workflows in .github/workflows' };
      const a = await actionlint(host, files, signal);
      if (a.error) return notChecked(host, 'actionlint');
      return a.problems.length
        ? { pass: false, summary: `${a.problems.length} actionlint problem(s)`, details: a.problems.slice(0, 60).join('\n') }
        : { pass: true, summary: `${files.length} workflow(s) pass actionlint` };
    },
  },
  {
    name: 'iac-security',
    description: 'trivy config finds no HIGH or CRITICAL misconfiguration in Terraform, Kubernetes, Helm or Dockerfiles (lower severities reported, not blocking). Runs offline with trivy\'s built-in checks.',
    applies: async (host, signal) => (await has(host, `${TF} -o ${DOCKERFILES} -o -name Chart.yaml`, signal)) || (await findManifests(host, signal, 1).catch(() => [])).length > 0,
    async run({ host, signal }) {
      if (!(await locate(host, 'trivy', signal))) return notChecked(host, 'trivy');
      const t = await trivy(host, 'config', '.', signal);
      if (t.error) return { pass: false, summary: 'trivy config failed', details: t.error.content };
      const { counts, findings, high } = t.report;
      return high
        ? { pass: false, summary: `${high} HIGH/CRITICAL misconfiguration(s) (${countLine(counts)})`, details: findings.slice(0, 60).join('\n') }
        : { pass: true, summary: `no HIGH/CRITICAL misconfigurations (${countLine(counts)})`, ...(findings.length ? { details: findings.slice(0, 40).join('\n') } : {}) };
    },
  },
];

/** Files that must never be committed: Terraform state, kubeconfigs, keys, real .env files. */
const NEVER = /(^|\/)(terraform\.tfstate(\.backup)?|[^/]+\.tfstate|kubeconfig(\.ya?ml)?|\.kube\/config|id_(rsa|ecdsa|ed25519)|[^/]+\.(pem|p12|pfx|key)|\.env(\.(local|prod|production|staging))?|credentials\.json|service-account[^/]*\.json)$/i;

/**
 * secrets-in-repo: the quality-gates plugin's credential scan when that plugin
 * is there, plus the files a DevOps repository must never hold (state files
 * carry every secret Terraform touched), plus trivy's secret scanner.
 */
export async function secretsGate() {
  let base;
  try {
    const qg = await import('../../quality-gates/index.mjs');
    base = qg.gates?.find((g) => g.name === 'secrets');
  } catch { /* the quality-gates plugin is not installed */ }
  return {
    name: 'secrets-in-repo',
    description: `No credentials in the repository: ${base ? 'the quality-gates secrets scan, ' : ''}no Terraform state, kubeconfig, private key or .env files tracked (or about to be), and trivy's secret scanner.`,
    async run(ctx) {
      const { host, signal } = ctx;
      const problems = [];
      const passed = [];
      if (base) {
        const r = await base.run(ctx);
        if (r.pass) passed.push(`credential scan: ${r.summary}`);
        else problems.push(`credential scan: ${r.summary}${r.details ? `\n${r.details}` : ''}`);
      }
      // What git would commit (tracked plus untracked-not-ignored); without git, every file.
      const ls = await sh(host, `if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then git ls-files -co --exclude-standard; else find . \\( ${PRUNE} \\) -prune -o -type f -print | sed 's|^\\./||'; fi 2>/dev/null | head -20000`, { signal, timeoutMs: 120_000 });
      const bad = ls.stdout.split('\n').map((l) => l.trim()).filter((f) => f && NEVER.test(f) && !/\.(example|sample|template)$/i.test(f));
      if (bad.length) problems.push(`files that must not be in the repository (${bad.length}):\n${bad.slice(0, 30).join('\n')}\nRemove them, add them to .gitignore, and rotate what they held (a state file holds every secret Terraform touched).`);
      else passed.push('no state, kubeconfig, key or .env files');
      if (await locate(host, 'trivy', signal)) {
        const t = await trivy(host, 'fs', '.', signal, { vulns: false, only: 'secret' });
        if (t.error) problems.push(`trivy secret scan failed: ${t.error.content}`);
        else {
          const secrets = t.report.findings.filter((f) => / secret /.test(f));
          if (secrets.length) problems.push(`trivy found ${secrets.length} secret(s):\n${secrets.slice(0, 30).join('\n')}`);
          else passed.push('trivy: no secrets');
        }
      }
      return problems.length
        ? { pass: false, summary: `${problems.length} problem(s): possible credentials in the repository`, details: problems.join('\n\n') }
        : { pass: true, summary: passed.join('; ') };
    },
  };
}
