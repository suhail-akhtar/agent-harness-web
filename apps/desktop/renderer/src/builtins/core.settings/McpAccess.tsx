/**
 * Settings > Use your agents elsewhere: the engine's MCP server for other apps (Claude Desktop, Claude Code,
 * Cursor, VS Code). Off until the person turns it on; then the configs to paste, each through the bridge command
 * (the engine's address changes with each start; the bridge finds it).
 */

import React, { useEffect, useState } from 'react';
import { Button, Callout, Field, Input, Meta, Section, Spinner, Switch, toast } from '@harness/ui';
import { useApp } from '../../state/app';
import { desktop } from '../../bridge';

type Info = Awaited<ReturnType<typeof desktop.mcpAccess>>;

export function McpAccess(): React.ReactElement {
  const [info, setInfo] = useState<Info | null>(null);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(false);
  useEffect(() => { void desktop.mcpAccess().then(setInfo); }, []);
  if (!info) return <Spinner />;
  const set = async (on: boolean, renew = false) => {
    setBusy(true);
    try { setInfo(await desktop.setMcpAccess(on, renew)); toast(on ? (renew ? 'A new token: update the other apps\' configs' : 'Other apps can use your agents') : 'Other apps can no longer use your agents', { kind: on ? 'success' : 'info' }); } catch (e) { toast((e as Error).message, { kind: 'error' }); } finally { setBusy(false); }
  };
  const renew = async () => {
    if (!await useApp.getState().ask({ title: 'Make a new token?', body: 'The apps that use the current one stop reaching your agents until their config has the new one.', confirmLabel: 'New token' })) return;
    await set(true, true);
  };
  const b = info.bridge;
  const server = b ? { command: b.command, args: b.args, env: b.env } : undefined;
  const configs = server ? [
    { id: 'claude-desktop', label: 'Claude Desktop', hint: 'Settings > Developer > Edit Config (claude_desktop_config.json), under "mcpServers".', text: JSON.stringify({ mcpServers: { 'agent-harness': server } }, null, 2) },
    { id: 'claude-code', label: 'Claude Code', hint: 'A project\'s .mcp.json (or ~/.claude.json for every project).', text: JSON.stringify({ mcpServers: { 'agent-harness': { type: 'stdio', ...server } } }, null, 2) },
    { id: 'cursor', label: 'Cursor', hint: '~/.cursor/mcp.json, or a project\'s .cursor/mcp.json.', text: JSON.stringify({ mcpServers: { 'agent-harness': server } }, null, 2) },
    { id: 'vscode', label: 'VS Code', hint: '.vscode/mcp.json in a folder, or the user mcp.json.', text: JSON.stringify({ servers: { 'agent-harness': { type: 'stdio', ...server } } }, null, 2) },
  ] : [];
  const copy = async (text: string, what: string) => { await desktop.clipboard(text); toast(`${what} copied`); };
  return (
    <div data-section="mcp-access">
      <Section title="Use your agents elsewhere" description="Claude Desktop, Claude Code, Cursor, VS Code and other MCP apps can hand work to your agents here: each of your agents is a tool there (and run_agent, list_agents, get_result). A run never waits for you: what would need your approval is refused.">
        <div className="flex items-center gap-3">
          <Switch checked={info.enabled} disabled={busy} label="Let other apps use my agents" onChange={(v) => void set(v)} />
          <span className="text-body">Let other apps use my agents</span>
          {busy && <Spinner />}
        </div>
      </Section>
      {info.enabled && info.token && (
        <>
          <Section dense title="Its token" description={info.encryption ? 'Kept encrypted with your system\'s keychain. Anyone with it can run your agents: keep it to your own apps.' : 'Anyone with it can run your agents: keep it to your own apps.'}>
            <div className="flex items-center gap-2">
              <Input data-mcp-token readOnly value={shown ? info.token : '•'.repeat(24)} className="max-w-md font-mono" />
              <Button variant="ghost" onClick={() => setShown(!shown)}>{shown ? 'Hide' : 'Show'}</Button>
              <Button icon="copy" onClick={() => void copy(info.token!, 'The token')}>Copy</Button>
              <Button variant="ghost" data-mcp-renew disabled={busy} onClick={() => void renew()}>New token</Button>
            </div>
            <Meta className="mt-2" items={[info.url ? `Now at ${info.url}` : 'The engine is starting', 'The address changes when the app restarts: the configs below find it themselves']} />
          </Section>
          <Section dense title="Add it to an app" description="Each config starts the app's bridge, which finds this app and passes calls to it. This app must be open for them to work.">
            <div className="flex flex-col gap-3">
              {configs.map((c) => (
                <Field key={c.id} label={c.label} help={c.hint}>
                  <div className="flex items-start gap-2">
                    <pre className="max-h-32 min-w-0 flex-1 overflow-auto rounded-md border border-hx-border-subtle bg-hx-pill p-2 font-mono text-caption">{c.text.replace(info.token!, '<token>')}</pre>
                    <Button icon="copy" data-mcp-config={c.id} onClick={() => void copy(c.text, `The ${c.label} config`)}>Copy</Button>
                  </div>
                </Field>
              ))}
            </div>
          </Section>
          <Callout tone="info" title="Over HTTP">{`Apps that connect to an address can use ${info.url ?? 'http://127.0.0.1:<port>/mcp'} with the header "Authorization: Bearer <token>" while the app is open; the address changes with each start.`}</Callout>
        </>
      )}
    </div>
  );
}
