// Microsoft Teams through the Bot Framework (an Azure Bot): proactive messages
// and replies with the Connector REST API, Adaptive Cards with Action.Execute
// (answered as adaptiveCard/action invoke activities), and verification of every
// request the Bot Connector sends us: a JWT in the Authorization header, issuer
// https://api.botframework.com, audience = our App ID, RS256 with a key from the
// OpenID metadata's jwks_uri (cached; refreshed daily and on an unknown key), a
// 5-minute clock skew, the serviceUrl claim equal to the activity's, and the
// channel endorsement. Plus the one-way Teams Workflows webhook.
// https://learn.microsoft.com/azure/bot-service/rest-api/bot-framework-rest-connector-authentication

import crypto from 'node:crypto';
import { request, truncate, globMatch } from './util.mjs';

const SKEW_SEC = 300;
const b64url = (s) => Buffer.from(s, 'base64url');

export class BotAuthError extends Error {
  constructor(message, status = 401) { super(message); this.status = status; }
}

/** The Bot Connector's signing keys, from its OpenID metadata, cached. */
export class OpenIdKeys {
  constructor({ metadataUrl, fetch, maxAgeMs = 24 * 3600_000 }) {
    this.metadataUrl = metadataUrl;
    this.fetch = fetch;
    this.maxAgeMs = maxAgeMs;
    this.loaded = 0;
    this.lastForced = 0;
    this.keys = new Map();
    this.algs = ['RS256'];
    this.issuer = undefined;
    this.inflight = undefined;
  }

  async load(force = false) {
    const now = Date.now();
    if (!force && this.loaded && now - this.loaded < this.maxAgeMs) return;
    if (force && now - this.lastForced < 5 * 60_000 && this.loaded) return; // an unknown kid refetches at most every 5 minutes
    if (force) this.lastForced = now;
    this.inflight ??= (async () => {
      try {
        const meta = (await request(this.fetch, this.metadataUrl, { service: 'Bot Framework OpenID metadata', retries: 1 })).json;
        if (!meta?.jwks_uri) throw new Error('the OpenID metadata has no jwks_uri');
        const jwks = (await request(this.fetch, meta.jwks_uri, { service: 'Bot Framework signing keys', retries: 1 })).json;
        const keys = new Map();
        for (const k of jwks?.keys ?? []) if (k.kid && k.kty === 'RSA') keys.set(k.kid, k);
        this.keys = keys;
        this.algs = Array.isArray(meta.id_token_signing_alg_values_supported) && meta.id_token_signing_alg_values_supported.length ? meta.id_token_signing_alg_values_supported : ['RS256'];
        this.issuer = meta.issuer;
        this.loaded = Date.now();
      } finally { this.inflight = undefined; }
    })();
    await this.inflight;
  }

  async key(kid) {
    await this.load();
    if (!this.keys.has(kid)) await this.load(true);
    return this.keys.get(kid);
  }
}

/**
 * Verifies a request from the Bot Connector. Throws BotAuthError (401 for a bad
 * token, 403 for a missing endorsement) or returns the token's claims.
 */
