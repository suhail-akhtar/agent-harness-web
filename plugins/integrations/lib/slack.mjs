// Slack: the Web API (chat.postMessage, chat.update, chat.postEphemeral,
// users.info) with a bot token, Block Kit messages, and verification of what
// Slack sends us (request signing v0: HMAC-SHA256 of "v0:<timestamp>:<raw body>"
// with the app's signing secret, a 5-minute replay window, constant-time compare).
// https://docs.slack.dev/authentication/verifying-requests-from-slack

import crypto from 'node:crypto';
import { request, safeEqual, truncate, Spacer } from './util.mjs';

export const REPLAY_WINDOW_SEC = 300;

/** Verifies a request from Slack. `body` is the raw bytes, before any parsing. */
export function verifySlackRequest({ headers, body, signingSecret, now = Date.now() }) {
  const ts = String(headers['x-slack-request-timestamp'] ?? '');
  const sig = String(headers['x-slack-signature'] ?? '');
  if (!ts || !sig) return { ok: false, reason: 'missing X-Slack-Request-Timestamp or X-Slack-Signature' };
  if (!/^\d{1,12}$/.test(ts)) return { ok: false, reason: 'bad timestamp' };
  if (Math.abs(Math.floor(now / 1000) - Number(ts)) > REPLAY_WINDOW_SEC) return { ok: false, reason: 'timestamp outside the 5-minute window (a replay, or a clock off)' };
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''));
  const expected = `v0=${crypto.createHmac('sha256', signingSecret).update(Buffer.concat([Buffer.from(`v0:${ts}:`), raw])).digest('hex')}`;
  if (!safeEqual(expected, sig)) return { ok: false, reason: 'signature does not match' };
  return { ok: true };
}

/** Text from outside, safe inside mrkdwn: no <!channel> pings, no disguised links. */
export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const link = (url, text) => (url ? `<${url}|${esc(text).replace(/\|/g, '/')}>` : esc(text));

export class SlackClient {
  constructor({ cfg, fetch, token }) {
    this.cfg = cfg;
    this.fetch = fetch;
    this.token = token; // async () => bot token
    this.spacer = new Spacer(cfg.minIntervalMs ?? 1100); // chat.postMessage: about one message a second per channel
  }

