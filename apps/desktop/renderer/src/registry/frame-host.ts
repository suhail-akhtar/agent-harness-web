/**
 * The host side of the frame protocol (harness-ui/1): what the shell does with a call from a plugin
 * frame. Pure apart from the `impl` functions it is handed, so the refusals are unit-tested.
 *
 * In order, a call is refused when:
 *  1. it is not a well-formed call, names an unknown method, or needs a capability the plugin does
 *     not have (declared in its manifest AND granted by the person) - refuseCall from plugin-ui;
 *  2. it needs a user gesture (approvals.respond, clipboard.write, external.open) and the frame was
 *     not clicked just before (the SDK's own claim is not enough: the host must have seen the frame
 *     take focus from a click);
 *  3. its arguments are wrong (storage keys, sizes, URLs, route paths that leave the plugin);
 *  4. it needs the person's say (sessions.start/send without a gesture, workflows.start) and they
 *     decline.
 */

import { CALLS, PROTOCOL, STORAGE_KEY, STORAGE_LIMITS, needsConfirm, needsGesture, refuseCall, type Capability, type CallMessage, type ResultMessage, EVENT_TOPICS } from '@harness/plugin-ui';

export type Impl = Partial<Record<string, (params: Record<string, unknown>) => unknown>>;

export interface FrameCallContext {
  plugin: string;
  /** Declared by the manifest and granted by the person (or every declared one for native/trusted). */
  granted: readonly Capability[];
  /** Did the host see a person interact with this frame just now? */
  gestureSeen: () => boolean;
  /** Asks the person; resolves true to go ahead. */
  confirm: (question: string) => Promise<boolean>;
  impl: Impl;
}

const result = (id: number, ok: boolean, value?: unknown, error?: string): ResultMessage => ({ protocol: PROTOCOL, kind: 'result', id, ok, ...(ok ? { value } : { error }) });

/** Checks a call's arguments; returns why they are refused, or undefined. */
export function badParams(method: string, p: Record<string, unknown>): string | undefined {
  const str = (k: string, max = 2000) => (typeof p[k] === 'string' && (p[k] as string).length <= max ? undefined : `"${k}" must be text (at most ${max} characters)`);
  const http = (k: string) => (typeof p[k] === 'string' && /^https?:\/\/[^\s]+$/i.test(p[k] as string) ? undefined : `"${k}" must be an http(s) address`);
  switch (method) {
    case 'storage.get': return typeof p.key === 'string' && STORAGE_KEY.test(p.key) ? undefined : 'storage keys are letters, digits, dot, dash and underscore (at most 64)';
    case 'storage.set': {
      if (typeof p.key !== 'string' || !STORAGE_KEY.test(p.key)) return 'storage keys are letters, digits, dot, dash and underscore (at most 64)';
      const size = JSON.stringify(p.value ?? null).length;
      return size > STORAGE_LIMITS.valueBytes ? `a stored value is limited to ${STORAGE_LIMITS.valueBytes} bytes` : undefined;
    }
    case 'notify.toast': return str('text', 300);
    case 'composer.prefill': return str('text', 20_000);
    case 'view.open': return str('view', 130);
    case 'panel.open': return str('panel', 130);
    case 'badge.set': return typeof p.name === 'string' && /^[a-zA-Z0-9_.-]{1,40}$/.test(p.name) && (p.value === null || typeof p.value === 'number' || (typeof p.value === 'string' && p.value.length <= 20)) ? undefined : 'a badge is a short name and a number, short text or null';
    case 'frame.resize': return typeof p.height === 'number' && p.height >= 0 && p.height <= 4000 ? undefined : 'height is 0-4000 pixels';
    case 'routes.call': {
      if (typeof p.path !== 'string' || !/^[a-z0-9][a-z0-9/_.-]{0,127}$/i.test(p.path) || p.path.includes('..')) return 'path must be one of this plugin\'s own route paths';
      if (p.method !== undefined && p.method !== 'GET' && p.method !== 'POST') return 'method is GET or POST';
      return undefined;
    }
    case 'sessions.get': case 'sessions.history': return typeof p.id === 'string' && /^[a-f0-9]{16}$/.test(p.id) ? undefined : 'not a session id';
    case 'sessions.send': return typeof p.id === 'string' && /^[a-f0-9]{16}$/.test(p.id) ? str('text', 200_000) : 'not a session id';
    case 'sessions.start': return typeof p.title === 'string' && p.title.length <= 200 ? undefined : 'a session needs a "title"';
    case 'events.subscribe': case 'events.unsubscribe': return (EVENT_TOPICS as readonly string[]).includes(String(p.topic)) ? undefined : `topic is one of ${EVENT_TOPICS.join(', ')}`;
    case 'approvals.respond': return typeof p.sessionId === 'string' && typeof p.requestId === 'string' && typeof p.decision === 'string' ? undefined : 'sessionId, requestId and decision are required';
    case 'files.read': return str('path', 1000);
    case 'workflows.start': return str('name', 120);
    case 'settings.set': return typeof p.key === 'string' && /^[a-zA-Z0-9_.-]{1,64}$/.test(p.key) ? undefined : 'a setting key is required';
    case 'clipboard.write': return str('text', 1_000_000);
    case 'browser.open': case 'external.open': return http('url');
    default: return undefined;
  }
}

function question(plugin: string, method: string, p: Record<string, unknown>): string {
  switch (method) {
    case 'sessions.start': return `${plugin} wants to start a conversation "${String(p.title ?? '')}"${p.prompt ? ` with: ${String(p.prompt).slice(0, 200)}` : ''}.`;
    case 'sessions.send': return `${plugin} wants to send a message: ${String(p.text ?? '').slice(0, 200)}`;
    case 'workflows.start': return `${plugin} wants to start the workflow "${String(p.name ?? '')}".`;
    default: return `${plugin} wants to ${method}.`;
  }
}

/**
 * Handles one message from a frame. Returns the result to post back, or undefined when the message
 * is not a call (nothing to answer). Never throws.
 */
export async function handleFrameCall(data: unknown, ctx: FrameCallContext): Promise<ResultMessage | undefined> {
  if (!data || typeof data !== 'object' || (data as { protocol?: unknown }).protocol !== PROTOCOL || (data as { kind?: unknown }).kind !== 'call') return undefined;
  const msg = data as CallMessage;
  const why = refuseCall(msg, ctx.granted);
  if (why) return typeof msg.id === 'number' && Number.isSafeInteger(msg.id) ? result(msg.id, false, undefined, why) : undefined;
  const params = (msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params) ? msg.params : {}) as Record<string, unknown>;
  const gesture = msg.gesture === true && ctx.gestureSeen();
  if (needsGesture(msg.method) && !gesture) return result(msg.id, false, undefined, `${msg.method} works only right after a click in the plugin`);
  const bad = badParams(msg.method, params);
  if (bad) return result(msg.id, false, undefined, bad);
  // sessions.start/send: asked unless the person just clicked in the frame; a workflow always opens the dialog.
  const ask = needsConfirm(msg.method) && (msg.method === 'workflows.start' || !gesture);
  if (ask && !(await ctx.confirm(question(ctx.plugin, msg.method, params)))) return result(msg.id, false, undefined, 'the person declined');
  const fn = ctx.impl[msg.method];
  if (!fn) return result(msg.id, false, undefined, `${msg.method} is not available here`);
  try { return result(msg.id, true, await fn(params)); } catch (e) { return result(msg.id, false, undefined, (e as Error)?.message ?? String(e)); }
}

/** Every method a frame may call (for the docs and the tests). */
export const FRAME_METHODS = Object.keys(CALLS);
