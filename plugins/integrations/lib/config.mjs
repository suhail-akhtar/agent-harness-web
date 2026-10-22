// The operator's integrations file (HARNESS_INTEGRATIONS: JSON, or @<path> to a
// JSON file). It names where things go - channels, routing rules, escalation
// and projects - and who may decide from a chat. It never holds a credential:
// every secret is named by a Key Vault entry (int-*), resolved on the server.

import fs from 'node:fs';
import { SEVERITIES, globMatch } from './util.mjs';

const VAULT_NAME = /^int-[A-Za-z0-9._-]{1,120}$/;

const DEFAULTS = {
  slack: { apiBase: 'https://slack.com/api', hooksBase: 'https://hooks.slack.com' },
  teams: {
    loginBase: 'https://login.microsoftonline.com',
    openIdMetadata: 'https://login.botframework.com/v1/.well-known/openidconfiguration',
    issuer: 'https://api.botframework.com',
    serviceUrl: 'https://smba.trafficmanager.net/teams/',
    scope: 'https://api.botframework.com/.default',
  },
  pagerduty: { eventsBase: 'https://events.pagerduty.com', apiBase: 'https://api.pagerduty.com', severity: { sev1: 'critical', sev2: 'error', sev3: 'warning', sev4: 'info' }, ackOn: ['identified', 'mitigating', 'monitoring'] },
  opsgenie: { priority: { sev1: 'P1', sev2: 'P2', sev3: 'P3', sev4: 'P4' }, ackOn: ['identified', 'mitigating', 'monitoring'] },
  jira: { issueType: 'Task', doneCategory: 'done' },
  servicenow: {
    impact: { sev1: '1', sev2: '2', sev3: '2', sev4: '3' },
    urgency: { sev1: '1', sev2: '1', sev3: '2', sev4: '3' },
    resolvedState: '6', closeCode: 'Solution provided',
  },
};

/** Whether a URL is allowed as a service base: https, or http to this machine (local test doubles). */
function baseUrl(v, where, errors) {
  if (v === undefined) return undefined;
  try {
    const u = new URL(String(v));
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) { errors.push(`${where}: ${v} must be https`); return undefined; }
    return String(v).replace(/\/+$/, '');
  } catch { errors.push(`${where}: "${v}" is not a URL`); return undefined; }
}

function vaultName(v, where, errors, required = false) {
  if (v === undefined || v === null || v === '') { if (required) errors.push(`${where}: a Key Vault entry name (int-...) is required`); return undefined; }
  if (!VAULT_NAME.test(String(v))) { errors.push(`${where}: "${String(v).slice(0, 8)}..." is not a Key Vault entry name of the form int-<name> (credentials are never written in this file: store them in the Key Vault and name them here)`); return undefined; }
  return String(v);
}

const list = (v) => (v === undefined ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);
const sevMap = (base, over) => ({ ...base, ...(over && typeof over === 'object' ? over : {}) });

export function readConfigSource(raw) {
  if (!raw || !String(raw).trim()) return {};
  const s = String(raw).trim();
  const text = s.startsWith('@') ? fs.readFileSync(s.slice(1), 'utf8') : s.startsWith('{') ? s : fs.readFileSync(s, 'utf8');
  return JSON.parse(text);
}

