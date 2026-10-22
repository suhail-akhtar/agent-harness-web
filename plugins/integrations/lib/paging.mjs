// Paging. PagerDuty: Events API v2 (POST /v2/enqueue: trigger, acknowledge,
// resolve, keyed by dedup_key - here the incident's group id) with a service's
// integration (routing) key, and the REST API v2 (Authorization: Token token=...)
// for notes on the incident and who is on call. Opsgenie: Alert API v2
// (Authorization: GenieKey ...; alerts keyed by alias; create, acknowledge,
// close, notes; US or EU host).

import { request, truncate } from './util.mjs';

const PD_ACCEPT = 'application/vnd.pagerduty+json;version=2';

export class PagerDuty {
  constructor({ cfg, fetch, secret }) {
    this.cfg = cfg;
    this.fetch = fetch;
    this.secret = secret; // async (name) => value
  }

  /** Events API v2. Returns { status, dedup_key }. */
  async event({ action, dedupKey, routingKey, summary, source, severity, component, group, cls, details, links }) {
    const key = await this.secret(routingKey ?? this.cfg.routingKey);
    const body = { routing_key: key, event_action: action, dedup_key: truncate(dedupKey, 255) };
    if (action === 'trigger') {
      body.payload = {
        summary: truncate(summary, 1024), source: truncate(source || 'harness', 255), severity,
        ...(component ? { component } : {}), ...(group ? { group } : {}), ...(cls ? { class: cls } : {}),
        ...(details ? { custom_details: details } : {}),
      };
      if (links?.length) body.links = links.map((l) => ({ href: l.url, text: l.text }));
      body.client = 'Harness Web';
    }
    const r = await request(this.fetch, `${this.cfg.eventsBase}/v2/enqueue`, { method: 'POST', json: body, service: `PagerDuty Events ${action}` });
    return { status: r.json?.status, dedup_key: r.json?.dedup_key ?? dedupKey, message: r.json?.message };
  }

  async rest(method, path, json, { from } = {}) {
    const token = await this.secret(this.cfg.apiToken);
    const headers = { authorization: `Token token=${token}`, accept: PD_ACCEPT, ...(from ? { from } : {}) };
    return (await request(this.fetch, `${this.cfg.apiBase}${path}`, { method, headers, json, service: `PagerDuty REST ${method} ${path.split('?')[0]}` })).json ?? {};
  }

  /** The PagerDuty incident an Events v2 dedup_key opened (its incident_key). */
  async findIncident(dedupKey) {
    const q = new URLSearchParams({ incident_key: dedupKey });
    const r = await this.rest('GET', `/incidents?${q}`);
    return r.incidents?.[0];
  }

  async addNote(incidentId, content) {
    return (await this.rest('POST', `/incidents/${encodeURIComponent(incidentId)}/notes`, { note: { content: truncate(content, 25_000) } }, { from: this.cfg.from })).note;
  }

  /** Who is on call now for an escalation policy (first level first), with emails. */
  async onCall(escalationPolicy) {
    const q = new URLSearchParams();
    q.append('escalation_policy_ids[]', escalationPolicy);
    q.append('include[]', 'users');
    q.set('earliest', 'true');
    const r = await this.rest('GET', `/oncalls?${q}`);
    const seen = new Set();
    return (r.oncalls ?? [])
      .sort((a, b) => (a.escalation_level ?? 9) - (b.escalation_level ?? 9))
      .map((o) => ({ id: o.user?.id, name: o.user?.name ?? o.user?.summary, email: o.user?.email ? String(o.user.email).toLowerCase() : undefined, level: o.escalation_level }))
      .filter((u) => u.id && !seen.has(u.id) && seen.add(u.id));
  }
}

export class Opsgenie {
  constructor({ cfg, fetch, secret }) {
    this.cfg = cfg;
    this.fetch = fetch;
    this.secret = secret;
  }

  async call(method, path, json) {
    const key = await this.secret(this.cfg.apiKey);
    const r = await request(this.fetch, `${this.cfg.apiBase}${path}`, { method, headers: { authorization: `GenieKey ${key}` }, json, service: `Opsgenie ${path.split('?')[0].replace(/\/alerts\/[^/]+/, '/alerts/:id')}` });
    return { status: r.status, requestId: r.json?.requestId, result: r.json?.result };
  }

  create({ alias, message, description, priority, responders, tags, details, entity }) {
    return this.call('POST', '/v2/alerts', {
      message: truncate(message, 130), alias: truncate(alias, 512), description: truncate(description ?? '', 15_000),
      ...(responders?.length ? { responders } : {}), ...(tags?.length ? { tags: tags.slice(0, 20).map((t) => truncate(t, 50)) } : {}),
      ...(details ? { details } : {}), ...(entity ? { entity: truncate(entity, 512) } : {}),
      source: this.cfg.source, priority, user: this.cfg.user,
    });
  }

  action(alias, what, note) {
    return this.call('POST', `/v2/alerts/${encodeURIComponent(alias)}/${what}?identifierType=alias`, { user: this.cfg.user, source: this.cfg.source, ...(note ? { note: truncate(note, 25_000) } : {}) });
  }

  acknowledge(alias, note) { return this.action(alias, 'acknowledge', note); }
  close(alias, note) { return this.action(alias, 'close', note); }
  note(alias, note) { return this.call('POST', `/v2/alerts/${encodeURIComponent(alias)}/notes?identifierType=alias`, { note: truncate(note, 25_000), user: this.cfg.user, source: this.cfg.source }); }
}
