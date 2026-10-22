/**
 * The protocol between a plugin frame and the host (the desktop shell, or any other host).
 *
 * A frame is an iframe with an opaque origin (sandbox without allow-same-origin): it can only
 * postMessage. Every call names a method; the host answers only methods the frame's capabilities
 * cover (CALLS below), checks the arguments, and for some methods requires that the call followed
 * a click inside the frame (a user gesture the host saw) or asks the person first.
 */

import type { Capability } from './manifest.ts';

export const PROTOCOL = 'harness-ui/1';

/** Frame -> host. */
export interface CallMessage { protocol: typeof PROTOCOL; kind: 'call'; id: number; method: string; params?: unknown; gesture?: boolean }
/** Host -> frame. */
export interface ResultMessage { protocol: typeof PROTOCOL; kind: 'result'; id: number; ok: boolean; value?: unknown; error?: string }
/** Host -> frame, unprompted (an event subscription, a theme change). */
export interface EventMessage { protocol: typeof PROTOCOL; kind: 'event'; topic: string; payload: unknown }
/** Host -> frame, first message: who it is and how to look. */
export interface InitMessage { protocol: typeof PROTOCOL; kind: 'init'; plugin: string; contribution: string; params: Record<string, string>; theme: ThemeVars; apiVersion: number; capabilities: Capability[]; context?: unknown }
export type HostMessage = ResultMessage | EventMessage | InitMessage;
export type FrameMessage = CallMessage;

/** The theme as CSS variables (name -> value), so a frame can look native. */
export type ThemeVars = Record<string, string>;

export interface CallSpec {
  /** null: every frame may call it. */
  capability: Capability | null;
  /** Needs a click in the frame just before (a gesture the host saw). */
  gesture?: boolean;
  /** The host asks the person before doing it (unless it came with a gesture and the method allows that). */
  confirm?: boolean;
}

/** Every method a frame can call, and what it takes. */
export const CALLS: Record<string, CallSpec> = {
  'theme.get': { capability: null },
  'view.open': { capability: null },
  'panel.open': { capability: null },
  'notify.toast': { capability: null },
  'storage.get': { capability: null },
  'storage.set': { capability: null },
  'composer.prefill': { capability: null },
  'frame.resize': { capability: null },
  'badge.set': { capability: null },
  // What else is installed (another plugin, a view, a renderer): ids and yes/no only, no third-party text.
  'registry.has': { capability: null },
  'registry.list': { capability: null },
  // Draws a block with one of the host's renderers (a fence language such as "diagram") over a rectangle of the frame.
  'render.show': { capability: null },
  'render.hide': { capability: null },
  'sessions.list': { capability: 'sessions.read' },
  'sessions.get': { capability: 'sessions.read' },
  'sessions.history': { capability: 'sessions.read' },
  'sessions.start': { capability: 'sessions.start', confirm: true },
  'sessions.send': { capability: 'sessions.start', confirm: true },
  'events.subscribe': { capability: 'events.subscribe' },
  'events.unsubscribe': { capability: 'events.subscribe' },
  'approvals.list': { capability: 'approvals.respond' },
  'approvals.respond': { capability: 'approvals.respond', gesture: true },
  'routes.call': { capability: 'routes.call' },
  'files.list': { capability: 'files.read' },
  'files.read': { capability: 'files.read' },
  'workflows.list': { capability: 'workflows.start' },
  'workflows.start': { capability: 'workflows.start', confirm: true },
  'settings.get': { capability: 'settings.read' },
  'settings.set': { capability: 'settings.write' },
  'clipboard.write': { capability: 'clipboard.write', gesture: true },
  'browser.open': { capability: 'browser.open' },
  'external.open': { capability: 'external.open', gesture: true },
};

/** Why the host must refuse this call from a frame, or undefined when it may go ahead (confirm may still apply). */
export function refuseCall(msg: unknown, granted: readonly Capability[]): string | undefined {
  if (!msg || typeof msg !== 'object') return 'not a message';
  const m = msg as Partial<CallMessage>;
  if (m.protocol !== PROTOCOL || m.kind !== 'call') return 'not a harness-ui call';
  if (typeof m.id !== 'number' || !Number.isSafeInteger(m.id)) return 'the call needs a numeric id';
  if (typeof m.method !== 'string' || !Object.hasOwn(CALLS, m.method)) return `unknown method ${String(m.method).slice(0, 60)}`;
  const spec = CALLS[m.method]!;
  if (spec.capability && !granted.includes(spec.capability)) return `${m.method} needs the "${spec.capability}" capability, which this plugin was not granted`;
  return undefined;
}

/** Does a method need a gesture the host saw? */
export function needsGesture(method: string): boolean { return !!CALLS[method]?.gesture; }
/** Does the host ask the person before doing it? */
export function needsConfirm(method: string): boolean { return !!CALLS[method]?.confirm; }

/** A namespaced storage key a frame may use (no separators that could reach another plugin's space). */
export const STORAGE_KEY = /^[a-zA-Z0-9_.-]{1,64}$/;
/** At most this many bytes per stored value, and this many keys per plugin. */
export const STORAGE_LIMITS = { valueBytes: 256 * 1024, keys: 200 };

/** What registry.list lists (ids only). */
export const REGISTRY_KINDS = ['plugins', 'views', 'panels', 'renderers', 'commands'] as const;
export type RegistryKind = typeof REGISTRY_KINDS[number];
/** What registry.has asks about: exactly one of these. A renderer is a fence language ("diagram"), or "fence:", "artifact:", "tool:" or "event:" with its key. */
export interface RegistryQuery { plugin?: string; view?: string; panel?: string; renderer?: string; command?: string }

/** Events a frame can subscribe to with events.subscribe (the global stream's topics). */
export const EVENT_TOPICS = ['sessions', 'session', 'approvals', 'schedules', 'plugins', 'notices'] as const;
export type EventTopic = typeof EVENT_TOPICS[number];