/** Validates and fills in defaults. Returns { config, errors }; parts with errors are left out, never half-used. */
export function normalizeConfig(input) {
  const errors = [];
  const c = input && typeof input === 'object' ? input : {};
  const out = { publicUrl: undefined, channels: {}, routes: [], approvers: [], investigators: undefined, approvals: {}, investigate: {}, defaults: {} };
  if (c.publicUrl) out.publicUrl = baseUrl(c.publicUrl, 'publicUrl', errors);

  if (c.slack) {
    const e0 = errors.length;
    const s = {
      apiBase: baseUrl(c.slack.apiBase ?? DEFAULTS.slack.apiBase, 'slack.apiBase', errors),
      hooksBase: baseUrl(c.slack.hooksBase ?? DEFAULTS.slack.hooksBase, 'slack.hooksBase', errors),
      botToken: vaultName(c.slack.botToken, 'slack.botToken', errors, true),
      signingSecret: vaultName(c.slack.signingSecret, 'slack.signingSecret', errors),
      command: String(c.slack.command ?? '/harness'),
      minIntervalMs: Math.max(0, Number(c.slack.minIntervalMs ?? 1100)),
    };
    if (errors.length === e0) out.slack = s;
  }
  if (c.teams) {
    const e0 = errors.length;
    const t = {
      appId: String(c.teams.appId ?? ''),
      tenantId: c.teams.tenantId ? String(c.teams.tenantId) : undefined,
      appPassword: vaultName(c.teams.appPassword, 'teams.appPassword', errors),
      loginBase: baseUrl(c.teams.loginBase ?? DEFAULTS.teams.loginBase, 'teams.loginBase', errors),
      openIdMetadata: baseUrl(c.teams.openIdMetadata ?? DEFAULTS.teams.openIdMetadata, 'teams.openIdMetadata', errors),
      issuer: String(c.teams.issuer ?? DEFAULTS.teams.issuer),
      serviceUrl: baseUrl(c.teams.serviceUrl ?? DEFAULTS.teams.serviceUrl, 'teams.serviceUrl', errors),
      serviceUrlHosts: list(c.teams.serviceUrlHosts ?? ['smba.trafficmanager.net', '*.botframework.com', 'smba.infra.gcc.teams.microsoft.com']),
      scope: String(c.teams.scope ?? DEFAULTS.teams.scope),
    };
    if (c.teams.appPassword !== undefined && !t.appId) errors.push('teams.appId: the bot\'s Microsoft App ID is required');
    if (errors.length === e0) out.teams = t;
  }
  if (c.pagerduty) {
    const e0 = errors.length;
    const p = {
      eventsBase: baseUrl(c.pagerduty.eventsBase ?? DEFAULTS.pagerduty.eventsBase, 'pagerduty.eventsBase', errors),
      apiBase: baseUrl(c.pagerduty.apiBase ?? DEFAULTS.pagerduty.apiBase, 'pagerduty.apiBase', errors),
      apiToken: vaultName(c.pagerduty.apiToken, 'pagerduty.apiToken', errors),
      routingKey: vaultName(c.pagerduty.routingKey, 'pagerduty.routingKey', errors),
      from: c.pagerduty.from ? String(c.pagerduty.from) : undefined,
      severity: sevMap(DEFAULTS.pagerduty.severity, c.pagerduty.severity),
      ackOn: list(c.pagerduty.ackOn ?? DEFAULTS.pagerduty.ackOn),
    };
    if (p.apiToken && !p.from) errors.push('pagerduty.from: the email of a PagerDuty user is required for notes (the REST API\'s From header)');
    if (errors.length === e0) out.pagerduty = p;
  }
  if (c.opsgenie) {
    const e0 = errors.length;
    const region = String(c.opsgenie.region ?? 'us').toLowerCase();
    if (!['us', 'eu'].includes(region)) errors.push('opsgenie.region: us or eu');
    const o = {
      apiBase: baseUrl(c.opsgenie.apiBase ?? (region === 'eu' ? 'https://api.eu.opsgenie.com' : 'https://api.opsgenie.com'), 'opsgenie.apiBase', errors),
      apiKey: vaultName(c.opsgenie.apiKey, 'opsgenie.apiKey', errors, true),
      priority: sevMap(DEFAULTS.opsgenie.priority, c.opsgenie.priority),
      ackOn: list(c.opsgenie.ackOn ?? DEFAULTS.opsgenie.ackOn),
      source: String(c.opsgenie.source ?? 'harness'),
      user: String(c.opsgenie.user ?? 'harness'),
    };
    if (errors.length === e0) out.opsgenie = o;
  }
  if (c.jira) {
    const e0 = errors.length;
    const oauth = !!c.jira.oauthToken;
    const j = {
      baseUrl: baseUrl(c.jira.baseUrl, 'jira.baseUrl', errors),
      email: c.jira.email ? String(c.jira.email) : undefined,
      apiToken: vaultName(c.jira.apiToken, 'jira.apiToken', errors),
      oauthToken: vaultName(c.jira.oauthToken, 'jira.oauthToken', errors),
      cloudId: c.jira.cloudId ? String(c.jira.cloudId) : undefined,
      apiGateway: baseUrl(c.jira.apiGateway ?? 'https://api.atlassian.com', 'jira.apiGateway', errors),
      project: c.jira.project ? String(c.jira.project) : undefined,
      issueType: String(c.jira.issueType ?? DEFAULTS.jira.issueType),
      labels: list(c.jira.labels),
      priority: c.jira.priority && typeof c.jira.priority === 'object' ? c.jira.priority : undefined,
      fields: c.jira.fields && typeof c.jira.fields === 'object' ? c.jira.fields : {},
      doneTransition: c.jira.doneTransition ? String(c.jira.doneTransition) : undefined,
      resolution: c.jira.resolution ? String(c.jira.resolution) : undefined,
    };
    if (!c.jira.baseUrl) errors.push('jira.baseUrl: your site, https://<site>.atlassian.net, is required');
    if (oauth && !j.cloudId) errors.push('jira.cloudId: OAuth 2.0 calls go through api.atlassian.com/ex/jira/<cloudId>');
    if (!oauth && (!j.email || !j.apiToken)) errors.push('jira: email and apiToken (an Atlassian API token in the Key Vault) are required for basic auth, or oauthToken and cloudId');
    if (errors.length === e0) out.jira = j;
  }
  if (c.servicenow) {
    const e0 = errors.length;
    const sn = {
      instanceUrl: baseUrl(c.servicenow.instanceUrl, 'servicenow.instanceUrl', errors),
      user: c.servicenow.user ? String(c.servicenow.user) : undefined,
      password: vaultName(c.servicenow.password, 'servicenow.password', errors),
      oauthToken: vaultName(c.servicenow.oauthToken, 'servicenow.oauthToken', errors),
      clientId: c.servicenow.clientId ? String(c.servicenow.clientId) : undefined,
      clientSecret: vaultName(c.servicenow.clientSecret, 'servicenow.clientSecret', errors),
      impact: sevMap(DEFAULTS.servicenow.impact, c.servicenow.impact),
      urgency: sevMap(DEFAULTS.servicenow.urgency, c.servicenow.urgency),
      resolvedState: String(c.servicenow.resolvedState ?? DEFAULTS.servicenow.resolvedState),
      closeCode: String(c.servicenow.closeCode ?? DEFAULTS.servicenow.closeCode),
      fields: c.servicenow.fields && typeof c.servicenow.fields === 'object' ? c.servicenow.fields : {},
    };
    if (!c.servicenow.instanceUrl) errors.push('servicenow.instanceUrl: https://<instance>.service-now.com is required');
    if (!(sn.user && sn.password) && !sn.oauthToken && !(sn.clientId && sn.clientSecret)) errors.push('servicenow: user and password (basic auth), oauthToken, or clientId and clientSecret (OAuth client credentials) are required');
    if (errors.length === e0) out.servicenow = sn;
  }

  for (const [name, ch] of Object.entries(c.channels ?? {})) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) { errors.push(`channels: "${name}" is not a channel name (letters, digits, . _ -)`); continue; }
    if (ch?.slack) { if (!/^[CGD][A-Z0-9]{2,}$/.test(String(ch.slack))) { errors.push(`channels.${name}.slack: "${ch.slack}" is not a Slack channel id (C..., G...)`); continue; } out.channels[name] = { name, type: 'slack', channel: String(ch.slack) }; }
    else if (ch?.teams) out.channels[name] = { name, type: 'teams', conversationId: String(ch.teams), serviceUrl: ch.serviceUrl ? baseUrl(ch.serviceUrl, `channels.${name}.serviceUrl`, errors) : undefined };
    else if (ch?.teamsWebhook) { const v = vaultName(ch.teamsWebhook, `channels.${name}.teamsWebhook`, errors, true); if (v) out.channels[name] = { name, type: 'teams-webhook', url: v }; }
    else errors.push(`channels.${name}: needs slack (a channel id), teams (a conversation id) or teamsWebhook (a Key Vault entry holding a Workflows webhook URL)`);
  }
  for (const ch of Object.values(out.channels)) {
    if (ch.type === 'slack' && !out.slack) errors.push(`channels.${ch.name}: Slack is not configured (slack.botToken)`);
    if (ch.type === 'teams' && !out.teams?.appPassword) errors.push(`channels.${ch.name}: the Teams bot is not configured (teams.appId, teams.appPassword)`);
  }

  const people = (arr, where) => (Array.isArray(arr) ? arr : []).flatMap((a, i) => {
    if (!a || typeof a !== 'object' || !a.account) { errors.push(`${where}[${i}]: needs account (the harness account id the decision is made as)`); return []; }
    return [{ account: String(a.account), slack: list(a.slack), teams: list(a.teams), emails: list(a.emails).map((e) => e.toLowerCase()), scope: a.scope === 'own' ? 'own' : 'any', name: a.name ? String(a.name) : undefined }];
  });
  out.approvers = people(c.approvers, 'approvers');
  out.investigators = c.investigators === undefined ? out.approvers : people(c.investigators, 'investigators');

  out.defaults = { channel: c.defaults?.channel ? String(c.defaults.channel) : Object.keys(out.channels)[0] };
  out.approvals = {
    forward: ['all', 'incidents', 'none'].includes(c.approvals?.forward) ? c.approvals.forward : 'incidents',
    channel: c.approvals?.channel ? String(c.approvals.channel) : out.defaults.channel,
    onCallOnly: !!c.approvals?.onCallOnly,
  };
  out.investigate = {
    channel: c.investigate?.channel ? String(c.investigate.channel) : undefined,
    model: c.investigate?.model ? String(c.investigate.model) : undefined,
    mode: c.investigate?.mode ? String(c.investigate.mode) : undefined,
    runtime: c.investigate?.runtime && typeof c.investigate.runtime === 'object' ? c.investigate.runtime : undefined,
    workflow: c.investigate?.workflow ? String(c.investigate.workflow) : undefined,
    workflowInput: String(c.investigate?.workflowInput ?? 'symptom'),
    perUserPer10Min: Number(c.investigate?.perUserPer10Min ?? 5),
  };
  out.progressEveryMs = Math.max(50, Number(c.progressEveryMs ?? 15_000));

  for (const [i, r] of (Array.isArray(c.routes) ? c.routes : []).entries()) {
    const where = `routes[${i}]`;
    const sev = list(r?.severity);
    const bad = sev.filter((s) => !SEVERITIES.includes(s));
    if (bad.length) { errors.push(`${where}.severity: ${bad.join(', ')} (use ${SEVERITIES.join(', ')})`); continue; }
    const route = { severity: sev, service: list(r?.service), channel: r?.channel ? String(r.channel) : undefined };
    if (r?.pagerduty) route.pagerduty = { routingKey: vaultName(r.pagerduty.routingKey, `${where}.pagerduty.routingKey`, errors), escalationPolicy: r.pagerduty.escalationPolicy ? String(r.pagerduty.escalationPolicy) : undefined, severities: list(r.pagerduty.severities ?? SEVERITIES) };
    if (r?.opsgenie) route.opsgenie = { responders: Array.isArray(r.opsgenie.responders) ? r.opsgenie.responders : [], tags: list(r.opsgenie.tags), severities: list(r.opsgenie.severities ?? SEVERITIES) };
    if (r?.jira) route.jira = { project: r.jira.project ? String(r.jira.project) : undefined, issueType: r.jira.issueType ? String(r.jira.issueType) : undefined, labels: list(r.jira.labels), fields: r.jira.fields && typeof r.jira.fields === 'object' ? r.jira.fields : {}, severities: list(r.jira.severities ?? SEVERITIES) };
    if (r?.servicenow) route.servicenow = { assignmentGroup: r.servicenow.assignmentGroup ? String(r.servicenow.assignmentGroup) : undefined, fields: r.servicenow.fields && typeof r.servicenow.fields === 'object' ? r.servicenow.fields : {}, severities: list(r.servicenow.severities ?? SEVERITIES) };
    if (route.channel && !out.channels[route.channel]) errors.push(`${where}.channel: no channel named "${route.channel}"`);
    out.routes.push(route);
  }
  if (out.defaults.channel && !out.channels[out.defaults.channel]) errors.push(`defaults.channel: no channel named "${out.defaults.channel}"`);
  if (out.approvals.channel && !out.channels[out.approvals.channel]) errors.push(`approvals.channel: no channel named "${out.approvals.channel}"`);
  return { config: out, errors };
}

