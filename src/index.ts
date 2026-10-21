// harness-web as a library. Build an agent product by composing these:
//   createHarness   - registry + plugins + MCP + sessions in one call
//   definePlugin    - package tools, models, providers, agents, skills, gates, hooks
//   defineTool      - a tool from a JSON schema and a function
//   Agent           - the loop itself, for custom orchestration (graphs, pipelines)

export { createHarness, builtinRegistry, type Harness, type HarnessOptions } from './kernel/harness.ts';
export { Registry, type LoadedPlugin, type InProcessHook } from './kernel/registry.ts';
export { definePlugin, defineTool } from './plugins/api.ts';
export type { AgentDef, GateResult, HookHandler, McpServerConfig, PluginAPI, PluginDefinition, PluginManifest, ProviderDef, QualityGate } from './plugins/api.ts';
export { Agent, type AgentConfig, type AgentHooks, type TraceSpan } from './core/agent.ts';
export { Session, SessionElsewhereError, type SessionMeta } from './core/session.ts';
export { SessionManager } from './core/manager.ts';
export { BUILTIN_MODELS, costOf, type Effort, type ModelSpec } from './core/models.ts';
export { decide, type Rules } from './core/permissions.ts';
export type { Block, HarnessEvent, Message, PermissionMode, Usage } from './core/types.ts';
export type { Provider, ProviderRequest, ProviderResponse, ToolSpec } from './providers/types.ts';
export { ProviderError } from './providers/types.ts';
export { CompatProvider, loadCompatModels, type CompatModelConfig } from './providers/compat.ts';
export { Leases, type ClusterConfig, type LeaseRecord } from './util/lease.ts';
export type { Tool, ToolContext, ToolKind, ToolOutcome } from './tools/types.ts';
export { BUILTIN_TOOLS } from './tools/index.ts';
export type { ExecResult, ToolHost } from './runtime/host.ts';
export { LocalHost } from './runtime/host.ts';
export { DockerHost } from './runtime/docker.ts';
export { McpClient, HttpTransport, StdioTransport } from './mcp/client.ts';
export { VaultStore, VaultError, type VaultService, type VaultEntryInfo, type VaultKind, type VaultScope, type RotationHandler } from './vault/store.ts';
export { Redactor } from './vault/redact.ts';
export type { Backend } from './vault/backends.ts';
