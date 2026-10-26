/// <reference path="../../../src/data/vendor.d.ts" />
/**
 * The plugin test kit: load a plugin folder into a real harness and call its tools, its routes (over
 * HTTP) and whole conversations (scripted, or a real model). See src/plugins/testkit.ts and
 * docs/plugin-sdk/TESTING.md. Run a plugin's tests with `npm run plugin -- test <dir>`.
 */
export { loadPlugin } from '../../../src/plugins/testkit.ts';
export type { PluginTestKit, ScriptedTurn, ChatResult, RouteResult, ToolCallRecord } from '../../../src/plugins/testkit.ts';
