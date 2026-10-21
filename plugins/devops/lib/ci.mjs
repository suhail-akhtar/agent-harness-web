// GitHub Actions: workflow runs, a run's jobs and its failing step's log
// (trimmed to the error), re-running failed jobs, dispatching a workflow,
// watching a run to its end; actionlint for workflow files; and running a
// job's steps locally where the session's commands run. The API calls are
// made by the server (the plugin's declared hosts only) with a token from the
// Key Vault or HARNESS_GITHUB_TOKEN; the token never reaches the sandbox.

import { guard, need, parseJson, q, redact, relList, seconds, sh, tail, UserError, vaultHas } from './common.mjs';

export const API = () => (process.env.HARNESS_GITHUB_API?.trim() || 'https://api.github.com').replace(/\/$/, '');

/** owner/repo from a git remote URL. */
export function repoFromRemote(url) {
  const m = /github[^/:]*[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(url).trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
}

async function repoOf(input, ctx) {
  if (input.repo) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(String(input.repo))) throw new UserError(`repo must be owner/name (got "${input.repo}")`);
    return String(input.repo);
  }
  const r = await sh(ctx.host, 'git remote get-url origin 2>/dev/null', { signal: ctx.signal, timeoutMs: 15_000 });
  const repo = repoFromRemote(r.stdout);
  if (!repo) throw new UserError('No repo given and the workspace has no GitHub origin remote: pass "repo": "owner/name".');
  return repo;
}

/** The token: the named vault secret, else the vault's github-token, else HARNESS_GITHUB_TOKEN. */
async function tokenFor(ctx, input, api, purpose) {
  const vault = ctx.services?.vault;
  const name = input.token ? String(input.token) : (await vaultHas(ctx, 'github-token')) ? 'github-token' : undefined;
  if (name) {
    if (!vault) throw new UserError(`The token is to come from the Key Vault (${name}), and this server has no Key Vault for this session.`);
    try { return await vault.reveal(name, purpose); } catch (e) { throw new UserError(`The Key Vault refused ${name}: ${e.message}`); }
  }
  try { return api.secret('HARNESS_GITHUB_TOKEN') || undefined; } catch { return undefined; }
}

