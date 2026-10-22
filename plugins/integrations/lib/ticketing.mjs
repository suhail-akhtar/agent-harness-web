// Ticketing. Jira Cloud REST v3 (issues with Atlassian Document Format bodies,
// comments, transitions, remote links; basic auth with email:API token, or an
// OAuth 2.0 bearer token through api.atlassian.com/ex/jira/<cloudId>) and the
// ServiceNow Table API (incident create, work_notes, resolve with close_code and
// close_notes; basic auth, a bearer token, or OAuth client credentials).

import { request, truncate } from './util.mjs';

// ---------- Atlassian Document Format ----------

const txt = (t, marks) => ({ type: 'text', text: String(t), ...(marks ? { marks } : {}) });
export const adf = {
  doc: (...content) => ({ version: 1, type: 'doc', content: content.flat().filter(Boolean) }),
  p: (...parts) => ({ type: 'paragraph', content: parts.flat().filter((x) => x && x.text !== '').map((x) => (typeof x === 'string' ? txt(x) : x)) }),
  h: (level, t) => ({ type: 'heading', attrs: { level }, content: [txt(t)] }),
  strong: (t) => txt(t, [{ type: 'strong' }]),
  link: (t, href) => txt(t, [{ type: 'link', attrs: { href } }]),
  bullets: (items) => (items.length ? { type: 'bulletList', content: items.map((i) => ({ type: 'listItem', content: [adf.p(i)] })) } : null),
  code: (t) => ({ type: 'codeBlock', content: [txt(t)] }),
};

/** Plain text (paragraphs separated by blank lines) as ADF paragraphs; empty text is no paragraph. */
export function textToAdf(text) {
  return String(text ?? '').split(/\n{2,}/).map((s) => s.trim()).filter(Boolean).map((s) => adf.p(truncate(s, 30_000)));
}

export function incidentDescription(inc, { sessionUrl } = {}) {
  return adf.doc(
    adf.p(adf.strong('Severity: '), String(inc.severity ?? '-'), '   ', adf.strong('Status: '), String(inc.status ?? '-')),
    adf.p(adf.strong('Services: '), (inc.services ?? []).join(', ') || '-'),
    adf.p(adf.strong('Harness incident: '), String(inc.id), ...(sessionUrl ? ['  ', adf.link('Open the investigation', sessionUrl)] : [])),
    ...(inc.summary ? [adf.h(3, 'Summary'), ...textToAdf(inc.summary)] : []),
    ...(inc.evidence?.length ? [adf.h(3, 'Evidence so far'), adf.bullets(inc.evidence.slice(-10).map((e) => truncate(e, 2000)))] : []),
  );
}

export class Jira {
  constructor({ cfg, fetch, secret }) {
    this.cfg = cfg;
    this.fetch = fetch;
    this.secret = secret;
  }

  async call(method, path, json, okStatuses) {
    const oauth = !!this.cfg.oauthToken;
    const base = oauth ? `${this.cfg.apiGateway}/ex/jira/${encodeURIComponent(this.cfg.cloudId)}` : this.cfg.baseUrl;
    const authorization = oauth
      ? `Bearer ${await this.secret(this.cfg.oauthToken)}`
      : `Basic ${Buffer.from(`${this.cfg.email}:${await this.secret(this.cfg.apiToken)}`).toString('base64')}`;
    const r = await request(this.fetch, `${base}${path}`, { method, headers: { authorization }, json, okStatuses, service: `Jira ${method} ${path.split('?')[0].replace(/issue\/[^/]+/, 'issue/:key')}` });
    return r;
  }

  /** An issue already made for this incident (by its harness label), so a retry never makes a second. */
  async findByLabel(label) {
    const q = new URLSearchParams({ jql: `labels = "${label.replace(/"/g, '')}" ORDER BY created DESC`, fields: 'key,status', maxResults: '1' });
    const r = await this.call('GET', `/rest/api/3/search/jql?${q}`);
    return r.json?.issues?.[0]?.key;
  }

  async create({ project, issueType, summary, description, labels = [], priority, fields = {} }) {
    const body = { fields: { project: { key: project }, issuetype: { name: issueType }, summary: truncate(summary, 255), description, labels: [...new Set(labels)].map((l) => l.replace(/\s+/g, '-')), ...(priority ? { priority: { name: priority } } : {}), ...fields } };
    const r = await this.call('POST', '/rest/api/3/issue', body);
    return { key: r.json?.key, id: r.json?.id, url: `${this.cfg.baseUrl}/browse/${r.json?.key}` };
  }

