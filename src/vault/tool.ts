import type { Tool, ToolKind } from '../tools/types.ts';
import { str } from '../tools/types.ts';
import { VAULT_KINDS, type VaultEntryInfo, type VaultKind, type VaultScope } from './store.ts';

// The agent's view of the key vault: names and metadata, and changes - never a
// value. A value the model writes itself (set) is hidden from the conversation
// from that call on; `generate` makes one the model never sees at all. To use an
// entry, the agent names it in a command's `secrets` (the bash tool), and the
// harness puts the value in that command's environment.

const WRITES = new Set(['create', 'set', 'generate', 'rotate', 'delete']);

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

function line(e: VaultEntryInfo): string {
  const rot = e.rotateBy ? (e.overdue ? ` ROTATION OVERDUE since ${day(e.rotateBy)}` : ` rotate by ${day(e.rotateBy)}`) : '';
  return `- ${e.name} (${e.kind}, ${e.scope} scope, version ${e.version}, ${e.backend})${e.description ? `: ${e.description}` : ''}${rot}`;
}

export const vaultTool: Tool = {
  kind: 'read', parallelSafe: false, remoteable: false,
  spec: {
    name: 'vault',
    description: 'The key vault: named secrets (passwords, tokens, keys, connection strings) you use without seeing them. list shows names and metadata; to use one in a command, pass it in bash\'s `secrets` ({"DB_PASSWORD": "prod-db"}): it becomes that environment variable for that command only, and its value is shown as [vault:name] everywhere. generate makes a new strong secret you never see (e.g. a password for a new database user; an ssh-key returns its public key); create/set store a value you have (it is hidden from the conversation from then on); rotate makes a new version (the old one is kept for rollback); history lists versions; delete removes an entry. There is no way to read a value here - do not try to print one.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'set', 'generate', 'rotate', 'delete', 'history'] },
        name: { type: 'string', description: 'Entry name: letters, digits, ".", "_", "-", "/".' },
        value: { type: 'string', description: 'create/set: the secret value.' },
        kind: { type: 'string', enum: [...VAULT_KINDS] },
        description: { type: 'string', description: 'What it is for (shown in list).' },
        scope: { type: 'string', enum: ['user', 'session'], description: 'user (default): yours in every session; session: this session only.' },
        rotate_days: { type: 'number', description: 'Remind to rotate it every N days.' },
        length: { type: 'number', description: 'generate: characters (password) or bytes (token, secret).' },
      },
      required: ['action'],
    },
  },
  // Writes are edits that outlive the session: asked in default mode, refused in plan mode,
  // confirmed after untrusted content; a delete is asked even when edits are accepted.
  kindsFor: (i) => (str(i.action) === 'delete' ? ['edit', 'external'] : WRITES.has(str(i.action)) ? ['edit'] : ['read']) as ToolKind[],
  sendsOut: false,
  persists: (i) => WRITES.has(str(i.action)),
  /** The value a create/set carries: hidden before the call is shown or stored anywhere. */
  secretInputs: (i) => ((str(i.action) === 'create' || str(i.action) === 'set') && str(i.name) && str(i.value) ? [{ name: str(i.name), value: str(i.value) }] : []),
  summarize: (i) => `vault ${str(i.action)}${i.name ? ` ${str(i.name)}` : ''}${i.kind ? ` (${str(i.kind)})` : ''}`,
  async run(input, ctx) {
    const v = ctx.services?.vault;
    if (!v) return { content: 'The key vault is not available in this session.', is_error: true };
    const action = str(input.action);
    const name = str(input.name).trim();
    if (action === 'list') {
      const all = await v.list();
      if (!all.length) return { content: 'The vault has no entries you can use. Store one with generate (a new secret) or create.' };
      const due = all.filter((e) => e.overdue);
      return { content: `${all.length} entr${all.length === 1 ? 'y' : 'ies'} (use one with bash's secrets: {"VAR": "<name>"}):\n${all.map(line).join('\n')}${due.length ? `\n\n${due.length} entr${due.length === 1 ? 'y is' : 'ies are'} past their rotation date: rotate ${due.length === 1 ? 'it' : 'them'} (action rotate) or tell the user.` : ''}` };
    }
    if (!name) return { content: `${action} needs a name.`, is_error: true };
    const m = v.manage;
    if (!m) return { content: 'Only the main agent changes the vault; list entries and use them in commands.', is_error: true };
    const kind = (str(input.kind) || undefined) as VaultKind | undefined;
    const scope = (str(input.scope) || undefined) as VaultScope | undefined;
    if (scope && scope !== 'user' && scope !== 'session') return { content: 'scope is user or session (operator entries are set by administrators).', is_error: true };
    const rotateEveryDays = typeof input.rotate_days === 'number' ? input.rotate_days : undefined;
    try {
      if (action === 'create' || action === 'set') {
        const value = str(input.value);
        if (!value) return { content: `${action} needs a value. To make a new random secret without one, use generate.`, is_error: true };
        const info = await m.put({ name, value, kind, description: str(input.description) || undefined, scope, rotateEveryDays, create: action === 'create' });
        return { content: `Stored ${line(info).slice(2)}. Its value is hidden as [vault:${name}] from now on. Use it with bash's secrets: {"VAR": "${name}"}.` };
      }
      if (action === 'generate') {
        const g = await m.generate({ name, kind: kind ?? 'password', description: str(input.description) || undefined, scope, rotateEveryDays, length: typeof input.length === 'number' ? input.length : undefined, create: true });
        return { content: `Generated ${line(g.info).slice(2)}. You never see the value: pass it to a command with bash's secrets {"VAR": "${name}"} (e.g. to set it as a database user's password).${g.publicKey ? `\nPublic key (safe to share):\n${g.publicKey}` : ''}` };
      }
      if (action === 'rotate') {
        const info = await m.rotate(name);
        return { content: `Rotated: ${line(info).slice(2)}. The previous version is kept for rollback. Anything that uses the old value must be updated (run the change with bash's secrets).` };
      }
      if (action === 'delete') {
        await m.remove(name);
        return { content: `Deleted ${name}.` };
      }
      if (action === 'history') {
        const h = await m.history(name);
        return { content: `${name}: ${h.map((x) => `version ${x.version}${x.current ? ' (current)' : ''}, ${new Date(x.createdAt).toISOString()} by ${x.by}`).join('; ')}` };
      }
      return { content: `Unknown action ${action}.`, is_error: true };
    } catch (e) {
      return { content: (e as Error).message, is_error: true };
    }
  },
};
