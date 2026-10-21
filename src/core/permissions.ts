import type { PermissionMode } from './types.ts';
import type { Tool } from '../tools/types.ts';
import { globMatcher } from '../tools/paths.ts';

// Permissions are enforced here, in code, on every call - never by the prompt.
// Order: deny rules > ask rules > allow rules > the mode's default.
//
// Rule syntax:  tool            the whole tool              e.g. "web_fetch"
//               tool(spec)      bash: exact command, or "prefix:*"
//                               edit/write/read: a glob over the path
//                               web_fetch: "domain:example.com"

export interface Rules { allow: string[]; deny: string[]; ask: string[] }
export type Decision = { action: 'allow' | 'deny' | 'ask'; reason: string };

export interface PermissionContext {
  mode: PermissionMode;
  rules: Rules;
  /** Commands run in an isolated container: auto-allow them (the sandbox is the boundary). */
  sandboxed: boolean;
  /** The agent has read untrusted content (web pages, MCP results) in this context. */
  tainted?: boolean;
  /** What commands can reach: 'full' means a command can send data anywhere. */
  network?: 'none' | 'allowlist' | 'full';
}

/**
 * Whether a call can carry data out of the session: a request to a service or a
 * URL, a push, or a command on a machine with open network. Together with private
 * data and untrusted content in the context this is the "lethal trifecta": a page
 * that tells the agent to send the code somewhere. Sandboxes with no network or an
 * allowlist (the operator's hosts) are not a way out.
 */
export function sendsOut(tool: Tool, input: Record<string, unknown>, network: PermissionContext['network']): boolean {
  if (tool.sendsOut !== undefined) return typeof tool.sendsOut === 'function' ? tool.sendsOut(input) : tool.sendsOut;
  const kinds = tool.kindsFor?.(input) ?? [tool.kind];
  return kinds.some((k) => k === 'network' || k === 'external' || (k === 'exec' && network === 'full' && !isReadOnlyCommand(String(input.command ?? ''))));
}

function parseRule(rule: string): { tool: string; spec?: string } {
  const m = /^([A-Za-z0-9_*-]+)(?:\((.*)\))?$/.exec(rule.trim());
  return m ? { tool: m[1]!, spec: m[2] } : { tool: rule.trim() };
}

