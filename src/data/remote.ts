import { DataError, qid } from './engine.ts';
import type { DataHome } from './home.ts';
import type { DataService, PublishedEntry } from './service.ts';

// Publishing to another harness server: the dashboard, its model and its datasets' rows are posted
// to that server's /api/data/import with its token (a key vault entry here: the value never leaves
// this server's vault except as that request's Authorization header). No source, path or credential
// travels; the other server serves the page and gets fresh rows each time this one refreshes.

export async function pushRemote(svc: DataService, home: DataHome, doc: string, remote: { url: string; secret: string; access?: 'token' | 'signed-in' }, republish = false): Promise<{ url: string; slug: string; token?: string; id: string }> {
  let base: URL;
  try { base = new URL(remote.url); } catch { throw new DataError('remote.url is the other server\'s address, e.g. https://harness.example.com'); }
  if (base.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new DataError('a remote server is reached over https (http only on this machine)');
  const ctx = await svc.sourceContext(home);
  const token = await ctx.secret(remote.secret, `publish dashboard ${doc} to ${base.host}`);
  const cat = (await home.catalog()).spec;
  const { spec } = await home.doc(doc);
  const names = svc.docDatasets(spec, cat);
  const datasets: Array<{ name: string; columns: string[]; rows: unknown[][] }> = [];
  for (const n of names) {
    const plan = await svc.plan(home, cat, [n]);
    const r = await svc.engine.run({ files: plan.files, views: plan.views, vars: plan.vars, sql: `SELECT * FROM ${qid(n)}`, limit: 1_000_000 });
    if (r.truncated) throw new DataError(`dataset ${n} has more rows than a push carries (${r.rows.length}); publish here instead`);
    datasets.push({ name: n, columns: r.columns.map((c) => c.name), rows: r.rows });
  }
  const model = spec.model ? cat.models.find((m) => m.id === spec.model) : undefined;
  const res = await fetch(new URL('/api/data/import', base), {
    method: 'POST', signal: AbortSignal.timeout(120_000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-harness': '1' },
    // The dataset SQL and sources stay here: the other server gets rows, the document and the model.
    body: JSON.stringify({ id: doc, doc: { ...spec, snapshot: undefined }, model, datasets, from: process.env.HARNESS_PUBLIC_URL ?? 'a harness server', access: remote.access ?? 'token', republish }),
  });
  const b = await res.json().catch(() => ({})) as { id?: string; slug?: string; token?: string; error?: string };
  if (!res.ok || !b.slug) throw new DataError(`${base.host} refused the push: ${b.error ?? `HTTP ${res.status}`}`, 502);
  return { id: b.id!, slug: b.slug, ...(b.token ? { token: b.token } : {}), url: `${base.origin}/p/${b.slug}${b.token ? `#t=${b.token}` : ''}` };
}

/** Keeps remote copies current: after each refresh of a document published elsewhere, its rows are pushed again. */
export function followRemotes(svc: DataService): () => void {
  return svc.on((e) => {
    if (e.type !== 'refreshed' || !e.doc) return;
    void (async () => {
      const entries = (await svc.published()).filter((p: PublishedEntry) => p.owner === e.owner && p.doc === e.doc && p.remote);
      for (const p of entries) await pushRemote(svc, svc.home(p.owner), p.doc, { url: p.remote!.url, secret: p.remote!.secret }).catch((err: Error) => svc.notice(p.owner, 'warn', `Pushing ${p.doc} to ${p.remote!.url} failed: ${err.message}`));
    })();
  });
}
