/// <reference path="../../../src/data/vendor.d.ts" />
/**
 * @harness/plugin-sdk: the types of everything a plugin's server code gets and gives.
 *
 * A plugin imports only TYPES from here (`import type`), so it runs wherever it is installed with
 * nothing to bundle: everything at run time comes through the `api` its setup() is handed.
 *
 *   import type { PluginAPI, PluginDefinition } from '@harness/plugin-sdk';
 *
 *   export default {
 *     name: 'reading-list',
 *     setup(api: PluginAPI) {
 *       const db = api.store('links', { initial: () => ({ links: [] as Link[] }) });
 *       api.registerTool({ name: 'reading_list_add', description: '...', parameters: {...}, kind: 'edit', run: async (i) => ... });
 *     },
 *   } satisfies PluginDefinition;
 *
 * In plain JavaScript, the same types through JSDoc: `/** @param {import('@harness/plugin-sdk').PluginAPI} api *\/`.
 * The guide: docs/plugin-sdk/README.md. The test kit: '@harness/plugin-sdk/testing'. Page types: '@harness/plugin-sdk/ui'.
 */

export type {
  PluginAPI, PluginDefinition, PluginManifest, ToolDefinition, AgentDef, McpServerConfig, QualityGate, GateResult,
  HookPayload, HookAnswer, HookHandler, ProviderDef, PluginRoute, PluginRouteRequest, PluginRouteResponse,
  PluginEventHandler, PluginSessions, PluginSessionStart,
} from '../../../src/plugins/api.ts';
export type { StoreOptions, PluginStore } from '../../../src/plugins/store.ts';
export type { Tool, ToolContext, ToolKind, ToolOutcome, ToolServices } from '../../../src/tools/types.ts';
export type { ToolHost } from '../../../src/runtime/host.ts';
export type { JsonSchema } from '../../../src/providers/types.ts';
export type { WorkflowDef } from '../../../src/graph/types.ts';
export type { HookEvent } from '../../../src/core/settings.ts';
export type { HarnessEvent, PermissionMode } from '../../../src/core/types.ts';
export type { UiManifest, Capability } from '../../plugin-ui/src/manifest.ts';
