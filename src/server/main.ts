import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from '../kernel/harness.ts';
import { checkSandboxRuntime, sandboxRuntime } from '../runtime/docker.ts';
import { createApp } from './app.ts';
import { BrowserSessions, NOBODY_ALLOWED, OidcClient, oidcConfigFromEnv, refusal } from './oidc.ts';
import { SpendLedger, UserStore } from './users.ts';
import { ensureHome, harnessPaths, scheduleTmpCleanup } from '../util/home.ts';
import { shippedPluginDirs } from '../plugins/shipped.ts';

// The server process: configuration from the environment, then the app.

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..', '..');
// The harness home (~/.harness, or HARNESS_HOME): data, workspaces, tmp, exports, plugins, logs.
// HARNESS_DATA still names the data folder; the repository's .harness-data (the old default) is used while it has data and the home has none.
const PATHS = harnessPaths({ legacy: path.join(appRoot, '.harness-data') });
const DATA_DIR = PATHS.dataDir;
const HOST = process.env.HARNESS_HOST || '127.0.0.1';
const PORT = Number(process.env.HARNESS_PORT || 4310);
// The home's workspaces and tmp, then HARNESS_LOCAL_ROOTS (HARNESS_HOME_ROOTS=off leaves only the latter).
const LOCAL_ROOTS = PATHS.localRoots;
const loopback = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
const AUTH_OFF = process.env.HARNESS_AUTH === 'off' && loopback;
const TOKEN = process.env.HARNESS_TOKEN || crypto.randomBytes(18).toString('base64url');
// Bundled plugins (quality gates, SDLC, ...) load unless HARNESS_BUNDLED_PLUGINS=off.
const PLUGIN_DIRS = [...(process.env.HARNESS_BUNDLED_PLUGINS === 'off' ? [] : shippedPluginDirs(appRoot)), ...(process.env.HARNESS_PLUGINS || '').split(path.delimiter).filter(Boolean)];
const num = (v: string | undefined) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);

async function main() {
  // A stronger sandbox runtime the operator asked for (gVisor, Kata) must be there: refuse to start rather than run sandboxes without it.
  if (process.env.HARNESS_SANDBOX_RUNTIME?.trim()) {
    try { await checkSandboxRuntime(sandboxRuntime()!); } catch (e) { console.error(`sandbox runtime: ${(e as Error).message}`); process.exit(1); }
  }
  ensureHome(PATHS.layout);
  const stopTmpCleanup = scheduleTmpCleanup(PATHS.layout, (m) => console.log(m));
  const oidc = oidcConfigFromEnv(process.env);
  const users = await new UserStore(DATA_DIR).load();
  // The desktop app's bearer sessions (sign-in through the system browser) are kept beside the browser ones.
  const desktopDays = Math.max(1, Number(process.env.HARNESS_DESKTOP_SESSION_DAYS ?? 30) || 30);
  const sso = oidc ? {
    client: new OidcClient(oidc), sessions: await new BrowserSessions(DATA_DIR).load(),
    desktop: await new BrowserSessions(DATA_DIR, { file: 'desktop-sessions.json', idleMs: Math.min(14, desktopDays) * 86_400_000, maxMs: desktopDays * 86_400_000 }).load(),
  } : undefined;
  const spend = await new SpendLedger(DATA_DIR, num(process.env.HARNESS_USER_DAILY_USD)).load();
  const harness = await createHarness({
    dataDir: DATA_DIR,
    plugins: PLUGIN_DIRS,
    shippedPlugins: shippedPluginDirs(appRoot),
    // Studio, Operations, Engineering, DevOps: only the ones installed here (HARNESS_SOLUTIONS_MODE=all loads every one, as before).
    solutions: process.env.HARNESS_SOLUTIONS_MODE === 'all' ? 'all' : 'installed',
    installDir: PATHS.installDir,
    mcp: process.env.HARNESS_MCP_CONFIG || undefined,
    spend,
    // HARNESS_VAULT=admins: only sessions of administrators (and the single-user server's) get the key vault.
    ...(process.env.HARNESS_VAULT?.trim() === 'admins' ? { vault: { mayUse: (owner: string | undefined) => !owner || users.get(owner)?.role === 'admin' } } : {}),
    log: (m) => console.log(m),
  });
  const { server } = createApp({
    harness, token: TOKEN, authOff: AUTH_OFF, loopback, localRoots: LOCAL_ROOTS,
    uiDir: path.join(appRoot, 'ui', 'dist'), appRoot, users, spend, sso,
    rateLimit: num(process.env.HARNESS_RATE_LIMIT), messageRateLimit: num(process.env.HARNESS_MESSAGE_RATE_LIMIT),
  });
  server.listen(PORT, HOST, () => {
    console.log(`harness-web listening on http://${HOST}:${PORT}`);
    console.log(`home: ${PATHS.layout.home}`);
    console.log(`data: ${DATA_DIR}${PATHS.dataFrom === 'legacy' ? ` (the older default folder: move it to ${PATHS.layout.data}, or set HARNESS_DATA to keep it)` : PATHS.dataFrom === 'env' ? ' (HARNESS_DATA)' : ''}`);
    console.log(`local folders: ${LOCAL_ROOTS.join(path.delimiter) || 'none'}`);
    if (AUTH_OFF) console.log('auth: off (loopback only)');
    else if (!process.env.HARNESS_TOKEN) console.log(`access token (set HARNESS_TOKEN to fix it): ${TOKEN}`);
    if (users.size) console.log(`accounts: ${users.size} (npm run users -- list)`);
    if (sso) {
      console.log(`single sign-on: ${oidc!.issuer}; register the redirect URI ${sso.client.redirectUri}${oidc!.only ? '; personal tokens are off (HARNESS_OIDC_ONLY)' : ''}`);
      if (refusal(oidc!, undefined) === NOBODY_ALLOWED) console.warn(`single sign-on: ${NOBODY_ALLOWED}`);
    }
    const models = harness.registry.listModels();
    console.log(`models: ${models.map((m) => `${m.id}${m.available ? '' : ' (no key)'}`).join(', ')}`);
    console.log(`plugins: ${harness.registry.plugins.map((x) => x.name).join(', ') || 'none'}`);
    console.log(`web search: ${harness.search ?? 'off'}`);
  });
  // A clean stop: turns end, SessionEnd hooks run (reason "shutdown"), MCP servers and plugins close.
  // A second signal, or 15 seconds, exits at once.
  let stopping = false;
  const stop = (sig: string) => {
    if (stopping) process.exit(1);
    stopping = true;
    stopTmpCleanup();
    console.log(`${sig}: shutting down`);
    setTimeout(() => process.exit(1), 15_000).unref();
    server.close();
    harness.close().catch((e: Error) => console.error(e.message))
      .then(() => Promise.all([spend.flush(), sso?.sessions.flush(), sso?.desktop.flush()])).catch(() => {})
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

main().catch((err) => { console.error(err); process.exit(1); });