export async function verifyBotRequest({ authorization, activity, appId, issuer, keys, now = Date.now() }) {
  const m = /^Bearer\s+([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(String(authorization ?? '').trim());
  if (!m) throw new BotAuthError('no Bearer token');
  let header, claims;
  try { header = JSON.parse(b64url(m[1]).toString('utf8')); claims = JSON.parse(b64url(m[2]).toString('utf8')); } catch { throw new BotAuthError('the token is not a JWT'); }
  if (header.alg !== 'RS256') throw new BotAuthError(`token algorithm ${header.alg} is not accepted`);
  const jwk = await keys.key(header.kid);
  if (!jwk) throw new BotAuthError('the token was not signed with a key from the Bot Framework OpenID metadata');
  if (!keys.algs.includes(header.alg)) throw new BotAuthError(`algorithm ${header.alg} is not in the metadata's id_token_signing_alg_values_supported`);
  let pub;
  try { pub = crypto.createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' }); } catch { throw new BotAuthError('signing key unusable'); }
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${m[1]}.${m[2]}`), pub, b64url(m[3]));
  if (!ok) throw new BotAuthError('token signature does not verify');
  if (claims.iss !== issuer) throw new BotAuthError(`token issuer ${claims.iss} is not ${issuer}`);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!appId || !aud.includes(appId)) throw new BotAuthError('token audience is not this bot\'s App ID');
  const t = Math.floor(now / 1000);
  if (typeof claims.exp !== 'number' || t > claims.exp + SKEW_SEC) throw new BotAuthError('token expired');
  if (typeof claims.nbf === 'number' && t < claims.nbf - SKEW_SEC) throw new BotAuthError('token not yet valid');
  const su = String(activity?.serviceUrl ?? '');
  if (!claims.serviceUrl || claims.serviceUrl.replace(/\/+$/, '') !== su.replace(/\/+$/, '')) throw new BotAuthError('token serviceUrl does not match the activity\'s serviceUrl');
  if (Array.isArray(jwk.endorsements) && activity?.channelId && !jwk.endorsements.includes(activity.channelId)) throw new BotAuthError(`the signing key is not endorsed for channel ${activity.channelId}`, 403);
  return claims;
}

export class TeamsClient {
  constructor({ cfg, fetch, password }) {
    this.cfg = cfg;
    this.fetch = fetch;
    this.password = password; // async () => app password (client secret)
    this.tokenCache = undefined;
  }

  /** client_credentials against the bot's tenant (single-tenant) or botframework.com (multi-tenant). */
  async token() {
    if (this.tokenCache && this.tokenCache.until > Date.now()) return this.tokenCache.token;
    const tenant = this.cfg.tenantId ?? 'botframework.com';
    const r = await request(this.fetch, `${this.cfg.loginBase}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
      method: 'POST', service: 'Microsoft Entra token',
      form: { grant_type: 'client_credentials', client_id: this.cfg.appId, client_secret: await this.password(), scope: this.cfg.scope },
    });
    if (!r.json?.access_token) throw new Error('Microsoft Entra token: no access_token in the answer');
    this.tokenCache = { token: r.json.access_token, until: Date.now() + Math.max(60, Number(r.json.expires_in ?? 3600) - 300) * 1000 };
    return this.tokenCache.token;
  }

  /** A serviceUrl we will send the bot's token to: only the configured one and the Bot Framework's hosts. */
  checkServiceUrl(serviceUrl) {
    const u = new URL(serviceUrl ?? this.cfg.serviceUrl);
    const configured = new URL(this.cfg.serviceUrl);
    if (u.origin === configured.origin) return u.toString().replace(/\/+$/, '');
    if (u.protocol !== 'https:' || !this.cfg.serviceUrlHosts.some((p) => globMatch(p, u.hostname))) throw new Error(`Teams serviceUrl ${u.origin} is not a Bot Framework host (teams.serviceUrlHosts)`);
    return u.toString().replace(/\/+$/, '');
  }

  async connector(method, serviceUrl, path, json) {
    const base = this.checkServiceUrl(serviceUrl);
    const r = await request(this.fetch, `${base}${path}`, { method, headers: { authorization: `Bearer ${await this.token()}` }, json, service: `Bot Connector ${method} ${path.split('/').slice(0, 3).join('/')}` });
    return r.json ?? {};
  }

  send(serviceUrl, conversationId, activity) {
    return this.connector('POST', serviceUrl, `/v3/conversations/${encodeURIComponent(conversationId)}/activities`, activity);
  }

  reply(serviceUrl, conversationId, activityId, activity) {
    return this.connector('POST', serviceUrl, `/v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}`, { ...activity, replyToId: activityId });
  }

  update(serviceUrl, conversationId, activityId, activity) {
    return this.connector('PUT', serviceUrl, `/v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}`, { ...activity, id: activityId });
  }

  /** A member's profile (email, userPrincipalName, aadObjectId) in a conversation. */
  member(serviceUrl, conversationId, userId) {
    return this.connector('GET', serviceUrl, `/v3/conversations/${encodeURIComponent(conversationId)}/members/${encodeURIComponent(userId)}`);
  }
}

/** One-way: a Teams Workflows "When a Teams webhook request is received" URL (held in the Key Vault: its sig is a secret). */
export async function postWorkflowWebhook(fetchFn, url, card) {
  const u = new URL(url);
  if (u.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(u.hostname)) throw new Error('a Teams webhook URL must be https');
  await request(fetchFn, u.toString(), { method: 'POST', json: { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: card }] }, service: 'Teams Workflows webhook' });
}

// ---------- Adaptive Cards ----------

const CARD = { $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4' };
const text = (t, o = {}) => ({ type: 'TextBlock', text: truncate(String(t ?? ''), 4000), wrap: true, ...o });
// Adaptive Card TextBlocks render a subset of Markdown (emphasis, lists, [links](url)):
// outside text must not become a link that looks like ours.
const plain = (s) => String(s ?? '').replace(/\]\s*\(/g, '] (');

export const cardAttachment = (card) => ({ type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }] });

