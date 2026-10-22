// Integrations: two-way chat (Slack, Microsoft Teams), paging (PagerDuty,
// Opsgenie) and ticketing (Jira Cloud, ServiceNow) for the harness.
//  - Incidents (from the aiops plugin) and approval/permission requests reach a
//    channel, threaded per incident or session; approvers decide from the chat.
//  - "investigate <text>" in a chat starts a session; its progress and summary
//    come back in the thread.
//  - Pages and tickets follow incidents as the operator's routing rules say.
//  - Agent tools: notify, page, ticket (external: asked unless an operator rule allows).
// Destinations come only from the operator's file (HARNESS_INTEGRATIONS); every
// credential is a Key Vault entry named int-*, used on the server and never shown.

import path from 'node:path';
import os from 'node:os';
import { credentialNames, normalizeConfig, readConfigSource, routeFor } from './lib/config.mjs';
import { Hub } from './lib/hub.mjs';
import { Store } from './lib/store.mjs';
import { adf, incidentDescription, textToAdf } from './lib/ticketing.mjs';
import { esc } from './lib/slack.mjs';
import { textCard } from './lib/teams.mjs';
import { SEVERITIES } from './lib/util.mjs';

const str = (v) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const err = (m) => ({ content: m, is_error: true });

export const ROUTES = {
  slackInteractivity: 'slack/interactivity',
  slackCommands: 'slack/commands',
  slackEvents: 'slack/events',
  teamsMessages: 'teams/messages',
  status: 'status',
};