/** A GitHub API client for one call; errors read as the API said them, token redacted. */
export function github(api, token) {
  const call = async (method, p, body, { raw = false } = {}) => {
    const res = await api.fetch(`${API()}${p}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'harness-web-devops',
        ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) {
      const msg = parseJson(text)?.message ?? text.slice(0, 300);
      const hint = res.status === 401 ? ' (the token is missing or invalid)' : res.status === 403 ? ' (the token lacks permission, or the rate limit is reached: a token with actions:write/read for this repository)' : res.status === 404 ? ' (no such repository, run or workflow - or it is private and the token cannot see it)' : '';
      throw new UserError(`GitHub ${method} ${p}: ${res.status} ${redact(msg, token ? [token] : [])}${hint}`);
    }
    return raw ? text : text ? parseJson(text) : {};
  };
  return { get: (p, o) => call('GET', p, undefined, o), post: (p, b) => call('POST', p, b ?? {}) };
}

const when = (t) => (t ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') : '');
export const runLine = (r) => `#${r.id} ${r.name ?? r.display_title ?? ''} [${r.head_branch}] ${r.event} ${r.status}${r.conclusion ? `/${r.conclusion}` : ''} ${String(r.head_sha ?? '').slice(0, 7)} ${when(r.created_at)} attempt ${r.run_attempt ?? 1}`;

export function jobLines(jobs) {
  return jobs.map((j) => {
    const failed = (j.steps ?? []).filter((s) => s.conclusion === 'failure').map((s) => `step ${s.number} "${s.name}"`);
    return `job ${j.id} "${j.name}" ${j.status}${j.conclusion ? `/${j.conclusion}` : ''}${failed.length ? ` - failed at ${failed.join(', ')}` : ''}`;
  });
}

/**
 * A job's log trimmed to the error: timestamps stripped; from the start of the
 * step that failed (its ##[group]Run line) to the first ##[error], at most
 * `max` lines kept from the end, plus every other error line.
 */
export function trimLog(text, max = 70) {
  const lines = String(text).replace(/\r/g, '').split('\n').map((l) => l.replace(/^\uFEFF?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z ?/, ''));
  const errAt = lines.findIndex((l) => l.includes('##[error]'));
  if (errAt < 0) return lines.slice(-max).join('\n');
  let start = errAt;
  while (start > 0 && !/^##\[group\]/.test(lines[start])) start--;
  let slice = lines.slice(start, errAt + 1);
  if (slice.length > max) slice = [slice[0], `... (${slice.length - max} lines omitted)`, ...slice.slice(-max + 1)];
  const others = lines.slice(errAt + 1).filter((l) => l.includes('##[error]')).slice(0, 10);
  return [...slice, ...others].map((l) => l.replace(/^##\[group\]/, '> ').replace(/^##\[endgroup\]$/, '').replace(/^##\[error\]/, 'ERROR: ')).filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
}

/**
 * Runs a job's steps the way the runner would, where the session's commands
 * run: `run:` steps with bash -eo pipefail in their working directory with the
 * workflow, job and step env; ${{ matrix.x }} from the first matrix entry and
 * ${{ env.X }}; `uses:` steps are skipped (the runtime's own toolchain stands
 * in), as are steps that need secrets or run only on failure. Stops at the
 * first failing step. Prints __HW_RESULT__ and JSON.
 */
export const RUN_LOCAL_PY = String.raw`
import json, os, re, subprocess, sys
def done(o):
    print('__HW_RESULT__' + json.dumps(o)); sys.exit(0)
try:
    import yaml
except ImportError:
    done({'error': 'python3 here has no PyYAML (the ops sandbox image has it)'})
path, want = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else '')
step_timeout = int(sys.argv[3]) if len(sys.argv) > 3 else 600
try:
    wf = yaml.safe_load(open(path)) or {}
except Exception as e:
    done({'error': 'cannot read %s: %s' % (path, e)})
jobs = wf.get('jobs') or {}
if not jobs: done({'error': '%s has no jobs' % path})
job = want or next(iter(jobs))
if job not in jobs: done({'error': 'no job %s in %s (jobs: %s)' % (job, path, ', '.join(jobs))})
j = jobs[job] or {}
if j.get('uses'): done({'error': 'job %s calls a reusable workflow (%s); run that workflow\'s jobs instead' % (job, j['uses'])})
matrix = {}
m = (j.get('strategy') or {}).get('matrix') or {}
if isinstance(m, dict):
    for k, v in m.items():
        if k in ('include', 'exclude'): continue
        matrix[k] = v[0] if isinstance(v, list) and v else v
    inc = m.get('include')
    if isinstance(inc, list) and inc and isinstance(inc[0], dict):
        for k, v in inc[0].items(): matrix.setdefault(k, v)
notes = []
class NeedsSecret(Exception): pass
EXPR = re.compile(r'\$\{\{\s*(.*?)\s*\}\}')
def sub(s):
    def rep(mo):
        e = mo.group(1)
        if e.startswith('matrix.') and e[7:] in matrix: return str(matrix[e[7:]])
        if e.startswith('env.'): return '$' + '{' + e[4:] + '}'
        if e.startswith('secrets.') or 'secrets.' in e: raise NeedsSecret(e)
        if e == 'github.workspace': return os.getcwd()
        if e == 'runner.os': return 'Linux'
        if e == 'runner.temp': return '/tmp'
        notes.append('unsupported expression [%s] replaced by an empty string' % e)
        return ''
    return EXPR.sub(rep, str(s))
def envmap(d):
    return {str(k): sub(v) for k, v in (d or {}).items()} if isinstance(d, dict) else {}
try:
    base = {**os.environ, 'CI': 'true', 'GITHUB_ACTIONS': 'true', 'GITHUB_WORKSPACE': os.getcwd(), **envmap(wf.get('env')), **envmap(j.get('env'))}
except NeedsSecret as e:
    done({'error': 'the job env needs %s: it cannot run here without it' % e})
defaults = ((j.get('defaults') or wf.get('defaults') or {}).get('run') or {})
results = []
for i, s in enumerate(j.get('steps') or []):
    s = s or {}
    name = str(s.get('name') or (s.get('run') or s.get('uses') or 'step %d' % (i + 1))).strip().split('\n')[0][:80]
    cond = str(s.get('if') or '')
    if re.search(r'failure\(\)|cancelled\(\)', cond):
        results.append({'name': name, 'status': 'skipped', 'note': 'runs only if: ' + cond}); continue
    if s.get('uses'):
        w = s.get('with') or {}
        results.append({'name': name, 'status': 'skipped', 'note': 'uses %s%s (an action: not run here; the local toolchain stands in)' % (s['uses'], (' with ' + json.dumps(w)) if w else '')}); continue
    if not s.get('run'): continue
    try:
        script = sub(s['run']); senv = envmap(s.get('env'))
    except NeedsSecret as e:
        results.append({'name': name, 'status': 'skipped', 'note': 'needs %s' % e}); continue
    shell = str(s.get('shell') or defaults.get('shell') or 'bash')
    if shell.startswith('python'): cmd = ['python3', '-c', script]
    elif shell.startswith('sh'): cmd = ['sh', '-e', '-c', script]
    else: cmd = ['bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', script]
    wd = s.get('working-directory') or defaults.get('working-directory') or '.'
    try:
        p = subprocess.run(cmd, cwd=wd, env={**base, **senv}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=step_timeout)
        out, code = p.stdout, p.returncode
    except subprocess.TimeoutExpired as e:
        out, code = (e.stdout or '') if isinstance(e.stdout, str) else '', 124
    except FileNotFoundError as e:
        out, code = str(e), 127
    results.append({'name': name, 'status': 'ok' if code == 0 else 'failed', 'exit': code, 'output': out[-6000:]})
    if code != 0: break
done({'job': job, 'jobs': list(jobs), 'matrix': matrix, 'steps': results, 'notes': sorted(set(notes))})
`;

/** The bash command that runs a job's steps locally. */
export const runLocalCommand = (file, job, stepTimeout = 600) => `python3 - ${q(file)} ${q(job ?? '')} ${Math.floor(stepTimeout)} <<'HW_RUN_LOCAL_PY'\n${RUN_LOCAL_PY}\nHW_RUN_LOCAL_PY`;

/** The run-local result as text, and whether every step that ran passed. */
export function formatRunLocal(res, file) {
  if (!res) return { ok: false, text: 'run-local gave no result.' };
  if (res.error) return { ok: false, text: `run-local: ${res.error}` };
  const failed = res.steps.find((s) => s.status === 'failed');
  const ran = res.steps.filter((s) => s.status !== 'skipped');
  const lines = res.steps.map((s) => `${s.status === 'ok' ? 'ok     ' : s.status === 'failed' ? 'FAILED ' : 'skipped'} ${s.name}${s.exit && s.status === 'failed' ? ` (exit ${s.exit})` : ''}${s.note ? ` - ${s.note}` : ''}`);
  const head = `${file} job ${res.job}${Object.keys(res.matrix ?? {}).length ? ` (matrix ${JSON.stringify(res.matrix)})` : ''}: ${failed ? `step "${failed.name}" failed` : ran.length ? `all ${ran.length} run step(s) passed` : 'no run steps'}`;
  return { ok: !failed && ran.length > 0, text: [head, ...lines, ...(res.notes?.length ? ['Notes:', ...res.notes.map((n) => `  ${n}`)] : []), ...(failed ? ['', `Output of "${failed.name}" (end):`, tail(failed.output, 60)] : [])].join('\n') };
}

/** actionlint's JSON as lines. */
export function actionlintLines(list) {
  return (Array.isArray(list) ? list : []).map((e) => `${e.filepath}:${e.line}:${e.column}: ${e.message} [${e.kind}]`);
}

export async function actionlint(host, files, signal) {
  const n = await need(host, 'actionlint', 'actionlint', signal);
  if (n.error) return { error: n.error };
  // Named files: without them actionlint looks for a git repository, which a workspace need not be.
  const args = files.length ? files.map(q).join(' ') : '$(ls .github/workflows/*.yml .github/workflows/*.yaml 2>/dev/null)';
  const r = await sh(host, `set -- ${args}; [ $# -gt 0 ] || { echo __NONE__; exit 0; }; actionlint -format '{{json .}}' "$@"`, { signal, timeoutMs: 120_000 });
  if (r.stdout.includes('__NONE__')) return { problems: [], none: true };
  const list = parseJson(r.stdout);
  if (!Array.isArray(list)) return { problems: r.code === 0 ? [] : [`actionlint failed (exit ${r.code}): ${tail(r.output, 10)}`] };
  return { problems: actionlintLines(list) };
}

async function failingLogs(gh, repo, jobs, max = 3) {
  const failed = jobs.filter((j) => j.conclusion === 'failure' || j.conclusion === 'timed_out').slice(0, max);
  const out = [];
  for (const j of failed) {
    let log;
    try { log = await gh.get(`/repos/${repo}/actions/jobs/${j.id}/logs`, { raw: true }); } catch (e) { out.push(`job "${j.name}": log not available (${e.message})`); continue; }
    const step = (j.steps ?? []).find((s) => s.conclusion === 'failure');
    out.push(`=== job ${j.id} "${j.name}"${step ? `, failed at step ${step.number} "${step.name}"` : ''} ===\n${trimLog(log)}`);
  }
  return out;
}

export async function runCi(input, ctx, api) {
  return guard(async () => {
    const { host, signal } = ctx;
    const action = String(input.action ?? '');
    if (action === 'lint') {
      const files = input.paths ? await relList(host, input.paths) : [];
      const r = await actionlint(host, files, signal);
      if (r.error) return r.error;
      if (r.none) return { content: 'No workflow files in .github/workflows.', is_error: true };
      return r.problems.length ? { content: `actionlint: ${r.problems.length} problem(s)\n${r.problems.join('\n')}`, is_error: true } : `actionlint: ${files.length ? files.join(', ') : 'every workflow in .github/workflows'} passed.`;
    }
    if (action === 'run-local') {
      const [file] = await relList(host, input.workflow?.includes('/') ? input.workflow : input.workflow ? `.github/workflows/${input.workflow}` : undefined);
      if (!file) return { content: 'run-local needs workflow: a file in .github/workflows (e.g. ci.yml).', is_error: true };
      const r = await sh(host, runLocalCommand(file, input.job, seconds(input.timeoutSec, 600, 3600)), { signal, timeoutMs: (seconds(input.timeoutSec, 600, 3600) + 60) * 1000 * 4 });
      const res = parseJson(r.stdout.split('__HW_RESULT__')[1]);
      if (!res) return { content: `run-local could not run (exit ${r.code}): ${tail(r.output, 20)}${/python3: (command )?not found/.test(r.output) ? '\nIt needs python3 with PyYAML (the ops sandbox image has both).' : ''}`, is_error: true };
      const f = formatRunLocal(res, file);
      return { content: f.text, is_error: !f.ok };
    }
    const repo = await repoOf(input, ctx);
    const token = await tokenFor(ctx, input, api, `ci ${action} on ${repo}`);
    const gh = github(api, token);
    const wf = input.workflow ? encodeURIComponent(String(input.workflow)) : undefined;
    const runId = input.runId !== undefined ? Math.floor(Number(input.runId)) : undefined;
    if (runId !== undefined && !(runId > 0)) return { content: 'runId must be a positive number', is_error: true };
    if (action === 'runs') {
      const qs = new URLSearchParams({ per_page: String(Math.min(Math.max(Number(input.limit) || 10, 1), 50)) });
      if (input.branch) qs.set('branch', String(input.branch));
      if (input.status) qs.set('status', String(input.status));
      const j = await gh.get(`/repos/${repo}${wf ? `/actions/workflows/${wf}` : '/actions'}/runs?${qs}`);
      const runs = j.workflow_runs ?? [];
      return runs.length ? `${repo}: ${runs.length} run(s), newest first:\n${runs.map(runLine).join('\n')}` : `${repo}: no workflow runs${input.branch ? ` on ${input.branch}` : ''}.`;
    }
    if (action === 'jobs' || action === 'logs') {
      if (input.jobId !== undefined) {
        const job = await gh.get(`/repos/${repo}/actions/jobs/${Math.floor(Number(input.jobId))}`);
        if (action === 'jobs') return jobLines([job]).join('\n');
        const logs = await failingLogs(gh, repo, [{ ...job, conclusion: job.conclusion ?? 'failure' }], 1);
        return { content: logs.join('\n\n'), untrusted: true };
      }
      if (!runId) return { content: `${action} needs runId (from {"action": "runs"}) or jobId.`, is_error: true };
      const run = await gh.get(`/repos/${repo}/actions/runs/${runId}`);
      const jobs = (await gh.get(`/repos/${repo}/actions/runs/${runId}/jobs?per_page=100&filter=latest`)).jobs ?? [];
      const head = `${runLine(run)}\n${jobLines(jobs).join('\n')}`;
      if (action === 'jobs') return head;
      const logs = await failingLogs(gh, repo, jobs);
      return { content: `${head}\n\n${logs.length ? logs.join('\n\n') : 'No failed job in this run.'}`, untrusted: true };
    }
    if (action === 'watch') {
      const deadline = Date.now() + seconds(input.timeoutSec, 600, 3600) * 1000;
      const every = seconds(input.intervalSec, 15, 120) * 1000;
      let run;
      for (;;) {
        if (runId) run = await gh.get(`/repos/${repo}/actions/runs/${runId}`);
        else {
          if (!input.branch) return { content: 'watch needs runId, or branch (and optionally sha) for the newest run on it.', is_error: true };
          const qs = new URLSearchParams({ branch: String(input.branch), per_page: '10' });
          const runs = (await gh.get(`/repos/${repo}${wf ? `/actions/workflows/${wf}` : '/actions'}/runs?${qs}`)).workflow_runs ?? [];
          run = runs.find((r) => !input.sha || String(r.head_sha).startsWith(String(input.sha)));
        }
        if (run?.status === 'completed') break;
        if (Date.now() + every > deadline) return { content: `Still ${run ? run.status : 'not started'} after the watch timeout${run ? `: ${runLine(run)}` : ''}. Watch again later.`, is_error: true };
        await new Promise((r, j) => { const t = setTimeout(r, every); signal?.addEventListener('abort', () => { clearTimeout(t); j(new Error('aborted')); }, { once: true }); });
      }
      const jobs = (await gh.get(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100&filter=latest`)).jobs ?? [];
      const ok = run.conclusion === 'success';
      const logs = ok ? [] : await failingLogs(gh, repo, jobs);
      return { content: `${ok ? 'PASSED' : 'FAILED'}: ${runLine(run)}\n${jobLines(jobs).join('\n')}${logs.length ? `\n\n${logs.join('\n\n')}` : ''}`, is_error: !ok, untrusted: !ok };
    }
    if (action === 'rerun-failed') {
      if (!runId) return { content: 'rerun-failed needs runId.', is_error: true };
      if (!token) return { content: 'Re-running jobs needs a token (Key Vault github-token, or HARNESS_GITHUB_TOKEN on the server).', is_error: true };
      await gh.post(`/repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`);
      return `Re-running the failed jobs of run #${runId} in ${repo}. Follow it with {"action": "watch", "runId": ${runId}}.`;
    }
    if (action === 'dispatch') {
      if (!wf) return { content: 'dispatch needs workflow: the workflow file name (ci.yml) or id.', is_error: true };
      if (!input.ref) return { content: 'dispatch needs ref: the branch or tag to run on.', is_error: true };
      if (!token) return { content: 'Dispatching a workflow needs a token (Key Vault github-token, or HARNESS_GITHUB_TOKEN on the server).', is_error: true };
      const inputs = Object.fromEntries(Object.entries(input.inputs ?? {}).map(([k, v]) => [k, String(v)]));
      await gh.post(`/repos/${repo}/actions/workflows/${wf}/dispatches`, { ref: String(input.ref), inputs });
      return `Dispatched ${input.workflow} on ${input.ref} in ${repo}. Follow it with {"action": "watch", "branch": "${input.ref}", "workflow": "${input.workflow}"}.`;
    }
    return { content: `Unknown action ${action}: use runs, jobs, logs, watch, rerun-failed, dispatch, lint or run-local.`, is_error: true };
  });
}

export const CI_REMOTE = new Set(['runs', 'jobs', 'logs', 'watch', 'rerun-failed', 'dispatch']);
export const CI_CHANGES = new Set(['rerun-failed', 'dispatch']);

export const ciParameters = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['runs', 'jobs', 'logs', 'watch', 'rerun-failed', 'dispatch', 'lint', 'run-local'] },
    repo: { type: 'string', description: 'owner/name (default: the workspace\'s GitHub origin remote)' },
    workflow: { type: 'string', description: 'Workflow file name (ci.yml) or id: filters runs; dispatch and run-local need it' },
    job: { type: 'string', description: 'run-local: job id in the workflow (default the first)' },
    branch: { type: 'string', description: 'runs/watch: branch' },
    sha: { type: 'string', description: 'watch: the commit whose run to wait for' },
    status: { type: 'string', description: 'runs: e.g. failure, success, in_progress' },
    limit: { type: 'number', description: 'runs: how many (default 10)' },
    runId: { type: 'number' },
    jobId: { type: 'number' },
    ref: { type: 'string', description: 'dispatch: branch or tag' },
    inputs: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] }, description: 'dispatch: workflow_dispatch inputs' },
    paths: { type: 'array', items: { type: 'string' }, description: 'lint: workflow files (default all of .github/workflows)' },
    token: { type: 'string', description: 'Key Vault secret name of the GitHub token (default: the vault\'s github-token, else the server\'s HARNESS_GITHUB_TOKEN)' },
    timeoutSec: { type: 'number', description: 'watch: how long to wait (default 600); run-local: per step (default 600)' },
    intervalSec: { type: 'number', description: 'watch: poll interval (default 15)' },
  },
  required: ['action'],
  additionalProperties: false,
};
