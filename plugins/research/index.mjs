// Research pack: the tools and the gate that hold a report to its sources.
// The pages an agent read are kept by the harness (ctx.services.sources), not
// in the workspace, so a report cannot cite "sources" the agent wrote itself.

import crypto from 'node:crypto';

const REPORTS = ['research/report.md', 'report.md'];

async function readReport(api, host, rel) {
  const fs = await import('node:fs/promises');
  const real = await api.workspacePath(host, rel);
  return fs.readFile(real, 'utf8');
}

// The claim ledger of a report, written to research/claims.md: passes when no claim is unsupported or contradicted,
// and (with minSites 2, for high stakes) when every supported claim is backed by that many independent sites.
async function claimLedger(api, host, services, rel, signal, minSites = 1) {
  const r = await services.claims(await readReport(api, host, rel), signal);
  if (!r.judged.length) return { pass: false, summary: `${rel} has no cited sentences`, text: `${rel} has no cited sentences to check (cite as [n] with a "[n]: URL" list, or inline links).` };
  const fs = await import('node:fs/promises');
  const pathMod = await import('node:path');
  const out = await api.workspacePath(host, 'research/claims.md');
  await fs.mkdir(pathMod.dirname(out), { recursive: true });
  await fs.writeFile(out, `# Claim ledger for ${rel}\n\n${r.ledger}\n`);
  const bad = r.judged.filter((c) => c.status === 'unsupported' || c.status === 'contradicted');
  const thin = minSites > 1 ? r.judged.filter((c) => (c.status === 'supported' || c.status === 'partial') && c.domains.length < minSites) : [];
  const fix = bad.length ? `\n\nFix or remove: ${bad.map((c) => `claim ${c.id} (line ${c.line}, ${c.status}: ${c.why})`).join('; ')}.` : '';
  const more = thin.length ? `\n\nBacked by fewer than ${minSites} independent sites (cite another site that says it, or say it rests on one source): ${thin.map((c) => `claim ${c.id} (line ${c.line})`).join(', ')}.` : '';
  return { pass: !bad.length && !thin.length, summary: `${rel}: ${r.judged.length} claim(s), ${bad.length} unsupported or contradicted${minSites > 1 ? `, ${thin.length} on fewer than ${minSites} sites` : ''}`, text: `${r.ledger}\n\n(Written to research/claims.md.)${fix}${more}` };
}