/**
 * The route for an incident: the first rule whose severity and service lists
 * match (an empty list matches anything), merged over the defaults. Paging and
 * ticketing are present only when that rule configures them for this severity.
 */
export function routeFor(config, inc = {}) {
  const sev = inc.severity;
  const services = Array.isArray(inc.services) ? inc.services : [];
  const rule = config.routes.find((r) => (!r.severity.length || r.severity.includes(sev)) && (!r.service.length || services.some((s) => r.service.some((p) => globMatch(p, s)))));
  const out = { channel: rule?.channel ?? config.defaults.channel };
  for (const k of ['pagerduty', 'opsgenie', 'jira', 'servicenow']) {
    const part = rule?.[k];
    if (part && config[k] && (!sev || part.severities.includes(sev))) out[k] = part;
  }
  return out;
}

/** The vault entry names a service's calls read. */
export function credentialNames(config, service, extra = {}) {
  switch (service) {
    case 'slack': return [config.slack?.botToken].filter(Boolean);
    case 'teams': return [config.teams?.appPassword].filter(Boolean);
    case 'teams-webhook': return [extra.url].filter(Boolean);
    case 'pagerduty': return [extra.routingKey ?? config.pagerduty?.routingKey, ...(extra.rest ? [config.pagerduty?.apiToken] : [])].filter(Boolean);
    case 'pagerduty-rest': return [config.pagerduty?.apiToken].filter(Boolean);
    case 'opsgenie': return [config.opsgenie?.apiKey].filter(Boolean);
    case 'jira': return [config.jira?.oauthToken ?? config.jira?.apiToken].filter(Boolean);
    case 'servicenow': return [config.servicenow?.oauthToken ?? (config.servicenow?.clientSecret && config.servicenow?.clientId ? config.servicenow.clientSecret : config.servicenow?.password)].filter(Boolean);
    default: return [];
  }
}
