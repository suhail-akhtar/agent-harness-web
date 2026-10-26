/// <reference path="../../../src/data/vendor.d.ts" />
/**
 * @harness/plugin-sdk/runtime: the harness's own abilities, for plugin code (official and custom alike).
 *
 *   import { defineTool, resolveIn, writeFileAtomic, findBinary } from '@harness/plugin-sdk/runtime';
 *
 * One stable import path wherever a plugin is installed: the harness resolves it to its own modules
 * (src/plugins/resolve.ts), so a plugin never imports the harness's files by relative path. Anything a
 * plugin needs per call (the session's host, the vault, other tools) comes with the call: `api` in setup,
 * `ctx` in a tool. This module holds what is the same for every plugin.
 */

import path from 'node:path';

/** Where the harness itself is (its checkout, or the engine of the desktop app): for paths to its SDK and tools. */
export const HARNESS_ROOT: string = path.resolve(import.meta.dirname, '..', '..', '..');

/** A Tool object from a plain definition (what api.registerTool does with one; for code that builds tools ahead). */
export { defineTool } from '../../../src/plugins/api.ts';
export type { ToolDefinition } from '../../../src/plugins/api.ts';

// ---- paths and files ----
/** A path inside a workspace (symlink-safe; PathError when it leaves it), and the check itself. */
export { resolveIn, within, PathError } from '../../../src/tools/paths.ts';
/** The harness home (~/.harness) and its folders (data, workspaces, engines, tmp...). */
export { resolveHome, harnessPaths } from '../../../src/util/home.ts';
/** JSON read with a fallback, files written atomically, a lock several servers share. */
export { readJson, writeFileAtomic, withFileLock } from '../../../src/util/shared-file.ts';

// ---- running programs ----
/** A program run with arguments (no shell), and the server's environment without its credentials. */
export { run, scrubbedEnv } from '../../../src/runtime/host.ts';
/** A program on this machine by name (PATH and the usual install places), and what to say when it is missing. */
export { findBinary, installPlaces, missingMessage, pathNames } from '../../../plugins/visual/lib/binaries.mjs';
/** The headless browser (Playwright's Chromium): a folder served, a page run, frame statistics. */
export { withBrowser, serveDir, chromiumPath, closeBrowser, runPage, frameStats } from '../../../plugins/visual/lib/browser.mjs';
/** Browser libraries (three.js, ...) copied into a folder from the harness's own copies. */
export { addLibrary, LIBRARIES } from '../../../plugins/visual/lib/libraries.mjs';

// ---- schedules and the change journal ----
/** A cron expression as a predicate on dates (five fields, the usual forms). */
export { parseCron } from '../../../src/core/scheduler.ts';
/** The kinds of change the journal records (api.changes), and its error. */
export { CHANGE_KINDS, ChangeError } from '../../../src/ops/changes.ts';

// ---- privacy ----
/** Whether text looks like a credential (a key, a token, a password): never store or show it. */
export { looksSecret } from '../../../src/memory/store.ts';

// ---- building plugins (the plugin-dev plugin, and any tool that makes or checks plugins) ----
/** A complete plugin written from the template; the deep review (in a child process: the plugin cannot reach the caller); its tests. */
export { scaffold, scaffoldFiles } from '../../../src/plugins/scaffold.ts';
export { reviewInChild, formatReview } from '../../../src/plugins/review.ts';
export type { Review, Finding } from '../../../src/plugins/review.ts';
export { runPluginTests, pluginTestFiles } from '../../../src/plugins/run-tests.ts';
