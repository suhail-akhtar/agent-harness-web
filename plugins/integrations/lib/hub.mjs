// The integrations hub: harness events in, chat/paging/ticketing out, and chat
// decisions and investigations back in.
//  - incidents (the aiops `incident` tool's calls, or an `incident` event) become a
//    thread per incident in the routed channel, pages (PagerDuty / Opsgenie) and
//    tickets (Jira / ServiceNow), as the operator's routing rules say;
//  - approval_request / permission_request become a message with buttons, decided
//    from Slack or Teams by the operator's approvers (api.sessions.respond), the
//    message then showing who decided; a decision made in the harness updates it too;
//  - "investigate <text>" from a chat starts a session (the text fenced as
//    untrusted) and its progress and summary are posted back in the thread.

import { routeFor } from './config.mjs';
import { Credentials } from './creds.mjs';
import { Jira, ServiceNow, adf, incidentDescription, textToAdf } from './ticketing.mjs';
import { Opsgenie, PagerDuty } from './paging.mjs';
import { SlackClient, approvalBlocks, decidedBlocks, esc, incidentBlocks, verifySlackRequest } from './slack.mjs';
import { BotAuthError, OpenIdKeys, TeamsClient, approvalCard, cardAttachment, cardInvokeResponse, decidedCard, incidentCard, messageInvokeResponse, messageText, postWorkflowWebhook, textCard, verifyBotRequest } from './teams.mjs';
import { KeyedQueue, RateLimiter, fenceUntrusted, redact, truncate } from './util.mjs';

const ok = (body = '', type = 'text/plain') => ({ status: 200, headers: { 'content-type': type }, body });
const json = (status, obj) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
const DECISIONS = { permission_request: ['allow', 'deny'], approval_request: ['approve', 'reject'] };

export class Hub {
  constructor({ api, config, store, fetch, log = () => {} }) {
    this.api = api;
    this.config = config;
    this.store = store;
    this.fetch = fetch;
    this.log = log;
    this.creds = new Credentials({ api });
    this.inflight = new Set();
    this.queue = new KeyedQueue();
    this.calls = new Map(); // tool_call id -> { sessionId, input }
    this.progress = new Map(); // sessionId -> { tools, last, step, timer }
    this.lastText = new Map(); // sessionId -> the main agent's latest text
    this.limits = { investigate: new RateLimiter(Math.max(1, config.investigate.perUserPer10Min), 10 * 60_000), clicks: new RateLimiter(30, 60_000), inbound: new RateLimiter(300, 60_000) };
    this.bg = this.clients(undefined);
    this.keys = config.teams ? new OpenIdKeys({ metadataUrl: config.teams.openIdMetadata, fetch }) : undefined;
  }

  /** Service clients reading credentials through `vault` (a tool call's) or the server-side vault (background). */
  clients(vault) {
    const c = this.config;
    const secret = (name, purpose = 'integrations') => this.creds.get(name, purpose, vault);
    return {
      slack: c.slack ? new SlackClient({ cfg: c.slack, fetch: this.fetch, token: () => secret(c.slack.botToken, 'Slack Web API') }) : undefined,
      teams: c.teams?.appPassword ? new TeamsClient({ cfg: c.teams, fetch: this.fetch, password: () => secret(c.teams.appPassword, 'Bot Framework token') }) : undefined,
      pd: c.pagerduty ? new PagerDuty({ cfg: c.pagerduty, fetch: this.fetch, secret: (n) => secret(n, 'PagerDuty') }) : undefined,
      og: c.opsgenie ? new Opsgenie({ cfg: c.opsgenie, fetch: this.fetch, secret: (n) => secret(n, 'Opsgenie') }) : undefined,
      jira: c.jira ? new Jira({ cfg: c.jira, fetch: this.fetch, secret: (n) => secret(n, 'Jira') }) : undefined,
      snow: c.servicenow ? new ServiceNow({ cfg: c.servicenow, fetch: this.fetch, secret: (n) => secret(n, 'ServiceNow') }) : undefined,
      secret,
    };
  }

  track(p) {
    const t = Promise.resolve(p).catch((e) => this.log(`integrations: ${redact(e?.message ?? e, this.creds.seen)}`));
    this.inflight.add(t);
    t.finally(() => this.inflight.delete(t));
    return t;
  }