  comment(key, body) {
    return this.call('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { body });
  }

  remoteLink(key, url, title) {
    return this.call('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/remotelink`, { globalId: `harness:${url}`, object: { url, title: truncate(title, 255) } });
  }

  /** Moves the issue to a done status: the named transition, else the first into the "done" category. */
  async resolve(key, { comment } = {}) {
    const list = (await this.call('GET', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`)).json?.transitions ?? [];
    const t = this.cfg.doneTransition
      ? list.find((x) => x.name?.toLowerCase() === this.cfg.doneTransition.toLowerCase())
      : list.find((x) => x.to?.statusCategory?.key === 'done');
    if (!t) throw new Error(`Jira ${key}: no ${this.cfg.doneTransition ? `transition named "${this.cfg.doneTransition}"` : 'transition into a done status'} is available (have: ${list.map((x) => x.name).join(', ') || 'none'})`);
    const body = { transition: { id: String(t.id) }, ...(this.cfg.resolution ? { fields: { resolution: { name: this.cfg.resolution } } } : {}), ...(comment ? { update: { comment: [{ add: { body: comment } }] } } : {}) };
    await this.call('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, body);
    return { transition: t.name, status: t.to?.name };
  }
}

export class ServiceNow {
  constructor({ cfg, fetch, secret }) {
    this.cfg = cfg;
    this.fetch = fetch;
    this.secret = secret;
    this.oauth = undefined;
  }

  async auth() {
    const c = this.cfg;
    if (c.oauthToken) return `Bearer ${await this.secret(c.oauthToken)}`;
    if (c.clientId && c.clientSecret) {
      if (this.oauth && this.oauth.until > Date.now()) return `Bearer ${this.oauth.token}`;
      const r = await request(this.fetch, `${c.instanceUrl}/oauth_token.do`, { method: 'POST', form: { grant_type: 'client_credentials', client_id: c.clientId, client_secret: await this.secret(c.clientSecret) }, service: 'ServiceNow OAuth token' });
      if (!r.json?.access_token) throw new Error('ServiceNow OAuth token: no access_token in the answer');
      this.oauth = { token: r.json.access_token, until: Date.now() + Math.max(60, Number(r.json.expires_in ?? 1800) - 120) * 1000 };
      return `Bearer ${this.oauth.token}`;
    }
    return `Basic ${Buffer.from(`${c.user}:${await this.secret(c.password)}`).toString('base64')}`;
  }

  async call(method, path, json) {
    const r = await request(this.fetch, `${this.cfg.instanceUrl}${path}`, { method, headers: { authorization: await this.auth() }, json, service: `ServiceNow ${method} ${path.split('?')[0].replace(/incident\/[0-9a-f]{32}/, 'incident/:sys_id')}` });
    return r.json?.result;
  }

  /** The incident record this harness incident already has (correlation_id), so a retry never makes a second. */
  async findByCorrelation(id) {
    const q = new URLSearchParams({ sysparm_query: `correlation_id=${id}`, sysparm_fields: 'sys_id,number,state', sysparm_limit: '1' });
    const r = await this.call('GET', `/api/now/table/incident?${q}`);
    return Array.isArray(r) && r[0] ? { sysId: r[0].sys_id, number: r[0].number } : undefined;
  }

  async create({ inc, shortDescription, description, assignmentGroup, fields = {} }) {
    const sev = inc.severity ?? 'sev3';
    const body = {
      short_description: truncate(shortDescription, 160), description: truncate(description, 30_000),
      impact: this.cfg.impact[sev], urgency: this.cfg.urgency[sev],
      correlation_id: inc.id, correlation_display: 'Harness Web',
      ...(assignmentGroup ? { assignment_group: assignmentGroup } : {}), ...this.cfg.fields, ...fields,
    };
    const r = await this.call('POST', '/api/now/table/incident?sysparm_fields=sys_id,number,state', body);
    return { sysId: r?.sys_id, number: r?.number, url: `${this.cfg.instanceUrl}/nav_to.do?uri=incident.do?sys_id=${r?.sys_id}` };
  }

  workNote(sysId, note) {
    return this.call('PATCH', `/api/now/table/incident/${encodeURIComponent(sysId)}?sysparm_fields=sys_id,number,state`, { work_notes: truncate(note, 30_000) });
  }

  resolve(sysId, { closeNotes, closeCode }) {
    return this.call('PATCH', `/api/now/table/incident/${encodeURIComponent(sysId)}?sysparm_fields=sys_id,number,state`, { state: this.cfg.resolvedState, close_code: closeCode ?? this.cfg.closeCode, close_notes: truncate(closeNotes, 4000) });
  }
}
