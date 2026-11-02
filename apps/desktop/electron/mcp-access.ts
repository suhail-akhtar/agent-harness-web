/**
 * Your agents from other apps (Claude Desktop, Claude Code, Cursor, VS Code): the engine's MCP server (/mcp), when
 * the person turns it on in Settings. The engine's own token never leaves main, and its address changes with each
 * start, so other apps get what does not change: a token of their own (accepted on /mcp only, kept encrypted with
 * the OS keychain), and a bridge command that reads the engine's current address from a file this module writes
 * whenever the engine starts. The bridge runs on this app's own runtime (no Node.js install needed).
 */

import { app, safeStorage } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { JsonFile } from './store';

interface Stored { enabled: boolean; token?: string }

export interface McpAccessInfo {
  enabled: boolean;
  /** Present when on: the token and how to reach the engine from another app. */
  token?: string;
  url?: string;
  bridge?: { command: string; args: string[]; env: Record<string, string> };
  encryption: boolean;
}

export class McpAccess {
  private file: JsonFile<Stored>;
  readonly endpointFile: string;
  private bridgeScript: string;
  private url: string | null = null;

  constructor(dataDir: string, engineRoot: string) {
    this.file = new JsonFile<Stored>(path.join(dataDir, 'mcp-access.json'), () => ({ enabled: false }));
    this.endpointFile = path.join(dataDir, 'harness-mcp.json');
    this.bridgeScript = path.join(engineRoot, 'src', 'mcp', 'bridge.ts');
  }

  private token(): string | undefined {
    const t = this.file.value.token;
    if (!t) return undefined;
    try { return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(t, 'base64')) : Buffer.from(t, 'base64').toString('utf8'); } catch { return undefined; }
  }

  /** What the engine gets: the token it accepts on /mcp (none when off). */
  env(): Record<string, string> {
    const t = this.file.value.enabled ? this.token() : undefined;
    return t ? { HARNESS_MCP_TOKEN: t } : {};
  }

  /** The engine is up at `origin` (or down): the bridge's file follows. */
  engineAt(origin: string | null): void {
    this.url = origin ? `${origin}/mcp` : null;
    try {
      if (this.url && this.file.value.enabled) fs.writeFileSync(this.endpointFile, JSON.stringify({ url: this.url, at: Date.now() }));
      else fs.rmSync(this.endpointFile, { force: true });
    } catch { /* the bridge says it cannot find the app */ }
  }

  /** Turns it on (a new token the first time) or off; the engine restarts to take it. */
  set(enabled: boolean, renew = false): void {
    let token = this.file.value.token;
    if (enabled && (!token || renew)) {
      const raw = crypto.randomBytes(32).toString('base64url');
      token = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(raw).toString('base64') : Buffer.from(raw, 'utf8').toString('base64');
    }
    this.file.set({ enabled, ...(token ? { token } : {}) }, true);
  }

  info(): McpAccessInfo {
    const on = this.file.value.enabled;
    const token = on ? this.token() : undefined;
    return {
      enabled: on, encryption: safeStorage.isEncryptionAvailable(),
      ...(on && token ? {
        token, ...(this.url ? { url: this.url } : {}),
        bridge: { command: process.execPath, args: [this.bridgeScript, '--endpoint-file', this.endpointFile], env: { ELECTRON_RUN_AS_NODE: '1', HARNESS_TOKEN: token } },
      } : {}),
    };
  }
}

export const engineRootOf = (repoRoot: string | null): string => (app.isPackaged ? path.join(process.resourcesPath, 'engine') : repoRoot ?? process.cwd());