  /** Waits for all background work (tests; shutdown). */
  async drain() {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  clean(s, n = 3000) { return truncate(redact(s, this.creds.seen), n); }
  sessionUrl(id) { return this.config.publicUrl && id ? `${this.config.publicUrl}/#${encodeURIComponent(id)}` : undefined; }
  audit(r) { try { this.store.audit(r); } catch (e) { this.log(`integrations: audit write failed: ${e.message}`); } }

  // ---------------- messages in channels ----------------

  /** Posts a new top-level message. Returns a reference to it (to reply in its thread and edit it). */
  async postRoot(channelName, msg, cl = this.bg) {
    const ch = this.config.channels[channelName];
    if (!ch) throw new Error(`no channel named "${channelName}" in the integrations configuration`);
    if (ch.type === 'slack') {
      if (!cl.slack) throw new Error('Slack is not configured');
      const r = await cl.slack.post({ channel: ch.channel, text: msg.text, blocks: msg.blocks });
      return { type: 'slack', channel: r.channel ?? ch.channel, ts: r.ts };
    }
    if (ch.type === 'teams') {
      if (!cl.teams) throw new Error('the Teams bot is not configured');
      const serviceUrl = ch.serviceUrl ?? this.config.teams.serviceUrl;
      const r = await cl.teams.send(serviceUrl, ch.conversationId, msg.card ? cardAttachment(msg.card) : { type: 'message', text: msg.text });
      return { type: 'teams', serviceUrl, conversationId: ch.conversationId, activityId: r.id };
    }
    await postWorkflowWebhook(this.fetch, await cl.secret(ch.url, 'Teams Workflows webhook'), msg.card ?? textCard(msg.text));
    return { type: 'teams-webhook', channel: channelName };
  }

  async reply(ref, msg, cl = this.bg) {
    if (ref.type === 'slack') { const r = await cl.slack.post({ channel: ref.channel, thread_ts: ref.ts, text: msg.text, blocks: msg.blocks }); return { type: 'slack', channel: ref.channel, ts: r.ts, thread: ref.ts }; }
    if (ref.type === 'teams') { const r = await cl.teams.reply(ref.serviceUrl, ref.conversationId, ref.activityId, msg.card ? cardAttachment(msg.card) : { type: 'message', text: msg.text }); return { type: 'teams', serviceUrl: ref.serviceUrl, conversationId: ref.conversationId, activityId: r.id, thread: ref.activityId }; }
    return this.postRoot(ref.channel, msg, cl); // a webhook has no threads: a new card
  }

  async edit(ref, msg, cl = this.bg) {
    if (ref.type === 'slack') return cl.slack.update({ channel: ref.channel, ts: ref.ts, text: msg.text, blocks: msg.blocks });
    if (ref.type === 'teams') return cl.teams.update(ref.serviceUrl, ref.conversationId, ref.activityId, msg.card ? cardAttachment(msg.card) : { type: 'message', text: msg.text });
    return undefined; // a webhook card cannot be edited
  }

  /** Into the thread `key` (made in `channel` with `rootMsg` when there is none yet). Returns the message's reference. */
  async toThread(key, channel, rootMsg, msg, cl = this.bg) {
    const threads = this.store.data.threads;
    if (!threads[key]) {
      threads[key] = { channel, ref: await this.postRoot(channel, rootMsg, cl) };
      this.store.save();
      if (!msg) return threads[key].ref;
    }
    return msg ? this.reply(threads[key].ref, msg, cl) : threads[key].ref;
  }

  // ---------------- harness events ----------------

  /** api.events.subscribe callback: never throws, never blocks the session. */
  onEvent(e) {
    try {
      const ev = e?.event;
      if (!ev || !e.sessionId) return;
      const main = !ev.agent;
      switch (ev.kind) {
        case 'tool_call':
          if (ev.name === 'incident') this.calls.set(ev.id, { sessionId: e.sessionId, input: ev.input ?? {} });
          if (main) this.noteProgress(e.sessionId, { tool: ev.name });
          break;
        case 'tool_result': {
          const call = this.calls.get(ev.id);
          if (ev.name === 'incident' && call) { this.calls.delete(ev.id); if (!ev.is_error) this.track(this.fromIncidentTool(call, ev.content)); }
          break;
        }
        case 'incident': // a server-side incident store (aiops) may emit incidents directly
          if (ev.incident?.id) this.track(this.incidentEvent(ev.action ?? 'update', ev.incident, { sessionId: e.sessionId }));
          break;
        case 'approval_request':
        case 'permission_request':
          this.track(this.approvalEvent(e));
          break;
        case 'request_resolved':
          this.track(this.resolvedElsewhere(ev.requestId, ev.decision));
          break;
        case 'workflow':
          if (ev.phase === 'node_started' && ev.node) this.noteProgress(e.sessionId, { step: ev.node });
          break;
        case 'assistant_message':
          if (main) {
            const text = (ev.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
            if (text) this.lastText.set(e.sessionId, text);
          }
          break;
        case 'turn_end':
          if (main) this.track(this.turnEnded(e.sessionId, ev.reason));
          break;
        default:
      }
    } catch (err) { this.log(`integrations: event ${e?.event?.kind}: ${err.message}`); }
  }

  /** What the aiops incident tool did, from its call and its result text. */
  async fromIncidentTool({ sessionId, input }, content) {
    const action = String(input.action ?? '');
    if (action === 'open') {
      const m = /Opened (inc-[a-z0-9-]+) \((sev[1-4])\)/.exec(String(content));
      if (!m) return;
      return this.incidentEvent('open', { id: m[1], title: input.title, severity: m[2], services: input.services ?? [], summary: input.summary ?? '', status: 'investigating', group: input.group }, { sessionId });
    }
    if (!/^inc-[a-z0-9-]+$/.test(String(input.id ?? ''))) return;
    if (action === 'update') return this.incidentEvent('update', { id: input.id, status: input.status, severity: input.severity, services: input.services, note: input.note, kind: input.kind }, { sessionId });
    if (action === 'resolve') return this.incidentEvent('resolve', { id: input.id, status: 'resolved', rootCause: input.root_cause, resolution: input.resolution }, { sessionId });
  }

  /**
   * An incident opened, updated or resolved: the thread in its channel, pages and
   * tickets as its route says. Returns what was done, per system.
   */
  async incidentEvent(action, patch, { sessionId, vault, only } = {}) {
    const inc = patch.id;
    if (sessionId) (this.store.data.sessions[sessionId] ??= {}).incident = inc; // at once: the session's next approval goes to this thread
    return this.queue.run(`incident:${inc}`, async () => {
      const incidents = this.store.data.incidents;
      const prev = incidents[inc] ?? { id: inc, services: [], evidence: [], status: 'investigating' };
      const rec = { ...prev };
      for (const k of ['title', 'severity', 'status', 'summary', 'rootCause', 'resolution', 'group']) if (patch[k] !== undefined && patch[k] !== null && patch[k] !== '') rec[k] = patch[k];
      if (Array.isArray(patch.services)) rec.services = [...new Set([...(prev.services ?? []), ...patch.services.map(String)])];
      if (patch.note) rec.evidence = [...(prev.evidence ?? []), `${patch.kind && patch.kind !== 'note' ? `[${patch.kind}] ` : ''}${this.clean(patch.note, 2000)}`].slice(-20);
      if (sessionId) { rec.sessionId ??= sessionId; (this.store.data.sessions[sessionId] ??= {}).incident = inc; }
      rec.updatedAt = Date.now();
      incidents[inc] = rec;
      this.store.save();
      const route = routeFor(this.config, rec);
      const cl = vault ? this.clients(vault) : this.bg;
      const done = {};
      const want = (k) => !only || only.includes(k);
      const step = async (system, fn) => {
        try { done[system] = await fn(); this.audit({ action: `incident.${action}`, system, incident: inc, result: 'ok', detail: done[system] }); }
        catch (e) { done[system] = { error: this.clean(e.message, 500) }; this.audit({ action: `incident.${action}`, system, incident: inc, result: 'error', reason: done[system].error }); }
      };
      const links = this.incidentLinks(rec);
      if (want('chat') && route.channel) await step('chat', () => this.incidentChat(action, rec, patch, route, links, cl));
      if (want('pagerduty') && route.pagerduty && cl.pd) await step('pagerduty', () => this.incidentPagerDuty(action, rec, prev, route, cl));
      if (want('opsgenie') && route.opsgenie && cl.og) await step('opsgenie', () => this.incidentOpsgenie(action, rec, prev, patch, route, cl));
      if (want('jira') && route.jira && cl.jira) await step('jira', () => this.incidentJira(action, rec, patch, route, cl));
      if (want('servicenow') && route.servicenow && cl.snow) await step('servicenow', () => this.incidentServiceNow(action, rec, patch, route, cl));
      this.store.save();
      // Links to tickets made just now go on the incident's root message.
      if (want('chat') && route.channel && action === 'open' && (rec.jira?.url || rec.snow?.url)) {
        const t = this.store.data.threads[`incident:${inc}`];
        if (t) await step('chat-links', () => this.edit(t.ref, this.incidentMsg(rec), cl).then(() => ({ edited: true })));
      }
      return done;
    });
  }

  incidentLinks(rec) {
    return [rec.jira?.url ? { text: `Jira ${rec.jira.key}`, url: rec.jira.url } : null, rec.snow?.url ? { text: `ServiceNow ${rec.snow.number}`, url: rec.snow.url } : null].filter(Boolean);
  }

  incidentMsg(rec) {
    const o = { sessionUrl: this.sessionUrl(rec.sessionId), links: this.incidentLinks(rec) };
    const clean = { ...rec, title: this.clean(rec.title, 300), summary: this.clean(rec.summary ?? '', 1500), rootCause: rec.rootCause && this.clean(rec.rootCause, 1000), resolution: rec.resolution && this.clean(rec.resolution, 1000) };
    return { ...incidentBlocks(clean, o), card: incidentCard(clean, o) };
  }

  async incidentChat(action, rec, patch, route, _links, cl) {
    const key = `incident:${rec.id}`;
    const thread = this.store.data.threads[key];
    if (!thread) { await this.toThread(key, route.channel, this.incidentMsg(rec), undefined, cl); return { posted: 'root' }; }
    const lines = [
      patch.status && patch.status !== 'resolved' ? `Status: ${patch.status}` : '',
      patch.severity ? `Severity: ${patch.severity}` : '',
      patch.note ? `${patch.kind && patch.kind !== 'note' ? `[${patch.kind}] ` : ''}${patch.note}` : '',
      action === 'resolve' ? `Resolved. Root cause: ${rec.rootCause ?? '-'}${rec.resolution ? `\nResolution: ${rec.resolution}` : ''}` : '',
    ].filter(Boolean);
    if (lines.length) {
      const t = this.clean(lines.join('\n'));
      await this.reply(thread.ref, { text: t, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: esc(t) } }], card: textCard(t) }, cl);
    }
    await this.edit(thread.ref, this.incidentMsg(rec), cl);
    return { posted: lines.length ? 'reply' : 'none', edited: true };
  }

  summaryFor(rec) {
    const last = rec.sessionId ? this.lastText.get(rec.sessionId) : undefined;
    return this.clean([
      `Harness incident ${rec.id}: ${rec.title ?? ''}`,
      rec.rootCause ? `Root cause: ${rec.rootCause}` : '',
      rec.resolution ? `Resolution: ${rec.resolution}` : '',
      rec.evidence?.length ? `Evidence:\n${rec.evidence.slice(-8).map((e) => `- ${e}`).join('\n')}` : '',
      last ? `Investigation summary:\n${last}` : '',
      this.sessionUrl(rec.sessionId) ? `Session: ${this.sessionUrl(rec.sessionId)}` : '',
    ].filter(Boolean).join('\n\n'), 20_000);
  }

  async incidentPagerDuty(action, rec, prev, route, cl) {
    const pd = cl.pd;
    const cfg = this.config.pagerduty;
    const dedupKey = rec.group ?? rec.id;
    const routingKey = route.pagerduty.routingKey ?? cfg.routingKey;
    if (!routingKey) throw new Error('no PagerDuty routing key (pagerduty.routingKey or the route\'s)');
    const state = rec.pd ?? {};
    const out = {};
    if (action === 'open' || (!state.triggered && action !== 'resolve')) {
      const sessionUrl = this.sessionUrl(rec.sessionId);
      const r = await pd.event({ action: 'trigger', dedupKey, routingKey, summary: this.clean(`[${rec.severity}] ${rec.title ?? rec.id}`, 1024), source: (rec.services ?? [])[0] ?? 'harness', severity: cfg.severity[rec.severity] ?? 'error', component: (rec.services ?? []).join(','), group: rec.group, cls: 'harness-incident', details: { incident: rec.id, services: rec.services, summary: this.clean(rec.summary ?? '', 2000) }, links: sessionUrl ? [{ url: sessionUrl, text: 'Harness investigation' }] : [] });
      state.triggered = true; state.dedupKey = r.dedup_key; out.trigger = r.status;
    }
    if (action !== 'resolve' && !state.acked && cfg.ackOn.includes(rec.status) && rec.status !== prev.status) {
      out.acknowledge = (await pd.event({ action: 'acknowledge', dedupKey, routingKey })).status;
      state.acked = true;
    }
    if (action === 'resolve') {
      out.resolve = (await pd.event({ action: 'resolve', dedupKey, routingKey })).status;
      state.resolved = true;
      if (cfg.apiToken) {
        const found = state.incidentId ? { id: state.incidentId } : await pd.findIncident(dedupKey);
        if (found?.id) { state.incidentId = found.id; await pd.addNote(found.id, this.summaryFor(rec)); out.note = found.id; }
        else out.note = 'no PagerDuty incident found for the dedup key';
      }
    }
    rec.pd = state;
    return out;
  }

  async incidentOpsgenie(action, rec, prev, patch, route, cl) {
    const og = cl.og;
    const cfg = this.config.opsgenie;
    const alias = rec.group ?? rec.id;
    const state = rec.og ?? {};
    const out = {};
    if (action === 'open' || (!state.created && action !== 'resolve')) {
      out.create = (await og.create({ alias, message: this.clean(`[${rec.severity}] ${rec.title ?? rec.id}`, 130), description: this.clean(`${rec.summary ?? ''}\n\n${this.sessionUrl(rec.sessionId) ?? ''}`, 15_000), priority: cfg.priority[rec.severity] ?? 'P3', responders: route.opsgenie.responders, tags: ['harness', ...(route.opsgenie.tags ?? []), ...(rec.services ?? [])], details: { incident: rec.id, services: (rec.services ?? []).join(',') }, entity: (rec.services ?? [])[0] })).requestId;
      state.created = true;
    }
    if (action === 'update' && patch.note) out.note = (await og.note(alias, this.clean(patch.note, 25_000))).requestId;
    if (action !== 'resolve' && !state.acked && cfg.ackOn.includes(rec.status) && rec.status !== prev.status) { out.acknowledge = (await og.acknowledge(alias, `Status: ${rec.status}`)).requestId; state.acked = true; }
    if (action === 'resolve') { out.close = (await og.close(alias, this.summaryFor(rec))).requestId; state.closed = true; }
    rec.og = state;
    return out;
  }

  async incidentJira(action, rec, patch, route, cl) {
    const jira = cl.jira;
    const cfg = this.config.jira;
    const label = `harness-${rec.id}`;
    const out = {};
    if (!rec.jira?.key) {
      const existing = await jira.findByLabel(label).catch(() => undefined);
      if (existing) rec.jira = { key: existing, url: `${cfg.baseUrl}/browse/${existing}` };
      else {
        const project = route.jira.project ?? cfg.project;
        if (!project) throw new Error('no Jira project (jira.project or the route\'s)');
        const made = await jira.create({
          project, issueType: route.jira.issueType ?? cfg.issueType,
          summary: this.clean(`[${rec.severity}] ${rec.title ?? rec.id}`, 255),
          description: incidentDescription({ ...rec, summary: this.clean(rec.summary ?? '', 20_000) }, { sessionUrl: this.sessionUrl(rec.sessionId) }),
          labels: ['harness', label, ...cfg.labels, ...route.jira.labels, ...(rec.services ?? []).map((s) => `service-${s}`)],
          priority: cfg.priority?.[rec.severity], fields: { ...cfg.fields, ...route.jira.fields },
        });
        rec.jira = { key: made.key, url: made.url };
        out.created = made.key;
        const su = this.sessionUrl(rec.sessionId);
        if (su) await jira.remoteLink(made.key, su, `Harness investigation ${rec.id}`).catch((e) => { out.remoteLink = e.message; });
      }
      if (action === 'open') return out;
    }
    if (action === 'update') {
      const text = [patch.status ? `Status: ${patch.status}` : '', patch.severity ? `Severity: ${patch.severity}` : '', patch.note ? `${patch.kind && patch.kind !== 'note' ? `[${patch.kind}] ` : ''}${this.clean(patch.note, 20_000)}` : ''].filter(Boolean).join('\n\n');
      if (text) { await jira.comment(rec.jira.key, adf.doc(textToAdf(text))); out.comment = rec.jira.key; }
    }
    if (action === 'resolve') {
      const r = await jira.resolve(rec.jira.key, { comment: adf.doc(textToAdf(this.summaryFor(rec))) });
      out.transition = r.transition;
    }
    return out;
  }

  async incidentServiceNow(action, rec, patch, route, cl) {
    const snow = cl.snow;
    const out = {};
    if (!rec.snow?.sysId) {
      const existing = await snow.findByCorrelation(rec.id).catch(() => undefined);
      if (existing) rec.snow = { ...existing, url: `${this.config.servicenow.instanceUrl}/nav_to.do?uri=incident.do?sys_id=${existing.sysId}` };
      else {
        const made = await snow.create({ inc: rec, shortDescription: this.clean(`[${rec.severity}] ${rec.title ?? rec.id}`, 160), description: this.clean(`${rec.summary ?? ''}\n\nHarness incident ${rec.id}${this.sessionUrl(rec.sessionId) ? `\n${this.sessionUrl(rec.sessionId)}` : ''}`, 30_000), assignmentGroup: route.servicenow.assignmentGroup, fields: route.servicenow.fields });
        rec.snow = made;
        out.created = made.number;
      }
      if (action === 'open') return out;
    }
    if (action === 'update') {
      const text = [patch.status ? `Status: ${patch.status}` : '', patch.severity ? `Severity: ${patch.severity}` : '', patch.note ? this.clean(patch.note, 20_000) : ''].filter(Boolean).join('\n');
      if (text) { await snow.workNote(rec.snow.sysId, text); out.workNote = rec.snow.number; }
    }
    if (action === 'resolve') { await snow.resolve(rec.snow.sysId, { closeNotes: this.summaryFor(rec) }); out.resolved = rec.snow.number; }
    return out;
  }

  // ---------------- approvals out ----------------

  async sessionInfo(id) {
    try { return (await this.api.sessions?.get?.(id)) ?? undefined; } catch { return undefined; }
  }

  async approvalEvent({ sessionId, owner, title, event }) {
    const s = this.store.data.sessions[sessionId] ?? {};
    const forward = this.config.approvals.forward;
    if (!s.origin && (forward === 'none' || (forward === 'incidents' && !s.incident))) return;
    if (this.store.data.pending[event.requestId]) return; // already posted (a replayed event)
    if (s.incident) await this.queue.run(`incident:${s.incident}`, async () => {}); // its thread exists first
    const isPerm = event.kind === 'permission_request';
    const rec = s.incident ? this.store.data.incidents[s.incident] : undefined;
    const detail = isPerm
      ? `${event.summary ?? ''}${event.input ? `\n${JSON.stringify(event.input, null, 1).slice(0, 1500)}` : ''}`
      : event.message ?? '';
    const req = {
      requestId: event.requestId, kind: event.kind, sessionId, sessionTitle: this.clean(title ?? '', 200), owner,
      tool: event.tool, title: this.clean(isPerm ? event.tool : event.title, 200), detail: this.clean(detail, 2800),
      files: (event.files ?? []).map((f) => f.path).slice(0, 20), incident: rec ? `${rec.id} (${rec.severity})` : undefined,
    };
    const route = rec ? routeFor(this.config, rec) : {};
    const onCall = await this.onCallFor(route).catch(() => []);
    const msg = { ...approvalBlocks(req, { sessionUrl: this.sessionUrl(sessionId), onCall }), card: approvalCard(req, { sessionUrl: this.sessionUrl(sessionId), onCall }) };
    // Where: the chat thread the session came from, else its incident's thread, else a thread per session in the approvals channel.
    let ref;
    const head = this.clean(title ?? sessionId, 200);
    if (s.origin) ref = await this.reply(s.origin.ref, msg);
    else if (rec && route.channel) ref = await this.queue.run(`incident:${rec.id}`, () => this.toThread(`incident:${rec.id}`, route.channel, this.incidentMsg(rec), msg));
    else if (this.config.approvals.channel) ref = await this.queue.run(`session:${sessionId}`, () => this.toThread(`session:${sessionId}`, this.config.approvals.channel, { text: `Approvals for session ${head}`, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `Approvals for session *${esc(head)}*${this.sessionUrl(sessionId) ? ` (<${this.sessionUrl(sessionId)}|open>)` : ''}` } }], card: textCard(`Approvals for session ${head}`) }, msg));
    else return;
    this.store.data.pending[event.requestId] = { sessionId, kind: event.kind, owner, ref, msg: { text: msg.text, blocks: msg.blocks, card: msg.card }, onCall: onCall.map((u) => u.email).filter(Boolean), status: 'pending', at: Date.now() };
    this.store.save();
    this.audit({ action: 'approval.posted', requestId: event.requestId, session: sessionId, kind: event.kind, where: ref.type, result: 'ok' });
  }

  /** On call for the route's PagerDuty escalation policy, with their Slack ids where known. */
  async onCallFor(route) {
    const policy = route?.pagerduty?.escalationPolicy;
    if (!policy || !this.config.pagerduty?.apiToken || !this.bg.pd) return [];
    const users = await this.bg.pd.onCall(policy);
    for (const u of users) {
      const a = this.config.approvers.find((x) => u.email && x.emails.includes(u.email));
      u.slack = a?.slack?.[0] ?? (this.bg.slack && u.email ? await this.bg.slack.userByEmail(u.email) : undefined);
    }
    return users;
  }

  async resolvedElsewhere(requestId, decision) {
    const p = this.store.data.pending[requestId];
    if (!p || p.status !== 'pending') return;
    p.status = 'decided'; p.decision = decision; p.by = 'harness'; p.decidedAt = Date.now();
    this.store.save();
    await this.showDecision(p, { decision, who: 'the harness', elsewhere: true });
  }

  async showDecision(p, { decision, who, elsewhere = false, skipTeams = false }) {
    if (!p.ref) return;
    if (p.ref.type === 'slack') await this.edit(p.ref, decidedBlocks(p.msg, { decision, who, elsewhere }));
    else if (p.ref.type === 'teams' && !skipTeams) await this.edit(p.ref, { card: decidedCard(p.msg.card, { decision, who, elsewhere }) });
  }

  // ---------------- people ----------------

  person(list, id) {
    return list.find((a) => (id.slackId && a.slack.includes(id.slackId)) || (id.teamsAad && a.teams.includes(id.teamsAad)) || (id.teamsId && a.teams.includes(id.teamsId)) || (id.email && a.emails.includes(id.email)));
  }

  /** Matches a chat user to the list, looking up their email only when the list names people by email. */
  async resolvePerson(list, id, lookupEmail) {
    let p = this.person(list, id);
    if (!p && !id.email && list.some((a) => a.emails.length) && lookupEmail) {
      id.email = await lookupEmail().catch(() => undefined);
      if (id.email) p = this.person(list, id);
    }
    return p;
  }

  /**
   * A decision from a chat. Returns { ok, message, decision, who }. Every outcome is audited.
   */
  async decide({ platform, userKey, id, requestId, decision, lookupEmail, display }) {
    const refuse = (reason, extra = {}) => { this.audit({ action: 'approval.decide', platform, by: userKey, requestId, decision, result: 'denied', reason, ...extra }); return { ok: false, message: reason }; };
    const p = this.store.data.pending[requestId];
    if (!p) return refuse('This request is not one the harness posted (or it is too old).');
    if (p.status !== 'pending') return refuse(`This request was already decided (${p.decision ?? p.status}${p.by ? ` by ${p.by}` : ''}).`);
    if (!DECISIONS[p.kind]?.includes(decision)) return refuse(`"${decision}" is not a decision for this request.`);
    const who = await this.resolvePerson(this.config.approvers, id, lookupEmail);
    if (!who) return refuse('You are not on the harness approver list for chat decisions, so this was not decided. Ask the operator to add you, or decide in the harness.');
    if (who.scope === 'own' && p.owner && p.owner !== who.account) return refuse('You may decide only for sessions of your own harness account.', { account: who.account });
    if (this.config.approvals.onCallOnly && p.onCall?.length && !(id.email && p.onCall.includes(id.email)) && !who.emails.some((e) => p.onCall.includes(e))) return refuse('Only the person on call for this service may decide this request now.', { account: who.account });
    p.status = 'deciding';
    let done = false;
    try {
      done = await this.api.sessions.respond(p.sessionId, requestId, { decision, by: userKey, feedback: `Decided from ${platform} by ${display ?? userKey} (harness account ${who.account}).` });
    } catch (e) {
      p.status = 'pending';
      return refuse(`The harness did not take the decision: ${this.clean(e.message, 300)}`, { account: who.account });
    }
    if (!done) {
      p.status = 'gone'; p.decidedAt = Date.now(); this.store.save();
      return refuse('The session is no longer waiting for this decision.', { account: who.account });
    }
    Object.assign(p, { status: 'decided', decision, by: userKey, account: who.account, decidedAt: Date.now() });
    this.store.save();
    this.audit({ action: 'approval.decide', platform, by: userKey, account: who.account, requestId, session: p.sessionId, decision, result: 'ok' });
    return { ok: true, decision, who: display ?? userKey, pending: p };
  }

  // ---------------- investigations from chat ----------------

  async investigate({ platform, userKey, id, text, where, lookupEmail, display }) {
    const refuse = (reason) => { this.audit({ action: 'investigate', platform, by: userKey, result: 'denied', reason }); return { ok: false, message: reason }; };
    if (!this.api.sessions?.start) return refuse('This harness cannot start sessions from a chat (no session API).');
    const who = await this.resolvePerson(this.config.investigators, id, lookupEmail);
    if (!who) return refuse('You are not on the harness list of people who may start investigations from chat.');
    if (!this.limits.investigate.allow(userKey)) return refuse('Too many investigations started from chat in the last 10 minutes; try again later.');
    const topic = String(text ?? '').trim();
    if (!topic) return refuse('Say what to investigate, for example: investigate checkout latency since 14:00');
    const inv = this.config.investigate;
    const fenced = fenceUntrusted(topic, `${platform}, ${userKey}`);
    const prompt = `Investigate a problem a person reported from ${platform}. Gather evidence with your tools, find the likely cause, and finish with a short summary: what is wrong, the evidence (with numbers), the likely cause, and what you recommend. Do not change any system without approval.\n\n${fenced}`;
    const start = { title: truncate(`Investigate: ${topic.replace(/\s+/g, ' ')}`, 80), owner: who.account, prompt, untrusted: true, ...(inv.model ? { model: inv.model } : {}), ...(inv.mode ? { mode: inv.mode } : {}), ...(inv.runtime ? { runtime: inv.runtime } : {}), ...(inv.workflow ? { workflow: { name: inv.workflow, input: { [inv.workflowInput ?? 'symptom']: fenced } } } : {}) };
    // The thread first, so the session's first events have somewhere to go.
    let ref = where.ref;
    if (!ref) {
      const head = this.clean(`Investigation requested by ${platform === 'slack' ? userKey : (display ?? userKey)}: ${topic}`, 2000);
      const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: `Investigation requested by ${platform === 'slack' && display ? display : esc(userKey)}: ${esc(this.clean(topic, 2800))}` } }];
      if (where.slackChannel) {
        const posted = await this.bg.slack.post({ channel: where.slackChannel, text: head, blocks });
        ref = { type: 'slack', channel: posted.channel ?? where.slackChannel, ts: posted.ts };
      } else ref = await this.postRoot(where.channel, { text: head, blocks, card: textCard(head) });
    }
    const { id: sessionId } = await this.api.sessions.start(start);
    this.store.data.sessions[sessionId] = { ...(this.store.data.sessions[sessionId] ?? {}), origin: { platform, by: userKey, ref }, account: who.account };
    this.store.save();
    const url = this.sessionUrl(sessionId);
    const t = `Started an investigation${url ? `: ${url}` : ` (session ${sessionId})`}. Progress and the summary will be posted in this thread.`;
    await this.reply(ref, { text: t, card: textCard(t) });
    this.audit({ action: 'investigate', platform, by: userKey, account: who.account, session: sessionId, result: 'ok' });
    return { ok: true, sessionId };
  }

  noteProgress(sessionId, { tool, step }) {
    const s = this.store.data.sessions[sessionId];
    if (!s?.origin) return;
    const p = this.progress.get(sessionId) ?? { tools: 0, last: '', step: '', timer: undefined, ref: s.progressRef };
    if (tool) { p.tools++; p.last = tool; }
    if (step) p.step = step;
    this.progress.set(sessionId, p);
    if (!p.timer) {
      p.timer = setTimeout(() => { p.timer = undefined; this.track(this.flushProgress(sessionId)); }, this.config.progressEveryMs ?? 15_000);
      p.timer.unref?.();
    }
  }

  /** One progress message per session, edited in place (serialized: the first post must land before an edit). */
  flushProgress(sessionId) {
    return this.queue.run(`progress:${sessionId}`, async () => {
      const s = this.store.data.sessions[sessionId];
      const p = this.progress.get(sessionId);
      if (!s?.origin || !p) return;
      const t = `Working: ${p.tools} tool call(s)${p.last ? `, latest ${p.last}` : ''}${p.step ? `; step ${p.step}` : ''}.`;
      if (t === p.shown) return;
      const msg = { text: t, card: textCard(t) };
      if (p.ref && p.ref.type !== 'teams-webhook') await this.edit(p.ref, msg);
      else { p.ref = await this.reply(s.origin.ref, msg); s.progressRef = p.ref; this.store.save(); }
      p.shown = t;
    });
  }

  async turnEnded(sessionId, reason) {
    const s = this.store.data.sessions[sessionId];
    if (!s?.origin) return;
    const p = this.progress.get(sessionId);
    if (p?.timer) { clearTimeout(p.timer); p.timer = undefined; }
    if (p) await this.flushProgress(sessionId).catch(() => {});
    const text = this.lastText.get(sessionId);
    const head = reason && reason !== 'done' ? `The investigation stopped (${reason}).` : 'Investigation summary:';
    const t = this.clean(`${head}\n\n${text ?? '(no summary was written)'}`, 2900);
    await this.queue.run(`progress:${sessionId}`, () => this.reply(s.origin.ref, { text: t, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: esc(t) } }], card: textCard(t) }));
    this.audit({ action: 'investigate.summary', session: sessionId, result: 'ok' });
  }

  // ---------------- Slack routes ----------------

  async slackVerified(req) {
    if (!this.config.slack?.signingSecret) return { status: 404, body: 'Slack is not configured' };
    if (!this.limits.inbound.allow(`slack:${req.ip ?? ''}`)) return { status: 429, body: 'slow down' };
    let secret;
    try { secret = await this.creds.get(this.config.slack.signingSecret, 'verify a Slack request'); } catch (e) { this.log(`integrations: ${e.message}`); return { status: 503, body: 'not configured' }; }
    const v = verifySlackRequest({ headers: lower(req.headers), body: req.body, signingSecret: secret });
    if (!v.ok) { this.audit({ action: 'slack.refused', reason: v.reason, ip: req.ip, result: 'denied' }); return { status: 401, body: 'invalid request signature' }; }
    return undefined;
  }

  /** POST slack/interactivity: Block Kit button clicks. Acknowledged at once; the work follows. */
  async slackInteractivity(req) {
    const bad = await this.slackVerified(req);
    if (bad) return bad;
    let payload;
    try { payload = JSON.parse(new URLSearchParams(req.body.toString('utf8')).get('payload') ?? ''); } catch { return { status: 400, body: 'no payload' }; }
    if (payload?.type !== 'block_actions') return ok();
    const action = (payload.actions ?? []).find((a) => /^harness_(approve|reject|allow|deny)$/.test(a.action_id ?? ''));
    if (!action) return ok();
    let v;
    try { v = JSON.parse(action.value); } catch { return ok(); }
    const user = String(payload.user?.id ?? '');
    const channel = payload.channel?.id ?? payload.container?.channel_id;
    const ts = payload.container?.message_ts ?? payload.message?.ts;
    this.track((async () => {
      const slack = this.bg.slack;
      const tell = async (text) => {
        if (payload.response_url) await slack.respond(payload.response_url, { response_type: 'ephemeral', replace_original: false, text }).catch(() => slack.ephemeral({ channel, user, text }));
        else await slack.ephemeral({ channel, user, text });
      };
      if (!this.limits.clicks.allow(`slack:${user}`)) return tell('Too many clicks; wait a minute.');
      const r = await this.decide({ platform: 'slack', userKey: `slack:${user}`, id: { slackId: user }, requestId: String(v.r ?? ''), decision: String(v.d ?? ''), lookupEmail: () => slack.userEmail(user), display: `<@${user}>` });
      if (!r.ok) return tell(r.message);
      const p = r.pending;
      // The clicked message is the one we posted; edit it (and any other copy) to show who decided.
      if (p.ref?.type === 'slack' && (p.ref.ts !== ts || p.ref.channel !== channel)) this.log('integrations: a decision came from a message other than the one posted');
      await this.showDecision(p, { decision: r.decision, who: `<@${user}>` });
    })());
    return ok();
  }

  /** POST slack/commands: "/harness investigate <text>". Answered at once (ephemeral); the session starts after. */
  async slackCommand(req) {
    const bad = await this.slackVerified(req);
    if (bad) return bad;
    const f = new URLSearchParams(req.body.toString('utf8'));
    const text = String(f.get('text') ?? '').trim();
    const user = String(f.get('user_id') ?? '');
    const m = /^investigate\b\s*([\s\S]*)$/i.exec(text);
    if (!m) return json(200, { response_type: 'ephemeral', text: `Usage: ${this.config.slack.command} investigate <what is wrong>` });
    // The thread goes in the operator's investigations channel, else the channel the command came from.
    const where = this.config.investigate.channel ? { channel: this.config.investigate.channel } : { slackChannel: String(f.get('channel_id') ?? '') };
    const responseUrl = f.get('response_url');
    this.track((async () => {
      const slack = this.bg.slack;
      const r = await this.investigate({ platform: 'slack', userKey: `slack:${user}`, id: { slackId: user }, text: m[1], where, lookupEmail: () => slack.userEmail(user), display: `<@${user}>` });
      if (!r.ok) {
        if (responseUrl) await slack.respond(responseUrl, { response_type: 'ephemeral', text: r.message });
        else await slack.ephemeral({ channel: where.slackChannel, user, text: r.message });
      }
    })());
    return json(200, { response_type: 'ephemeral', text: 'Starting the investigation...' });
  }

  /** POST slack/events: the Events API (url_verification, app_mention). Retries are recognised and dropped. */
  async slackEvents(req) {
    const bad = await this.slackVerified(req);
    if (bad) return bad;
    let body;
    try { body = JSON.parse(req.body.toString('utf8')); } catch { return { status: 400, body: 'not JSON' }; }
    if (body.type === 'url_verification') return json(200, { challenge: body.challenge });
    if (body.type !== 'event_callback') return ok();
    const eventId = String(body.event_id ?? '');
    if (eventId && !this.store.firstTime(`slack:${eventId}`)) return { status: 200, headers: { 'content-type': 'text/plain', 'x-slack-no-retry': '1' }, body: '' };
    const ev = body.event ?? {};
    if (ev.type === 'app_mention' && !ev.bot_id) {
      const text = String(ev.text ?? '').replace(/<@[A-Z0-9]+>/g, ' ').trim();
      const m = /^investigate\b\s*([\s\S]*)$/i.exec(text);
      if (m) {
        const user = String(ev.user ?? '');
        this.track((async () => {
          const slack = this.bg.slack;
          const ref = { type: 'slack', channel: ev.channel, ts: ev.thread_ts ?? ev.ts };
          const r = await this.investigate({ platform: 'slack', userKey: `slack:${user}`, id: { slackId: user }, text: m[1], where: { ref }, lookupEmail: () => slack.userEmail(user), display: `<@${user}>` });
          if (!r.ok) await slack.ephemeral({ channel: ev.channel, user, text: r.message, thread_ts: ref.ts });
        })());
      }
    }
    return ok();
  }

  // ---------------- Teams route ----------------

  /** POST teams/messages: the bot's messaging endpoint (Azure Bot configuration). */
  async teamsMessages(req) {
    const t = this.config.teams;
    if (!t?.appId || !this.keys) return { status: 404, body: 'Teams is not configured' };
    if (!this.limits.inbound.allow(`teams:${req.ip ?? ''}`)) return { status: 429, body: 'slow down' };
    let activity;
    try { activity = JSON.parse(req.body.toString('utf8')); } catch { return { status: 400, body: 'not JSON' }; }
    try {
      await verifyBotRequest({ authorization: lower(req.headers).authorization, activity, appId: t.appId, issuer: t.issuer, keys: this.keys });
    } catch (e) {
      this.audit({ action: 'teams.refused', reason: e.message, ip: req.ip, result: 'denied' });
      return { status: e instanceof BotAuthError ? e.status : 401, body: 'unauthorized' };
    }
    // The conversation ids and serviceUrl an operator needs for channels.<name>.teams, recorded once each.
    const conv = activity.conversation?.id;
    if (conv && this.store.firstTime(`teams-conv:${conv}`)) this.audit({ action: 'teams.conversation', conversationId: conv, serviceUrl: activity.serviceUrl, tenant: activity.conversation?.tenantId ?? activity.channelData?.tenant?.id, team: activity.channelData?.team?.name, channel: activity.channelData?.channel?.name, result: 'ok' });
    const from = activity.from ?? {};
    const userKey = `teams:${from.aadObjectId ?? from.id}`;
    const id = { teamsAad: from.aadObjectId, teamsId: from.id };
    const lookupEmail = async () => {
      const m = await this.bg.teams.member(activity.serviceUrl, activity.conversation?.id, from.id);
      return String(m.email ?? m.userPrincipalName ?? '').toLowerCase() || undefined;
    };
    if (activity.type === 'invoke' && activity.name === 'adaptiveCard/action') {
      const a = activity.value?.action ?? {};
      if (a.verb !== 'harness.decide') return messageInvokeResponse('Unknown action.');
      if (!this.limits.clicks.allow(userKey)) return messageInvokeResponse('Too many clicks; wait a minute.');
      const r = await this.decide({ platform: 'teams', userKey, id, requestId: String(a.data?.requestId ?? ''), decision: String(a.data?.decision ?? ''), lookupEmail, display: from.name ?? userKey });
      if (!r.ok) return messageInvokeResponse(r.message);
      const card = decidedCard(r.pending.msg.card, { decision: r.decision, who: r.who });
      // Everyone else's copy too (the invoke response replaces only the clicker's).
      if (r.pending.ref?.type === 'teams') this.track(this.edit(r.pending.ref, { card }));
      else this.track(this.showDecision(r.pending, { decision: r.decision, who: r.who }));
      return cardInvokeResponse(card);
    }
    if (activity.type === 'message') {
      const text = messageText(activity);
      const m = /^investigate\b\s*([\s\S]*)$/i.exec(text);
      if (m) {
        const ref = { type: 'teams', serviceUrl: activity.serviceUrl, conversationId: activity.conversation?.id, activityId: activity.id };
        this.track((async () => {
          const r = await this.investigate({ platform: 'teams', userKey, id, text: m[1], where: { ref }, lookupEmail, display: from.name ?? userKey });
          if (!r.ok) await this.reply(ref, { text: r.message, card: textCard(r.message) });
        })());
      }
    }
    return { status: 200, headers: { 'content-type': 'application/json' }, body: '{}' };
  }
}

function lower(h = {}) {
  const out = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  return out;
}
