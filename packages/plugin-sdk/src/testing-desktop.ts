/**
 * How the desktop app shows a plugin, for a plugin's tests: its registry (pages, commands, panels, menus),
 * what the app's agent is told about it, the answers its pages get, and a tool card's context. These are the
 * desktop app's own modules: they need the harness's checkout (apps/desktop), not a packaged app.
 * Screenshots of a real window: capture and assertNotBlank.
 */
export { buildRegistry, type PluginEntry } from '../../../apps/desktop/renderer/src/registry/registry.ts';
export { describePlugin } from '../../../apps/desktop/renderer/src/registry/agent-surface.ts';
export { registryAnswer } from '../../../apps/desktop/renderer/src/registry/frame-host.ts';
export { toolRendererContext, TOOL_CONTEXT_IMAGE_BYTES } from '../../../apps/desktop/renderer/src/registry/tool-context.ts';
export { assertNotBlank, capture } from '../../../test/fixtures/desktop/png.ts';