export default {
  name: 'research',
  setup(api) {
    api.registerTool({
      name: 'check_citations',
      description: 'Check a report\'s citations against the pages read in this session: every cited URL must have been fetched with web_fetch, every "quotation" must appear word for word in its source, and every figure in a cited sentence must appear in a source it cites (a computed figure goes in its own sentence ending "(derived: ...)"). Cite as [n] with a reference list of "[n]: URL" lines, or as inline Markdown links.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'The report, e.g. research/report.md' } }, required: ['path'] },
      kind: 'read', parallelSafe: true, untrusted: true,
      summarize: (i) => `check citations in ${i.path}`,
      async run(input, ctx) {
        const sources = ctx.services?.sources;
        if (!sources) return { content: 'Sources are not recorded in this session.', is_error: true };
        const text = await readReport(api, ctx.host, String(input.path ?? ''));
        const r = await sources.check(text);
        return { content: r.summary, is_error: r.issues.length > 0 };
      },
    });

    api.registerTool({
      name: 'verify_claims',
      description: 'The claim ledger of a report: every cited sentence judged against the passage of each page it cites (as read in this session), by a judge of another model family that sees only the sentence and the passage. Each claim comes back supported, partial, unsupported, contradicted or unverifiable, with the exact words that support it (checked against the page) and how many independent sites back it. Writes research/claims.md.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'The report, e.g. research/report.md' }, min_sites: { type: 'number', description: 'Independent sites each supported claim needs (default 1; 2 for high stakes)' } }, required: ['path'] },
      kind: 'read', parallelSafe: false, untrusted: true,
      summarize: (i) => `verify the claims in ${i.path}`,
      async run(input, ctx) {
        if (!ctx.services?.claims) return { content: 'Claims cannot be checked in this session.', is_error: true };
        const r = await claimLedger(api, ctx.host, ctx.services, String(input.path ?? ''), ctx.signal, Math.min(3, Math.max(1, Math.floor(Number(input.min_sites) || 1))));
        return { content: r.text, is_error: !r.pass };
      },
    });

    // Judges every claim with a model, so it runs only where named (the deep-research workflow), never on every turn.
    api.registerGate({
      name: 'claims',
      description: 'Every cited sentence of research/report.md is supported by the passage it cites, as judged by a model of another family (the claim ledger)',
      applies: async () => false,
      async run({ host, services, signal }) {
        if (!services?.claims) return { pass: false, summary: 'claims cannot be checked here' };
        const r = await claimLedger(api, host, services, REPORTS[0], signal);
        return { pass: r.pass, summary: r.summary, details: r.text };
      },
    });

    // The crawl frontier (phase 3): from a start page to the primary sources it links to, breadth first, each page
    // read through web_fetch (the harness's own network rules and its source store) and archived with the SHA-256 of
    // its text in research/archive.json, robots.txt honoured, one request a second to a site, a bounded count.
    api.registerTool({
      name: 'crawl',
      description: 'Follow links from a start page to the pages it cites (breadth first, the same site unless told otherwise, at most max_pages), reading each with web_fetch so it joins the pages read in this session, and archiving each with the SHA-256 of its text in research/archive.json. Honours robots.txt; one request a second to a site. Use it to reach primary sources a page points to.',
      parameters: { type: 'object', properties: {
        start: { type: 'string', description: 'The first page' },
        max_pages: { type: 'number', description: 'Pages to read in all (default 10, at most 40)' },
        same_site: { type: 'boolean', description: 'Only pages of the start page\'s site (default true)' },
        follow: { type: 'string', description: 'Only links whose URL matches this regular expression (e.g. "\\\\.pdf$|/report")' },
      }, required: ['start'] },
      kind: 'network', parallelSafe: false, untrusted: true,
      summarize: (i) => `crawl from ${i.start}`,
      async run(input, ctx) {
        if (!ctx.callTool || !ctx.services?.sources) return { content: 'Crawling is not available here (web_fetch and the source store are needed).', is_error: true };
        let start;
        try { start = new URL(String(input.start ?? '')); } catch { return { content: 'start must be a URL (https://...)', is_error: true }; }
        const max = Math.min(40, Math.max(1, Math.floor(Number(input.max_pages) || 10)));
        const same = input.same_site !== false;
        let follow;
        try { follow = input.follow ? new RegExp(String(input.follow), 'i') : undefined; } catch { return { content: 'follow is not a valid regular expression', is_error: true }; }
        const site = (u) => u.hostname.replace(/^www\./, '');
        const robots = new Map();
        const allowed = async (u) => {
          if (!robots.has(u.origin)) {
            const r = await ctx.callTool('web_fetch', { url: `${u.origin}/robots.txt` }).catch(() => ({ content: '', is_error: true }));
            const rules = [];
            let mine = false;
            for (const line of (r.is_error ? '' : String(r.content)).split('\n')) {
              const m = /^\s*(user-agent|disallow)\s*:\s*(.*?)\s*$/i.exec(line);
              if (!m) continue;
              if (/^user-agent$/i.test(m[1])) mine = m[2] === '*' || /harness/i.test(m[2]);
              else if (mine && m[2]) rules.push(m[2]);
            }
            robots.set(u.origin, rules);
          }
          return !robots.get(u.origin).some((p) => u.pathname.startsWith(p));
        };
        const last = new Map();
        const queue = [start.href];
        const seen = new Set(queue);
        const archive = [];
        const skipped = [];
        while (queue.length && archive.length < max && !ctx.signal.aborted) {
          const href = queue.shift();
          const u = new URL(href);
          if (!(await allowed(u))) { skipped.push(`${href} (robots.txt)`); continue; }
          const wait = 1000 - (Date.now() - (last.get(u.host) ?? 0));
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
          last.set(u.host, Date.now());
          const r = await ctx.callTool('web_fetch', { url: href });
          if (r.is_error) { skipped.push(`${href} (${String(r.content).slice(0, 80)})`); continue; }
          const entry = await ctx.services.sources.find(href);
          const text = entry ? await ctx.services.sources.text(entry) : String(r.content);
          archive.push({ url: href, finalUrl: entry?.finalUrl ?? href, sha256: crypto.createHash('sha256').update(text).digest('hex'), chars: text.length, fetchedAt: new Date().toISOString() });
          for (const m of String(r.content).matchAll(/https?:\/\/[^\s)"'<>\]]+/g)) {
            let v;
            try { v = new URL(m[0].replace(/[.,;:]+$/, '')); } catch { continue; }
            v.hash = '';
            if (seen.has(v.href) || (same && site(v) !== site(start)) || (follow && !follow.test(v.href)) || !/^https?:$/.test(v.protocol)) continue;
            if (/\.(png|jpe?g|gif|svg|webp|ico|css|js|woff2?|zip|mp4|mp3)(\?|$)/i.test(v.pathname)) continue;
            seen.add(v.href); queue.push(v.href);
          }
        }
        const fs = await import('node:fs/promises');
        const pathMod = await import('node:path');
        const out = await api.workspacePath(ctx.host, 'research/archive.json');
        let kept = [];
        try { kept = JSON.parse(await fs.readFile(out, 'utf8')); } catch { /* new */ }
        await fs.mkdir(pathMod.dirname(out), { recursive: true });
        await fs.writeFile(out, JSON.stringify([...kept, ...archive], null, 2));
        return [`Read ${archive.length} page(s) from ${start.href}${queue.length ? `; ${queue.length} more link(s) not followed (max_pages ${max})` : ''}. Each is in the pages read in this session (sources) and archived with its hash in research/archive.json:`, ...archive.map((a) => `- ${a.finalUrl} (${a.chars} chars, sha256 ${a.sha256.slice(0, 16)}...)`), ...(skipped.length ? ['Not read:', ...skipped.slice(0, 20).map((s) => `- ${s}`)] : [])].join('\n');
      },
    });

    api.registerTool({
      name: 'sources',
      description: 'The pages read with web_fetch in this session (any agent\'s): "list" them, or "read" one by URL without fetching it again.',
      parameters: { type: 'object', properties: { command: { type: 'string', enum: ['list', 'read'], description: 'list the pages read in this session, or read one' }, url: { type: 'string', description: 'read: the URL of a page already read with web_fetch' }, offset: { type: 'number', description: 'read: the character to start at (default 0)' }, max_chars: { type: 'number', description: 'read: how many characters to return (default 20000, 1000 to 60000)' } }, required: ['command'] },
      kind: 'read', parallelSafe: true, untrusted: true,
      summarize: (i) => `sources ${i.command}${i.url ? ` ${i.url}` : ''}`,
      async run(input, ctx) {
        const sources = ctx.services?.sources;
        if (!sources) return { content: 'Sources are not recorded in this session.', is_error: true };
        if (input.command === 'list') {
          const all = await sources.list();
          if (!all.length) return 'No pages have been read in this session yet.';
          return all.map((s) => `- ${s.finalUrl}${s.title ? ` - ${s.title}` : ''} (${s.chars} chars, ${new Date(s.fetchedAt).toISOString().slice(0, 16)})`).join('\n');
        }
        const e = await sources.find(String(input.url ?? ''));
        if (!e) return { content: `${input.url} was not read in this session; fetch it with web_fetch.`, is_error: true };
        const text = await sources.text(e);
        const offset = Math.max(0, Math.floor(Number(input.offset) || 0));
        const max = Math.min(60_000, Math.max(1000, Math.floor(Number(input.max_chars) || 20_000)));
        const more = offset + max < text.length ? `\n[${text.length - offset - max} more characters; continue with offset=${offset + max}]` : '';
        return `<source url="${e.finalUrl}">\n${text.slice(offset, offset + max)}${more}\n</source>`;
      },
    });

    api.registerGate({
      name: 'citations',
      description: 'A research report cites only pages that were read, and its quotes and figures match them',
      async applies(host) {
        const fs = await import('node:fs/promises');
        for (const rel of REPORTS) {
          const real = await api.workspacePath(host, rel).catch(() => null);
          if (real && (await fs.stat(real).catch(() => null))?.isFile()) return true;
        }
        return false;
      },
      async run({ host, services }) {
        if (!services?.sources) return { pass: false, summary: 'sources are not recorded here, so citations cannot be checked' };
        const fs = await import('node:fs/promises');
        for (const rel of REPORTS) {
          const real = await api.workspacePath(host, rel).catch(() => null);
          if (!real || !(await fs.stat(real).catch(() => null))?.isFile()) continue;
          const r = await services.sources.check(await fs.readFile(real, 'utf8'));
          if (!r.citations) return { pass: false, summary: `${rel} cites no sources`, details: 'Cite every factual claim as [n], with a reference list of "[n]: URL" lines for pages you read with web_fetch.' };
          return r.issues.length
            ? { pass: false, summary: `${rel}: ${r.issues.length} citation problem(s)`, details: r.summary }
            : { pass: true, summary: `${rel}: ${r.citations} citation(s), ${r.sentencesChecked} cited sentence(s) match the pages read` };
        }
        return { pass: false, summary: 'no report found (research/report.md)' };
      },
    });
  },
};