export function ruleMatches(rule: string, tool: Tool, input: Record<string, unknown>): boolean {
  const { tool: name, spec } = parseRule(rule);
  // "mcp__github__*" covers every tool of one MCP server.
  if (name.endsWith('*') ? !tool.spec.name.startsWith(name.slice(0, -1)) : name !== tool.spec.name) return false;
  if (spec === undefined || spec === '' || spec === '*') return true;
  if (name === 'bash') {
    const cmd = String(input.command ?? '').trim();
    if (spec.endsWith(':*')) {
      const prefix = spec.slice(0, -2);
      // A prefix rule never covers a compound command: "git status:*" must not allow "git status; rm -rf ~".
      return (cmd === prefix || cmd.startsWith(prefix + ' ')) && !hasShellControl(cmd);
    }
    return cmd === spec;
  }
  if (name === 'web_fetch') {
    if (!spec.startsWith('domain:')) return false;
    try {
      const host = new URL(String(input.url)).hostname;
      const d = spec.slice(7);
      return host === d || host.endsWith('.' + d);
    } catch { return false; }
  }
  const p = String(input.path ?? '').replace(/\\/g, '/').replace(/^\/workspace\//, '').replace(/^\.\//, '');
  return globMatcher(spec)(p);
}

/** Shell syntax that can chain or redirect: anything that makes a command more than one command. */
export function hasShellControl(cmd: string): boolean {
  return /[;&|`<>\n]|\$\(|\$\{/.test(cmd);
}

const READ_ONLY_COMMANDS = /^(ls|pwd|cat|head|tail|wc|file|stat|du|df|which|echo|date|whoami|uname|tree|rg|grep|find|git (status|diff|log|show|branch|remote -v|rev-parse|ls-files|blame))(\s|$)/;

export function isReadOnlyCommand(cmd: string): boolean {
  const c = cmd.trim();
  if (hasShellControl(c)) return false;
  if (/^find\b/.test(c) && /\s-(exec|execdir|delete|ok|fprint)/.test(c)) return false;
  return READ_ONLY_COMMANDS.test(c);
}

export function decide(tool: Tool, input: Record<string, unknown>, ctx: PermissionContext): Decision {
  const { rules, mode } = ctx;
  if (rules.deny.some((r) => ruleMatches(r, tool, input))) return { action: 'deny', reason: 'blocked by a deny rule' };
  if (rules.ask.some((r) => ruleMatches(r, tool, input))) return mode === 'bypass' ? { action: 'allow', reason: 'bypass mode' } : { action: 'ask', reason: 'matches an ask rule' };
  if (rules.allow.some((r) => ruleMatches(r, tool, input))) return { action: 'allow', reason: 'allowed by a rule' };
  // Anything that outlives the session (memory) is confirmed once untrusted
  // content is in the context: a page must not be able to plant instructions
  // for every future session.
  if (ctx.tainted && tool.persists?.(input) && mode !== 'bypass') return { action: 'ask', reason: 'this is saved for future sessions, and the agent has read untrusted content (web pages or service results) in this session' };
  // After untrusted content, every way out is confirmed, whatever the mode would
  // otherwise allow: the content may be steering the agent to leak what it can read.
  if (ctx.tainted && mode !== 'bypass' && process.env.HARNESS_TAINT_GUARD !== 'off' && sendsOut(tool, input, ctx.network)) {
    const d = decideKindsOf(tool, input, ctx);
    if (d.action === 'deny') return d;
    return { action: 'ask', reason: 'the agent has read untrusted content (web pages or service results) in this session, and this call can send data out of it' };
  }

  return decideKindsOf(tool, input, ctx);
}

/** A call can need more than its tool's kind (render with export writes a file): every kind it needs is decided, and the strictest answer wins. */
function decideKindsOf(tool: Tool, input: Record<string, unknown>, ctx: PermissionContext): Decision {
  const kinds = tool.kindsFor?.(input) ?? [tool.kind];
  const order = { deny: 0, ask: 1, allow: 2 } as const;
  return kinds.map((k) => decideKind(k, input, ctx)).sort((a, b) => order[a.action] - order[b.action])[0]!;
}

function decideKind(kind: Tool['kind'], input: Record<string, unknown>, ctx: PermissionContext): Decision {
  const { mode } = ctx;
  switch (kind) {
    case 'read':
    case 'meta':
      return { action: 'allow', reason: 'read-only' };
    case 'edit':
      if (mode === 'plan') return { action: 'deny', reason: 'plan mode: no edits until the plan is approved (call exit_plan_mode)' };
      if (mode === 'acceptEdits' || mode === 'bypass') return { action: 'allow', reason: mode };
      return { action: 'ask', reason: 'edits need approval in default mode' };
    case 'exec': {
      const cmd = String(input.command ?? '');
      if (mode === 'bypass') return { action: 'allow', reason: 'bypass mode' };
      if (isReadOnlyCommand(cmd)) return { action: 'allow', reason: 'read-only command' };
      if (mode === 'plan') return { action: 'ask', reason: 'plan mode: commands that may change things need approval' };
      if (ctx.sandboxed) return { action: 'allow', reason: 'runs in the sandbox' };
      return { action: 'ask', reason: 'commands on this machine need approval' };
    }
    case 'network':
      if (mode === 'bypass') return { action: 'allow', reason: 'bypass mode' };
      return { action: 'ask', reason: 'fetching a URL needs approval' };
    case 'external':
      // Acts on another system (an MCP service): the sandbox does not contain it.
      if (mode === 'bypass') return { action: 'allow', reason: 'bypass mode' };
      if (mode === 'plan') return { action: 'deny', reason: 'plan mode: no actions on external services until the plan is approved' };
      return { action: 'ask', reason: 'actions on external services need approval' };
  }
}

/** The rule the UI offers for "always allow this in this session". */
export function suggestRule(tool: Tool, input: Record<string, unknown>): string {
  const name = tool.spec.name;
  if (name === 'bash') {
    const cmd = String(input.command ?? '').trim();
    if (hasShellControl(cmd)) return `bash(${cmd})`;
    const words = cmd.split(/\s+/);
    const head = words.slice(0, /^(npm|pnpm|yarn|git|cargo|go|python3?|pip3?|make|docker|npx|node)$/.test(words[0] ?? '') ? 2 : 1).join(' ');
    return `bash(${head}:*)`;
  }
  if (name === 'web_fetch') {
    try { return `web_fetch(domain:${new URL(String(input.url)).hostname})`; } catch { return 'web_fetch'; }
  }
  if (name === 'edit' || name === 'write') return 'edit_all';
  return name;
}
