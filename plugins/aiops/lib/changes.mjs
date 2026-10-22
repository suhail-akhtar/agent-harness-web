// Change intelligence: one timeline of what changed - deploys, rollouts, Terraform
// applies, CI runs, commits, restarts, runbooks - in the framework's change journal
// (<data>/changes.jsonl, api.changes), and a tool that lays it out around an
// incident's start.
//
// What records into it:
//   - the devops tools (iac apply, k8s apply / rollout-undo, deploy up / down / rollback,
//     ci rerun-failed / dispatch), through ToolServices.changes;
//   - aiops: service_control changes and runbook workflow runs, seen in the session events;
//   - CI/CD: POST /api/plugins/aiops/changes/github (GitHub deployment, deployment_status,
//     workflow_run and push webhooks; X-Hub-Signature-256 checked with a vault secret
//     when the operator names one) and /api/plugins/aiops/changes (generic JSON);
//   - git commits of a workspace repository, imported on demand (change_timeline import-git).
// Alert incidents attach the changes of the window before them (lib/alerts.mjs).

import crypto from 'node:crypto';
import { CHANGE_KINDS, ChangeError } from '../../../src/ops/changes.ts';
import { runProgram } from './proc.mjs';
import { parseDuration } from './inventory.mjs';
import { alertConfig, toMs, webhookSecret } from './alerts.mjs';

const s = (v, max = 500) => (v === undefined || v === null ? '' : String(v)).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, max);
const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
const firstLine = (t) => s(String(t ?? '').split('\n')[0], 300);

/** sha256=<hex> of the raw body with the secret (GitHub's X-Hub-Signature-256). */
export function verifyGithub(raw, header, secret) {
  const want = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  const got = String(header ?? '');
  return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

/** The inventory service a repository belongs to (a service's optional `repo: owner/name`). */
function repoService(inv, repo) {
  if (!repo) return undefined;
  const r = repo.toLowerCase();
  return inv?.services?.find((x) => typeof x.repo === 'string' && x.repo.toLowerCase().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '') === r);
}

/** Changes from a GitHub webhook delivery (event name from X-GitHub-Event); [] for events that are not changes. */
export function githubChanges(event, p, inv) {
  const repo = s(p?.repository?.full_name, 200);
  const svc = repoService(inv, repo);
  const base = { target: repo || 'github', ...(svc ? { service: svc.name, ...(svc.env ? { env: svc.env } : {}) } : {}), source: 'github-webhook' };
  if (event === 'deployment' && p.deployment) {
    const d = p.deployment;
    return [{ ...base, kind: 'deploy', env: s(d.environment, 60) || base.env, summary: `deployment of ${s(d.ref, 100)}@${s(d.sha, 12)} to ${s(d.environment, 60)} created${d.description ? `: ${s(d.description, 300)}` : ''}`, by: s(d.creator?.login, 100) || 'github', at: toMs(d.created_at), ref: s(d.sha, 64) }];
  }
  if (event === 'deployment_status' && p.deployment_status) {
    const st = p.deployment_status; const d = p.deployment ?? {};
    if (!['success', 'failure', 'error'].includes(st.state)) return [];
    return [{ ...base, kind: 'deploy', env: s(st.environment ?? d.environment, 60) || base.env, summary: `deployment of ${s(d.ref, 100)}@${s(d.sha, 12)} to ${s(st.environment ?? d.environment, 60)}: ${st.state}${st.description ? ` - ${s(st.description, 300)}` : ''}`, by: s(st.creator?.login ?? d.creator?.login, 100) || 'github', at: toMs(st.created_at ?? st.updated_at), ref: s(st.target_url || st.log_url || d.sha, 500) }];
  }
  if (event === 'workflow_run' && p.workflow_run && p.action === 'completed') {
    const w = p.workflow_run;
    return [{ ...base, kind: 'ci-run', summary: `${s(w.name, 100)} on ${s(w.head_branch, 100)}@${s(w.head_sha, 12)}: ${s(w.conclusion, 30)} (${s(w.event, 30)})`, by: s(w.actor?.login ?? w.triggering_actor?.login, 100) || 'github', at: toMs(w.updated_at ?? w.run_started_at), ref: s(w.html_url, 500) }];
  }
  if (event === 'push' && Array.isArray(p.commits)) {
    return p.commits.slice(0, 50).map((c) => ({ ...base, kind: 'commit', summary: `${s(p.ref, 100).replace('refs/heads/', '')}: ${firstLine(c.message)}`, by: s(c.author?.username || c.author?.name, 100) || 'github', at: toMs(c.timestamp), ref: s(c.url || c.id, 500) }));
  }
  return [];
}

/** The generic change format: one change or {"changes": [...]}. */
export function genericChanges(body) {
  const list = Array.isArray(body) ? body : Array.isArray(body?.changes) ? body.changes : [body];
  if (!list.length || list.length > 200 || !list.every((x) => x && typeof x === 'object')) throw new ChangeError('expected a change object, a list, or {"changes": [...]} (200 at most)');
  return list.map((c) => ({ kind: s(c.kind, 30), target: s(c.target, 300), service: s(c.service, 120) || undefined, env: s(c.env, 60) || undefined, summary: s(c.summary, 2000), by: s(c.by, 200) || 'webhook', at: toMs(c.at), ref: s(c.ref ?? c.url, 1000) || undefined, source: 'webhook' }));
}