export function approvalCard(req, { sessionUrl, onCall } = {}) {
  const isPerm = req.kind === 'permission_request';
  const [yes, no] = isPerm ? [['allow', 'Allow'], ['deny', 'Deny']] : [['approve', 'Approve'], ['reject', 'Reject']];
  const facts = [
    { title: 'Session', value: plain(req.sessionTitle || req.sessionId) },
    isPerm ? { title: 'Tool', value: plain(req.tool) } : { title: 'Step', value: plain(req.title) },
    ...(req.incident ? [{ title: 'Incident', value: plain(req.incident) }] : []),
    ...(onCall?.length ? [{ title: 'On call', value: plain(onCall.map((u) => u.name).join(', ')) }] : []),
  ];
  return {
    ...CARD,
    body: [
      text(isPerm ? 'Permission needed' : 'Approval needed', { weight: 'Bolder', size: 'Medium' }),
      { type: 'FactSet', facts },
      text(plain(req.detail || '(no details)')),
      ...(req.files?.length ? [text(`Files: ${plain(req.files.join(', '))}`, { isSubtle: true, size: 'Small' })] : []),
    ],
    actions: [
      { type: 'Action.Execute', title: yes[1], verb: 'harness.decide', style: 'positive', data: { requestId: req.requestId, decision: yes[0] } },
      { type: 'Action.Execute', title: no[1], verb: 'harness.decide', style: 'destructive', data: { requestId: req.requestId, decision: no[0] } },
      ...(sessionUrl ? [{ type: 'Action.OpenUrl', title: 'Open the session', url: sessionUrl }] : []),
    ],
  };
}

export function decidedCard(original, { decision, who, at = Date.now(), elsewhere = false }) {
  const verb = { approve: 'Approved', allow: 'Allowed', reject: 'Rejected', deny: 'Denied' }[decision] ?? `Decided (${decision})`;
  return {
    ...(original ?? CARD),
    body: [...(original?.body ?? []), text(`${verb} ${elsewhere ? 'in the harness' : `by ${plain(who)}`} at ${new Date(at).toISOString().replace(/\.\d+Z$/, 'Z')}`, { weight: 'Bolder', color: /approve|allow/.test(decision) ? 'Good' : 'Attention' })],
    actions: (original?.actions ?? []).filter((a) => a.type !== 'Action.Execute'),
  };
}

export function incidentCard(inc, { sessionUrl, links = [] } = {}) {
  const status = inc.status === 'resolved' ? 'RESOLVED' : String(inc.status ?? 'investigating').toUpperCase();
  return {
    ...CARD,
    body: [
      text(`[${String(inc.severity ?? '').toUpperCase()}] ${plain(inc.title ?? inc.id)}`, { weight: 'Bolder', size: 'Medium' }),
      { type: 'FactSet', facts: [
        { title: 'Status', value: status }, { title: 'Severity', value: plain(inc.severity ?? '-') },
        { title: 'Services', value: plain((inc.services ?? []).join(', ') || '-') }, { title: 'Incident', value: plain(inc.id) },
        ...(inc.rootCause ? [{ title: 'Root cause', value: plain(inc.rootCause) }] : []),
        ...(inc.resolution ? [{ title: 'Resolution', value: plain(inc.resolution) }] : []),
      ] },
      ...(inc.summary ? [text(plain(truncate(inc.summary, 1500)))] : []),
    ],
    actions: [...(sessionUrl ? [{ type: 'Action.OpenUrl', title: 'Open the session', url: sessionUrl }] : []), ...links.map((l) => ({ type: 'Action.OpenUrl', title: l.text, url: l.url }))],
  };
}

export const textCard = (t) => ({ ...CARD, body: [text(plain(t))] });

/** The invoke response that replaces the card for the person who clicked. */
export const cardInvokeResponse = (card) => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ statusCode: 200, type: 'application/vnd.microsoft.card.adaptive', value: card }) });
/** A message shown only to the person who clicked (the card stays as it was). */
export const messageInvokeResponse = (message) => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ statusCode: 200, type: 'application/vnd.microsoft.activity.message', value: message }) });

/** The text of a message to the bot without its <at>mention</at>. */
export function messageText(activity) {
  return String(activity?.text ?? '').replace(/<at>[^<]*<\/at>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}
