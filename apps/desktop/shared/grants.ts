/**
 * Capability grants for plugin frames, kept per machine and tied to the plugin's uiHash: a person
 * grants a frame plugin once; any change to its files (a new hash) asks again. Pure rules here,
 * the file in main (electron/grants.ts), the prompt in the renderer (TrustGate).
 */

import type { Capability } from '@harness/plugin-ui';

export interface GrantRecord { uiHash: string; capabilities: Capability[]; at: number; denied?: boolean }
export type Grants = Record<string, GrantRecord>;

export type GrantDecision =
  | { state: 'granted'; capabilities: Capability[] }
  /** Never asked, or asked for an older version of the plugin's files. */
  | { state: 'ask'; capabilities: Capability[]; changed: boolean }
  | { state: 'denied' };

/**
 * What a frame plugin may do now. `declared` are the manifest's capabilities; a grant only ever
 * covers capabilities the manifest still declares (a new version declaring more asks again).
 */
export function decide(record: GrantRecord | undefined, uiHash: string | undefined, declared: readonly Capability[]): GrantDecision {
  if (!record || !uiHash || record.uiHash !== uiHash) return { state: 'ask', capabilities: [...declared], changed: !!record && !!uiHash && record.uiHash !== uiHash };
  if (record.denied) return { state: 'denied' };
  const missing = declared.filter((c) => !record.capabilities.includes(c));
  if (missing.length) return { state: 'ask', capabilities: [...declared], changed: true };
  return { state: 'granted', capabilities: declared.filter((c) => record.capabilities.includes(c)) };
}

/** A record for what the person chose in the prompt (never more than declared). */
export function grantRecord(uiHash: string, declared: readonly Capability[], chosen: readonly Capability[], now = Date.now()): GrantRecord {
  return { uiHash, capabilities: declared.filter((c) => chosen.includes(c)), at: now };
}

/** Plain-language lines for the trust prompt. */
export const CAPABILITY_TEXT: Record<Capability, string> = {
  'sessions.read': 'Read your conversations and their history',
  'sessions.start': 'Start conversations and send messages (you are asked each time)',
  'events.subscribe': 'Follow live activity (sessions, approvals, schedules)',
  'approvals.respond': 'Answer approval requests (only right after you click in it)',
  'routes.call': "Call its own server routes",
  'files.read': 'Read files in a conversation\'s workspace',
  'workflows.start': 'Start workflows (you confirm each one)',
  'settings.read': 'Read its own settings',
  'settings.write': 'Change its own settings',
  'clipboard.write': 'Copy text to the clipboard (after a click)',
  'browser.open': 'Open web pages',
  'external.open': 'Open links in your browser (after a click)',
};
