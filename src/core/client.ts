import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateValue, type JsonSchema } from '../../packages/plugin-ui/src/manifest.ts';

// What app a session's person uses (the desktop, the browser UI, a CLI) and what it can do:
// the fence languages it draws, and the desktop tools it serves. Declared once when the
// session is made (POST /api/sessions {client}) and rendered once into that session's
// system prompt, so the cached prefix never changes under it.
//
// "Attached" is the declaration plus a live event-stream subscriber from that client kind,
// on the session's stream or the person's global one: only then do desktop tools reach it.

export const CLIENT_KINDS = ['desktop', 'web', 'cli'] as const;
export type ClientKind = typeof CLIENT_KINDS[number];

/** The desktop tools a client may serve (each forwarded to it as a client_call). */
export const DESKTOP_TOOLS = ['desktop_command', 'desktop_describe', 'desktop_notify', 'desktop_open'] as const;
export type DesktopTool = typeof DESKTOP_TOOLS[number];

/** A command of the client's own (native) plugins that an agent may run: the server cannot read those manifests. */
export interface ClientCommand { id: string; description: string; inputSchema?: JsonSchema }

export interface ClientDecl {
  kind: ClientKind;
  version: string;
  renderers: string[];
  tools: DesktopTool[];
  commands?: ClientCommand[];
}

export class ClientDeclError extends Error {}

const NAME = /^[a-z0-9][a-z0-9._:+-]{0,59}$/i;
const COMMAND = /^[a-z0-9][a-z0-9._-]{0,62}:[a-z0-9][a-z0-9._-]{0,62}$/i;

/** Validates a client declaration (sizes capped); throws ClientDeclError with what to fix. */
export function cleanClient(raw: unknown): ClientDecl {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ClientDeclError('client must be {kind, version, renderers, tools}');
  const c = raw as Record<string, unknown>;
  if (!(CLIENT_KINDS as readonly string[]).includes(String(c.kind))) throw new ClientDeclError(`client.kind is ${CLIENT_KINDS.join(', ')}`);
  const version = c.version === undefined ? '' : String(c.version);
  if (version.length > 40 || /[\r\n]/.test(version)) throw new ClientDeclError('client.version is at most 40 characters');
  const list = (k: string, max: number): string[] => {
    const v = c[k];
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > max) throw new ClientDeclError(`client.${k} is a list of at most ${max} names`);
    for (const x of v) if (typeof x !== 'string' || !NAME.test(x)) throw new ClientDeclError(`client.${k}: "${String(x).slice(0, 60)}" is not a name (letters, digits, . _ : + -; at most 60)`);
    return [...new Set(v as string[])];
  };
  const renderers = list('renderers', 100).sort();
  const tools = list('tools', 10);
  for (const t of tools) if (!(DESKTOP_TOOLS as readonly string[]).includes(t)) throw new ClientDeclError(`client.tools: "${t}" is not a desktop tool (${DESKTOP_TOOLS.join(', ')})`);
  let commands: ClientCommand[] | undefined;
  if (c.commands !== undefined) {
    if (!Array.isArray(c.commands) || c.commands.length > 100) throw new ClientDeclError('client.commands is a list of at most 100 {id, description, inputSchema?}');
    commands = c.commands.map((x) => {
      const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
      if (typeof o.id !== 'string' || !COMMAND.test(o.id)) throw new ClientDeclError('client.commands: every id is "<plugin>:<command>"');
      if (typeof o.description !== 'string' || !o.description.trim() || o.description.length > 300) throw new ClientDeclError(`client.commands ${o.id}: a description of at most 300 characters`);
      if (o.inputSchema !== undefined && (!o.inputSchema || typeof o.inputSchema !== 'object' || JSON.stringify(o.inputSchema).length > 4000)) throw new ClientDeclError(`client.commands ${o.id}: inputSchema is a JSON Schema object of at most 4,000 characters`);
      return { id: o.id, description: o.description.trim(), ...(o.inputSchema ? { inputSchema: o.inputSchema as JsonSchema } : {}) };
    });
  }
  return { kind: c.kind as ClientKind, version, renderers, tools: (tools as DesktopTool[]).sort(), ...(commands?.length ? { commands } : {}) };
}

/** The block added to the session's system prompt, once, from its declaration. Short on purpose: it is in every request. */
export function clientPrompt(c: ClientDecl, opts: { artifacts: boolean }): string {
  const app = c.kind === 'desktop' ? 'the desktop app' : c.kind === 'web' ? 'the browser app' : 'a terminal client';
  const lines = [`# Client\nThe person uses ${app}${c.version ? ` ${c.version}` : ''}.`];
  if (c.renderers.length) lines.push(`It draws these Markdown code fences instead of showing their source: ${c.renderers.join(', ')}.`);
  if (clientSkillDirs(c).length) lines.push('Before writing a biology fence, load the rich-output skill for its exact format.');
  if (opts.artifacts) lines.push('Put documents, apps, diagrams and data the person will keep or reuse in the artifact tool (versioned; shown in its Artifacts panel and Library; html/svg/react run sandboxed), not in long chat replies.');
  if (c.tools.length) lines.push(`Desktop tools (${c.tools.join(', ')}) act in that app and work only while it is open on this session.`);
  return lines.join('\n');
}

/** Fences whose formats live in the core `rich-output` skill (src/skills/core), loaded on demand. */
export const SKILL_FENCES = ['fasta', 'msa', 'newick', 'plasmid', 'gff', 'bed', 'tracks', 'uniprot', 'pathway', 'volcano', 'ma', 'heatmap', 'kaplan-meier', 'manhattan'] as const;
const CORE_SKILLS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'core');

/** The core skill folders a session gets for its client: only when the client draws fences they describe (other sessions' prompts stay as they were). */
export function clientSkillDirs(c: ClientDecl | undefined): Array<{ dir: string; source: string }> {
  return c && c.renderers.some((r) => (SKILL_FENCES as readonly string[]).includes(r)) ? [{ dir: CORE_SKILLS, source: 'core' }] : [];
}

/** Args for a client-declared agent command, checked against its schema. */
export function commandArgsProblems(schema: JsonSchema | undefined, args: unknown): string[] {
  if (!schema) return [];
  return validateValue(schema, args ?? {}, 'args');
}

/**
 * Who is attached where: live event-stream subscribers that said which client they are
 * (?client=desktop), counted per session and per person (the global stream).
 */
export class ClientPresence {
  private session = new Map<string, number>();
  private global = new Map<string, number>();

  private static key(...p: (string | undefined)[]): string { return p.map((x) => x ?? '').join('\0'); }

  /** A subscriber came; the function it returns is called when it goes. */
  attach(a: { kind: ClientKind; owner: string | undefined; sessionId?: string }): () => void {
    const map = a.sessionId ? this.session : this.global;
    const k = a.sessionId ? ClientPresence.key(a.sessionId, a.kind, a.owner) : ClientPresence.key(a.kind, a.owner);
    map.set(k, (map.get(k) ?? 0) + 1);
    let gone = false;
    return () => {
      if (gone) return;
      gone = true;
      const n = (map.get(k) ?? 1) - 1;
      if (n <= 0) map.delete(k); else map.set(k, n);
    };
  }

  /** Whether a client of this kind, signed in as the session's owner, is listening to it now. */
  attached(sessionId: string, kind: ClientKind, owner: string | undefined): boolean {
    return (this.session.get(ClientPresence.key(sessionId, kind, owner)) ?? 0) > 0 || (this.global.get(ClientPresence.key(kind, owner)) ?? 0) > 0;
  }
}