/** Builds everything from an api (the harness's, or a test's). Returns the hub, tools and routes it registered. */
export function createIntegrations(api, { config: given } = {}) {
  let raw = given;
  if (raw === undefined) {
    let src;
    try { src = api.secret?.('HARNESS_INTEGRATIONS'); } catch { src = undefined; }
    try { raw = readConfigSource(src); } catch (e) { api.log?.(`HARNESS_INTEGRATIONS could not be read: ${e.message}`); raw = {}; }
  }
  const { config, errors } = normalizeConfig(raw);
  for (const e of errors) api.log?.(`configuration: ${e}`);
  const dataDir = api.dataDir ?? path.join(os.tmpdir(), 'harness-plugin-data', 'plugin-data', 'integrations');
  const store = new Store(dataDir);
  const fetchFn = api.fetch ? (u, i) => api.fetch(u, i) : fetch;
  const hub = new Hub({ api, config, store, fetch: fetchFn, log: (m) => api.log?.(m) });
  const tools = [];
  const reg = (t) => { tools.push(t); api.registerTool(t); };

  // ---------------- routes ----------------
  const routes = [];
  const guard = (fn) => async (req) => {
    try {
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? '');
      return await fn({ ...req, headers: req.headers ?? {}, body });
    } catch (e) {
      api.log?.(`integrations route: ${hub.clean(e.message, 300)}`);
      return { status: 500, headers: { 'content-type': 'text/plain' }, body: 'error' };
    }
  };
  const route = (method, p, auth, handler) => { const r = { method, path: p, auth, handler: guard(handler) }; routes.push(r); if (typeof api.registerRoute === 'function') api.registerRoute(r); };
  if (config.slack) {
    route('POST', ROUTES.slackInteractivity, 'none', (req) => hub.slackInteractivity(req));
    route('POST', ROUTES.slackCommands, 'none', (req) => hub.slackCommand(req));
    route('POST', ROUTES.slackEvents, 'none', (req) => hub.slackEvents(req));
  }
  if (config.teams) route('POST', ROUTES.teamsMessages, 'none', (req) => hub.teamsMessages(req));
  route('GET', ROUTES.status, 'token', async () => ({
    status: 200, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      configured: ['slack', 'teams', 'pagerduty', 'opsgenie', 'jira', 'servicenow'].filter((k) => config[k]),
      channels: Object.values(config.channels).map((c) => ({ name: c.name, type: c.type })),
      routes: config.routes.length, approvers: config.approvers.length, errors,
      harness: { routes: typeof api.registerRoute === 'function', events: typeof api.events?.subscribe === 'function', sessions: typeof api.sessions?.respond === 'function', serverVault: typeof api.vault?.reveal === 'function' },
    }),
  }));
  if (typeof api.registerRoute !== 'function' && (config.slack || config.teams)) api.log?.('this harness has no plugin routes (api.registerRoute): Slack and Teams cannot reach the plugin, so chat decisions and investigations are off; notifications still go out');
  let unsubscribe;
  if (typeof api.events?.subscribe === 'function') unsubscribe = api.events.subscribe((e) => hub.onEvent(e));
  else api.log?.('this harness has no event feed (api.events): incidents and approvals are not forwarded automatically; the notify, page and ticket tools still work');

  // ---------------- tools ----------------
  const channelOf = (input) => {
    const name = str(input.channel);
    if (name) return config.channels[name];
    const rec = input.incident ? store.data.incidents[str(input.incident)] : undefined;
    return config.channels[(rec ? routeFor(config, rec).channel : undefined) ?? config.defaults.channel];
  };
  const chanCreds = (ch) => (ch ? credentialNames(config, ch.type === 'slack' ? 'slack' : ch.type === 'teams' ? 'teams' : 'teams-webhook', { url: ch.url }) : []);

  if (Object.keys(config.channels).length) {
    reg({
      name: 'notify',
      description: `Posts a message to a chat channel the operator configured (${Object.entries(config.channels).map(([n, c]) => `${n}: ${c.type}`).join(', ')}; default ${config.defaults.channel}). With incident (an inc-... id), it goes in that incident's thread in its routed channel. The text is yours: say what happened, the evidence and what you need. It leaves the harness: asked unless an operator rule allows notify(<channel>).`,
      parameters: { type: 'object', properties: { text: { type: 'string', description: 'The message (plain text, up to about 3000 characters).' }, channel: { type: 'string', description: 'A configured channel name.' }, incident: { type: 'string', description: 'Thread under this incident (inc-...).' } }, required: ['text'] },
      kind: 'external',
      sendsOut: true,
      ruleSubject: (i) => channelOf(i)?.name ?? str(i.channel),
      vaultNames: (i) => chanCreds(channelOf(i)),
      summarize: (i) => `notify ${channelOf(i)?.name ?? str(i.channel) ?? '?'}${i.incident ? ` (${str(i.incident)})` : ''}: ${str(i.text).slice(0, 80)}`,
      async run(input, ctx) {
        const ch = channelOf(input);
        if (!ch) return err(`No channel named "${str(input.channel)}". Configured: ${Object.keys(config.channels).join(', ') || 'none'}.`);
        const text = hub.clean(str(input.text).trim(), 3000);
        if (!text) return err('notify needs text');
        const cl = hub.clients(ctx.services?.vault);
        const msg = { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: esc(text) } }, { type: 'context', elements: [{ type: 'mrkdwn', text: 'Posted by a harness agent' }] }], card: textCard(text) };
        try {
          const inc = str(input.incident);
          const rec = inc ? store.data.incidents[inc] : undefined;
          let where;
          if (inc && rec && !input.channel) where = await hub.toThread(`incident:${inc}`, ch.name, hub.incidentMsg(rec), msg, cl);
          else where = await hub.postRoot(ch.name, msg, cl);
          hub.audit({ action: 'notify', channel: ch.name, incident: inc || undefined, result: 'ok' });
          return `Posted to ${ch.name} (${ch.type}${where?.thread ? ', in the incident thread' : ''}).`;
        } catch (e) {
          hub.audit({ action: 'notify', channel: ch.name, result: 'error', reason: hub.clean(e.message, 300) });
          return err(`notify ${ch.name}: ${hub.clean(e.message, 500)}`);
        }
      },
    });
  }

  const providers = ['pagerduty', 'opsgenie'].filter((k) => config[k]);
  if (providers.length) {
    const pickProvider = (i) => {
      if (i.provider) return str(i.provider);
      const rec = store.data.incidents[str(i.incident)];
      const r = routeFor(config, rec ?? { severity: str(i.severity) || undefined, services: i.service ? [str(i.service)] : [] });
      return providers.find((p) => r[p]) ?? providers[0];
    };
    const routeOf = (i) => routeFor(config, store.data.incidents[str(i.incident)] ?? { severity: str(i.severity) || undefined, services: i.service ? [str(i.service)] : [] });
    const pageCreds = (i) => {
      const p = pickProvider(i);
      if (p === 'opsgenie') return credentialNames(config, 'opsgenie');
      if (['note', 'oncall'].includes(str(i.action))) return credentialNames(config, 'pagerduty-rest');
      return credentialNames(config, 'pagerduty', { routingKey: routeOf(i).pagerduty?.routingKey });
    };
    reg({
      name: 'page',
      description: `Pages people (${providers.join(', ')}): "trigger" (incident, summary, severity sev1-sev4, service), "acknowledge", "resolve", "note" (adds note text to the page's incident), and "oncall" (who is on call for the incident's service or escalation_policy; PagerDuty). Pages are keyed by the incident id (PagerDuty dedup_key, Opsgenie alias), so a repeat updates the same page. Routing (which service, escalation and responders) comes from the operator's configuration. Acts on another system: asked unless an operator rule allows it.`,
      parameters: { type: 'object', properties: {
        action: { type: 'string', enum: ['trigger', 'acknowledge', 'resolve', 'note', 'oncall'] },
        incident: { type: 'string', description: 'The incident id (inc-...): the page key.' },
        summary: { type: 'string' }, severity: { type: 'string', enum: SEVERITIES }, service: { type: 'string' },
        note: { type: 'string' }, provider: { type: 'string', enum: providers }, escalation_policy: { type: 'string', description: 'oncall: a PagerDuty escalation policy id, when the route names none.' },
      }, required: ['action'] },
      kind: 'external',
      kindsFor: (i) => (str(i.action) === 'oncall' ? ['network'] : ['external']),
      sendsOut: (i) => str(i.action) !== 'oncall',
      ruleSubject: (i) => `${pickProvider(i)} ${str(i.action)}`,
      vaultNames: pageCreds,
      summarize: (i) => `page ${pickProvider(i)} ${str(i.action)} ${str(i.incident)}${i.summary ? `: ${str(i.summary).slice(0, 60)}` : ''}`,
      async run(input, ctx) {
        const action = str(input.action);
        const provider = pickProvider(input);
        const inc = str(input.incident);
        const rec = store.data.incidents[inc];
        const key = rec?.group ?? inc;
        const sev = str(input.severity) || rec?.severity || 'sev3';
        const cl = hub.clients(ctx.services?.vault);
        const route = routeOf(input);
        try {
          let out;
          if (action === 'oncall') {
            if (provider !== 'pagerduty' || !config.pagerduty.apiToken) return err('oncall needs PagerDuty with a REST API token (pagerduty.apiToken)');
            const policy = str(input.escalation_policy) || route.pagerduty?.escalationPolicy;
            if (!policy) return err('No escalation policy: name one (escalation_policy) or route the service to one in the configuration.');
            const users = await cl.pd.onCall(policy);
            out = users.length ? users.map((u) => `level ${u.level ?? '?'}: ${u.name}${u.email ? ` <${u.email}>` : ''}`).join('\n') : 'Nobody is on call for that policy now.';
          } else {
            if (!/^[\w.:-]{1,200}$/.test(key)) return err('page needs incident: the incident id (the page key)');
            if (provider === 'pagerduty') {
              const routingKey = route.pagerduty?.routingKey ?? config.pagerduty.routingKey;
              if (action === 'note') {
                if (!config.pagerduty.apiToken) return err('notes need a PagerDuty REST API token (pagerduty.apiToken)');
                const found = rec?.pd?.incidentId ? { id: rec.pd.incidentId } : await cl.pd.findIncident(key);
                if (!found?.id) return err(`No PagerDuty incident for ${key} yet.`);
                await cl.pd.addNote(found.id, hub.clean(str(input.note), 25_000));
                out = `Note added to PagerDuty incident ${found.id}.`;
              } else {
                if (!routingKey) return err('No PagerDuty routing key for this route (pagerduty.routingKey).');
                const r = await cl.pd.event({ action, dedupKey: key, routingKey, summary: hub.clean(str(input.summary) || `[${sev}] ${rec?.title ?? inc}`, 1024), source: str(input.service) || rec?.services?.[0] || 'harness', severity: config.pagerduty.severity[sev] ?? 'error', cls: 'harness-incident', details: { incident: inc } });
                if (rec) { rec.pd = { ...(rec.pd ?? {}), dedupKey: key, triggered: true, ...(action === 'acknowledge' ? { acked: true } : {}), ...(action === 'resolve' ? { resolved: true } : {}) }; store.save(); }
                out = `PagerDuty ${action}: ${r.status ?? 'sent'} (dedup_key ${key}).`;
              }
            } else {
              const og = cl.og;
              let r;
              if (action === 'trigger') r = await og.create({ alias: key, message: hub.clean(str(input.summary) || `[${sev}] ${rec?.title ?? inc}`, 130), description: hub.clean(str(input.note) || rec?.summary || '', 15_000), priority: config.opsgenie.priority[sev] ?? 'P3', responders: route.opsgenie?.responders ?? [], tags: ['harness', ...(route.opsgenie?.tags ?? [])], details: { incident: inc }, entity: str(input.service) || undefined });
              else if (action === 'acknowledge') r = await og.acknowledge(key, str(input.note) || undefined);
              else if (action === 'resolve') r = await og.close(key, str(input.note) || undefined);
              else r = await og.note(key, hub.clean(str(input.note), 25_000));
              out = `Opsgenie ${action === 'resolve' ? 'close' : action}: accepted (request ${r.requestId ?? '-'}, alias ${key}).`;
            }
          }
          hub.audit({ action: `page.${action}`, system: provider, incident: inc || undefined, result: 'ok' });
          return hub.clean(out, 4000);
        } catch (e) {
          hub.audit({ action: `page.${action}`, system: provider, incident: inc || undefined, result: 'error', reason: hub.clean(e.message, 300) });
          return err(`page ${provider} ${action}: ${hub.clean(e.message, 500)}`);
        }
      },
    });
  }

  const systems = [['jira', 'jira'], ['servicenow', 'servicenow']].filter(([k]) => config[k]).map(([k]) => k);
  if (systems.length) {
    const pickSystem = (i) => {
      if (i.system) return str(i.system);
      const rec = store.data.incidents[str(i.incident)];
      const r = routeFor(config, rec ?? { severity: str(i.severity) || undefined, services: i.service ? [str(i.service)] : [] });
      return systems.find((s) => r[s]) ?? systems[0];
    };
    reg({
      name: 'ticket',
      description: `Tickets for incidents (${systems.join(', ')}): "create" (incident, title, description, severity, service: one ticket per incident - a repeat returns the existing one), "comment" (adds comment text; ServiceNow work notes), "resolve" (root_cause and resolution: Jira moves to done, ServiceNow resolves with close notes). Project, issue type, fields and assignment come from the operator's configuration. Acts on another system: asked unless an operator rule allows it.`,
      parameters: { type: 'object', properties: {
        action: { type: 'string', enum: ['create', 'comment', 'resolve'] },
        incident: { type: 'string', description: 'The incident id (inc-...).' },
        title: { type: 'string' }, description: { type: 'string' }, severity: { type: 'string', enum: SEVERITIES }, service: { type: 'string' },
        comment: { type: 'string' }, root_cause: { type: 'string' }, resolution: { type: 'string' }, system: { type: 'string', enum: systems },
      }, required: ['action', 'incident'] },
      kind: 'external',
      sendsOut: true,
      ruleSubject: (i) => `${pickSystem(i)} ${str(i.action)}`,
      vaultNames: (i) => credentialNames(config, pickSystem(i)),
      summarize: (i) => `ticket ${pickSystem(i)} ${str(i.action)} ${str(i.incident)}${i.title ? `: ${str(i.title).slice(0, 60)}` : ''}`,
      async run(input, ctx) {
        const action = str(input.action);
        const system = pickSystem(input);
        const inc = str(input.incident);
        if (!/^[\w.:-]{1,200}$/.test(inc)) return err('ticket needs incident: the incident id');
        const cl = hub.clients(ctx.services?.vault);
        const incidents = store.data.incidents;
        const rec = incidents[inc] ?? (incidents[inc] = { id: inc, services: [], evidence: [], status: 'investigating' });
        if (input.title && !rec.title) rec.title = str(input.title);
        if (input.severity && !rec.severity) rec.severity = str(input.severity);
        if (input.service) rec.services = [...new Set([...(rec.services ?? []), str(input.service)])];
        if (input.description && !rec.summary) rec.summary = str(input.description);
        const route = routeFor(config, rec);
        try {
          let out;
          if (system === 'jira') {
            const jira = cl.jira;
            if (!rec.jira?.key) {
              const existing = await jira.findByLabel(`harness-${inc}`).catch(() => undefined);
              if (existing) rec.jira = { key: existing, url: `${config.jira.baseUrl}/browse/${existing}` };
            }
            if (action === 'create') {
              if (rec.jira?.key) out = `Jira ${rec.jira.key} already exists for ${inc}: ${rec.jira.url}`;
              else {
                const project = route.jira?.project ?? config.jira.project;
                if (!project) return err('No Jira project configured (jira.project or a route\'s).');
                const made = await jira.create({ project, issueType: route.jira?.issueType ?? config.jira.issueType, summary: hub.clean(str(input.title) || `[${rec.severity ?? 'sev3'}] ${rec.title ?? inc}`, 255), description: incidentDescription({ ...rec, summary: hub.clean(str(input.description) || rec.summary || '', 20_000) }, { sessionUrl: hub.sessionUrl(rec.sessionId) }), labels: ['harness', `harness-${inc}`, ...config.jira.labels, ...(route.jira?.labels ?? [])], priority: config.jira.priority?.[rec.severity], fields: { ...config.jira.fields, ...(route.jira?.fields ?? {}) } });
                rec.jira = { key: made.key, url: made.url };
                out = `Created Jira ${made.key}: ${made.url}`;
              }
            } else {
              if (!rec.jira?.key) return err(`No Jira issue for ${inc} yet: create one first.`);
              if (action === 'comment') { await jira.comment(rec.jira.key, adf.doc(textToAdf(hub.clean(str(input.comment), 30_000)))); out = `Commented on Jira ${rec.jira.key}.`; }
              else {
                if (input.root_cause) rec.rootCause = str(input.root_cause);
                if (input.resolution) rec.resolution = str(input.resolution);
                const r = await jira.resolve(rec.jira.key, { comment: adf.doc(textToAdf(hub.summaryFor(rec))) });
                out = `Jira ${rec.jira.key}: ${r.transition}${r.status ? ` -> ${r.status}` : ''}.`;
              }
            }
          } else {
            const snow = cl.snow;
            if (!rec.snow?.sysId) {
              const existing = await snow.findByCorrelation(inc).catch(() => undefined);
              if (existing) rec.snow = { ...existing, url: `${config.servicenow.instanceUrl}/nav_to.do?uri=incident.do?sys_id=${existing.sysId}` };
            }
            if (action === 'create') {
              if (rec.snow?.sysId) out = `ServiceNow ${rec.snow.number} already exists for ${inc}.`;
              else {
                const made = await snow.create({ inc: { ...rec, severity: rec.severity ?? 'sev3' }, shortDescription: hub.clean(str(input.title) || `[${rec.severity ?? 'sev3'}] ${rec.title ?? inc}`, 160), description: hub.clean(`${str(input.description) || rec.summary || ''}\n\nHarness incident ${inc}`, 30_000), assignmentGroup: route.servicenow?.assignmentGroup, fields: route.servicenow?.fields });
                rec.snow = made;
                out = `Created ServiceNow ${made.number}: ${made.url}`;
              }
            } else {
              if (!rec.snow?.sysId) return err(`No ServiceNow incident for ${inc} yet: create one first.`);
              if (action === 'comment') { await snow.workNote(rec.snow.sysId, hub.clean(str(input.comment), 30_000)); out = `Work note added to ${rec.snow.number}.`; }
              else {
                if (input.root_cause) rec.rootCause = str(input.root_cause);
                if (input.resolution) rec.resolution = str(input.resolution);
                await snow.resolve(rec.snow.sysId, { closeNotes: hub.summaryFor(rec) });
                out = `Resolved ServiceNow ${rec.snow.number}.`;
              }
            }
          }
          store.save();
          hub.audit({ action: `ticket.${action}`, system, incident: inc, result: 'ok' });
          return hub.clean(out, 4000);
        } catch (e) {
          store.save();
          hub.audit({ action: `ticket.${action}`, system, incident: inc, result: 'error', reason: hub.clean(e.message, 300) });
          return err(`ticket ${system} ${action}: ${hub.clean(e.message, 500)}`);
        }
      },
    });
  }

  const close = async () => {
    try { unsubscribe?.(); } catch { /* gone */ }
    await hub.drain();
    store.flush();
  };
  return { hub, store, config, errors, tools, routes, close };
}

export default {
  name: 'integrations',
  setup(api) {
    this.instance = createIntegrations(api);
    const c = this.instance.config;
    api.log?.(`integrations: ${['slack', 'teams', 'pagerduty', 'opsgenie', 'jira', 'servicenow'].filter((k) => c[k]).join(', ') || 'nothing configured (HARNESS_INTEGRATIONS)'}`);
  },
  async close() {
    await this.instance?.close();
  },
};