/** Ranks changes by how near they are to `around`. */
export function rankChanges(changes, around) {
  return changes.map((c) => ({ ...c, offsetMin: Math.round((c.at - around) / 60_000) })).sort((a, b) => Math.abs(a.offsetMin) - Math.abs(b.offsetMin) || b.at - a.at);
}

export function register(api, shared) {
  const cfg = alertConfig();
  const inventory = () => (shared.serverInventory ? shared.serverInventory().catch(() => undefined) : Promise.resolve(undefined));
  const record = async (list) => {
    let n = 0;
    for (const c of list) { await api.changes.record(c); n++; }
    return n;
  };

  api.registerRoute({
    method: 'POST', path: 'changes', auth: 'token',
    async handler(req) {
      let body;
      try { body = JSON.parse(req.body.toString('utf8') || 'null'); } catch { return { status: 400, body: { error: 'expected a JSON body' } }; }
      try { return { status: 202, body: { ok: true, recorded: await record(genericChanges(body)) } }; } catch (e) {
        if (e instanceof ChangeError) return { status: 400, body: { error: e.message, kinds: CHANGE_KINDS } };
        throw e;
      }
    },
  });

  api.registerRoute({
    method: 'POST', path: 'changes/github', auth: 'token',
    async handler(req) {
      let secret;
      try { secret = await webhookSecret(api, 'github', shared.vaultPatterns, cfg); } catch (e) { api.log(`changes: the GitHub webhook secret could not be read: ${e.message}`); return { status: 503, body: { error: 'the signing secret is not available' } }; }
      if (secret && !verifyGithub(req.body, req.headers['x-hub-signature-256'], secret)) return { status: 401, body: { error: 'bad or missing X-Hub-Signature-256' } };
      const event = req.headers['x-github-event'] ?? '';
      if (event === 'ping') return { status: 200, body: { ok: true, pong: true } };
      let body;
      try { body = JSON.parse(req.body.toString('utf8') || 'null'); } catch { return { status: 400, body: { error: 'expected a JSON body' } }; }
      try { return { status: 202, body: { ok: true, event, recorded: await record(githubChanges(event, body, await inventory())) } }; } catch (e) {
        if (e instanceof ChangeError) return { status: 400, body: { error: e.message } };
        throw e;
      }
    },
  });

  // service_control changes and runbook runs, from the session events (every session, whoever started it).
  const calls = new Map();
  const by = (e) => (e.owner ? `account:${e.owner}` : 'operator');
  api.events.subscribe(async (e) => {
    const ev = e.event;
    if (ev.kind === 'tool_call' && ev.name === 'service_control') {
      calls.set(`${e.sessionId}:${ev.id}`, ev.input);
      if (calls.size > 500) calls.delete(calls.keys().next().value);
      return;
    }
    if (ev.kind === 'tool_result' && ev.name === 'service_control') {
      const input = calls.get(`${e.sessionId}:${ev.id}`);
      calls.delete(`${e.sessionId}:${ev.id}`);
      const action = s(input?.action, 20);
      if (!input || !['restart', 'start', 'stop'].includes(action)) return;
      const svc = s(input.service, 120);
      const inv = await inventory();
      await api.changes.record({ kind: action === 'stop' ? 'other' : 'restart', target: svc, service: svc, env: inv?.services?.find((x) => x.name === svc)?.env, summary: `service_control ${action} ${svc}${ev.is_error ? ` (failed: ${firstLine(ev.content)})` : ''}`, by: by(e), source: `session:${e.sessionId}` });
      return;
    }
    if (ev.kind === 'workflow' && ev.phase === 'finished' && /^runbook-/.test(ev.run?.workflow ?? '')) {
      const r = ev.run;
      if (r.status === 'aborted' && !r.history?.some((h) => h.status === 'succeeded' && h.type === 'agent')) return;
      await api.changes.record({ kind: 'runbook', target: r.workflow, summary: `runbook ${r.workflow} ${r.status} (run ${r.id}; steps ${r.history?.map((h) => h.node).join(' > ') ?? ''})`.slice(0, 1900), by: by(e), source: `session:${e.sessionId}`, ref: r.id });
    }
  });

  shared.register({
    name: 'change_timeline',
    description: 'What changed around a time: deploys, Kubernetes applies and rollbacks, Terraform applies, CI runs, commits, restarts and runbooks, from the harness\'s change journal (the devops and aiops tools record their changes; CI/CD posts its deployments). "timeline" (default): the changes from `before` (default 2h) before `around` (an ISO time, default now; use the incident\'s start) to `after` (default 30m) after it, filtered by service/env/target, nearest first, with links. "import-git": records the commits of a git repository in the workspace (path, default the workspace) since `before` ago, so they show in the timeline.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['timeline', 'import-git'] }, service: { type: 'string' }, env: { type: 'string' }, target: { type: 'string' },
        around: { type: 'string', description: 'ISO time (default now)' }, before: { type: 'string', description: 'duration before (default 2h)' }, after: { type: 'string', description: 'duration after (default 30m)' },
        limit: { type: 'number' }, path: { type: 'string', description: 'import-git: the repository folder in the workspace' },
      },
      additionalProperties: false,
    },
    kind: 'read', parallelSafe: true, untrusted: true,
    availableIn: shared.configured,
    summarize: (i) => `change_timeline ${i.action ?? 'timeline'}${i.service ? ` ${i.service}` : ''}${i.around ? ` around ${i.around}` : ''}`,
    async run(input, ctx) {
      const beforeMs = parseDuration(s(input.before) || '2h');
      const afterMs = parseDuration(s(input.after) || '30m');
      if (!(beforeMs > 0) || !(afterMs >= 0)) return { content: 'before and after must be durations (e.g. 2h, 30m)', is_error: true };
      if (input.action === 'import-git') {
        if (ctx.host?.kind === 'companion') return { content: 'import-git reads a repository on the server; this session works on your computer.', is_error: true };
        let dir;
        try { dir = await api.workspacePath(ctx.host, s(input.path) || '.'); } catch (e) { return { content: e.message, is_error: true }; }
        const since = new Date(Date.now() - beforeMs).toISOString();
        const r = await runProgram('git', ['-C', dir, 'log', `--since=${since}`, '-n', '500', '--pretty=format:%H%x1f%an%x1f%aI%x1f%s'], { timeoutMs: 120_000, signal: ctx.signal });
        if (r.code !== 0) return { content: `git log failed: ${r.timedOut ? 'timed out after 2 minutes' : firstLine(r.error || r.stderr) || `exit code ${r.code}`}`, is_error: true };
        const remote = await runProgram('git', ['-C', dir, 'remote', 'get-url', 'origin'], { timeoutMs: 10_000, signal: ctx.signal });
        const target = s(remote.code === 0 ? remote.stdout.trim().replace(/^https?:\/\/[^@/]*@/, 'https://') : s(input.path) || 'workspace', 300);
        const known = new Set((await api.changes.query({ since: Date.now() - beforeMs - 86_400_000, limit: 5000 })).filter((c) => c.kind === 'commit').map((c) => c.ref));
        const fresh = r.stdout.split('\n').filter(Boolean).map((l) => l.split('\x1f')).filter(([sha]) => sha && !known.has(sha));
        for (const [sha, author, at, subject] of fresh) await api.changes.record({ kind: 'commit', target, ...(input.service ? { service: s(input.service, 120) } : {}), ...(input.env ? { env: s(input.env, 60) } : {}), summary: s(subject, 500) || '(no subject)', by: s(author, 100) || 'git', at: toMs(at), ref: sha, source: `git:${target}` });
        return `Recorded ${fresh.length} new commit(s) from ${target} since ${since}${fresh.length ? '' : ' (none new)'}.`;
      }
      const around = input.around ? toMs(input.around) : Date.now();
      if (!around) return { content: `"${input.around}" is not a time`, is_error: true };
      const list = await api.changes.query({ since: around - beforeMs, until: around + afterMs, service: s(input.service) || undefined, env: s(input.env) || undefined, target: s(input.target) || undefined, limit: 2000 });
      // Changes without a service (a module, a cluster) may still be the cause: shown too when filtering by service.
      const extra = input.service ? (await api.changes.query({ since: around - beforeMs, until: around + afterMs, env: s(input.env) || undefined, limit: 2000 })).filter((c) => !c.service && (!input.target || c.target.includes(s(input.target)))) : [];
      const ranked = rankChanges([...list, ...extra.filter((x) => !list.some((y) => y.id === x.id))], around).slice(0, Math.min(200, Math.max(1, Number(input.limit) || 30)));
      if (!ranked.length) return `No changes recorded from ${iso(around - beforeMs)} to ${iso(around + afterMs)}${input.service ? ` for ${input.service}` : ''}. (Changes are recorded by the devops and aiops tools and by CI/CD webhooks; change_timeline import-git records a repository's commits.)`;
      return [`${ranked.length} change(s) around ${iso(around)} (${s(input.before) || '2h'} before to ${s(input.after) || '30m'} after), nearest first - data recorded from tools and webhooks:`,
        ...ranked.map((c) => `- ${c.offsetMin <= 0 ? `${-c.offsetMin} min before` : `${c.offsetMin} min after`} (${iso(c.at)}) ${c.kind} ${c.target}${c.service ? ` [${c.service}${c.env ? `/${c.env}` : ''}]` : c.env ? ` [${c.env}]` : ''} by ${c.by}: ${c.summary}${c.ref ? ` <${c.ref}>` : ''}${c.source ? ` (from ${c.source})` : ''}`)].join('\n');
    },
  });
}