  async call(method, body, { channel } = {}) {
    if (channel) await this.spacer.wait(channel);
    const token = await this.token();
    const r = await request(this.fetch, `${this.cfg.apiBase}/${method}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, json: body, service: `Slack ${method}` });
    if (!r.json?.ok) throw new Error(`Slack ${method}: ${r.json?.error ?? 'not ok'}${r.json?.response_metadata?.messages ? ` (${r.json.response_metadata.messages.join('; ')})` : ''}`);
    return r.json;
  }

  /** Read methods take query parameters (Slack's JSON bodies are for write methods). */
  async get(method, params) {
    const token = await this.token();
    const r = await request(this.fetch, `${this.cfg.apiBase}/${method}?${new URLSearchParams(params)}`, { headers: { authorization: `Bearer ${token}` }, service: `Slack ${method}` });
    if (!r.json?.ok) throw new Error(`Slack ${method}: ${r.json?.error ?? 'not ok'}`);
    return r.json;
  }

  post({ channel, text, blocks, thread_ts }) {
    return this.call('chat.postMessage', { channel, text: truncate(text, 3000), ...(blocks ? { blocks } : {}), ...(thread_ts ? { thread_ts } : {}), unfurl_links: false, unfurl_media: false }, { channel });
  }

  update({ channel, ts, text, blocks }) {
    return this.call('chat.update', { channel, ts, text: truncate(text, 3000), ...(blocks ? { blocks } : {}) }, { channel });
  }

  ephemeral({ channel, user, text, thread_ts }) {
    return this.call('chat.postEphemeral', { channel, user, text, ...(thread_ts ? { thread_ts } : {}) });
  }

  async userEmail(user) {
    const r = await this.get('users.info', { user });
    return r.user?.profile?.email ? String(r.user.profile.email).toLowerCase() : undefined;
  }

  async userByEmail(email) {
    try { return (await this.get('users.lookupByEmail', { email })).user?.id; } catch { return undefined; }
  }

  /** A reply through an interaction's response_url (ephemeral by default). Only to Slack's own hooks host. */
  async respond(responseUrl, body) {
    const u = new URL(responseUrl);
    if (u.origin !== new URL(this.cfg.hooksBase).origin) throw new Error(`Slack response_url ${u.origin} is not ${this.cfg.hooksBase}`);
    await request(this.fetch, u.toString(), { method: 'POST', json: body, service: 'Slack response_url' });
  }
}

// ---------- Block Kit ----------

export function approvalBlocks(req, { sessionUrl, onCall } = {}) {
  const isPerm = req.kind === 'permission_request';
  const head = isPerm ? 'Permission needed' : 'Approval needed';
  const lines = [
    `*Session:* ${link(sessionUrl, req.sessionTitle || req.sessionId)}`,
    isPerm ? `*Tool:* \`${esc(req.tool)}\`` : `*Step:* ${esc(req.title)}`,
    ...(req.incident ? [`*Incident:* ${esc(req.incident)}`] : []),
    ...(onCall?.length ? [`*On call:* ${onCall.map((u) => (u.slack ? `<@${u.slack}>` : esc(u.name))).join(', ')}`] : []),
  ];
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: truncate(`${head}: ${req.title || req.tool || ''}`, 150) } },
    { type: 'section', text: { type: 'mrkdwn', text: truncate(lines.join('\n'), 3000) } },
    { type: 'section', text: { type: 'mrkdwn', text: truncate(esc(req.detail || '(no details)'), 2900) } },
  ];
  if (req.files?.length) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: truncate(`Files: ${req.files.map(esc).join(', ')}`, 2000) }] });
  const [yes, no] = isPerm ? [['allow', 'Allow'], ['deny', 'Deny']] : [['approve', 'Approve'], ['reject', 'Reject']];
  blocks.push({
    type: 'actions', block_id: 'harness_decide',
    elements: [
      { type: 'button', action_id: `harness_${yes[0]}`, style: 'primary', text: { type: 'plain_text', text: yes[1] }, value: JSON.stringify({ r: req.requestId, d: yes[0] }) },
      { type: 'button', action_id: `harness_${no[0]}`, style: 'danger', text: { type: 'plain_text', text: no[1] }, value: JSON.stringify({ r: req.requestId, d: no[0] }) },
    ],
  });
  return { text: `${head}: ${req.title || req.tool || ''} (${req.sessionTitle || req.sessionId})`, blocks };
}

/** The same message after a decision: the buttons replaced by who decided. */
export function decidedBlocks(original, { decision, who, at = Date.now(), elsewhere = false }) {
  const blocks = (original?.blocks ?? []).filter((b) => b.type !== 'actions');
  const verb = { approve: 'Approved', allow: 'Allowed', reject: 'Rejected', deny: 'Denied' }[decision] ?? `Decided (${decision})`;
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `*${verb}* ${elsewhere ? 'in the harness' : `by ${who}`} at ${new Date(at).toISOString().replace(/\.\d+Z$/, 'Z')}` }] });
  return { text: `${verb}${elsewhere ? '' : ` by ${who}`}: ${original?.text ?? ''}`, blocks };
}

export function incidentBlocks(inc, { sessionUrl, links = [] } = {}) {
  const status = inc.status === 'resolved' ? 'RESOLVED' : String(inc.status ?? 'investigating').toUpperCase();
  const lines = [
    `*Severity:* ${esc(inc.severity ?? '-')}   *Status:* ${esc(status)}`,
    `*Services:* ${esc((inc.services ?? []).join(', ') || '-')}`,
    ...(inc.summary ? [`*Summary:* ${esc(truncate(inc.summary, 1500))}`] : []),
    ...(inc.rootCause ? [`*Root cause:* ${esc(inc.rootCause)}`] : []),
    ...(inc.resolution ? [`*Resolution:* ${esc(inc.resolution)}`] : []),
  ];
  const ctx = [sessionUrl ? link(sessionUrl, 'Open the session') : '', ...links.map((l) => link(l.url, l.text))].filter(Boolean);
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: truncate(`[${String(inc.severity ?? '').toUpperCase()}] ${inc.title ?? inc.id}`, 150) } },
    { type: 'section', text: { type: 'mrkdwn', text: truncate(lines.join('\n'), 3000) } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: truncate(`${esc(inc.id)}${ctx.length ? ` | ${ctx.join(' | ')}` : ''}`, 2000) }] },
  ];
  return { text: `[${inc.severity}] ${inc.title ?? inc.id} - ${status}`, blocks };
}
