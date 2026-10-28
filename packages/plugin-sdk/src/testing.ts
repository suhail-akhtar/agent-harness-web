/// <reference path="../../../src/data/vendor.d.ts" />
/**
 * The plugin test kit: load a plugin folder into a real harness and call its tools, its routes (over
 * HTTP) and whole conversations (scripted, or a real model). See src/plugins/testkit.ts and
 * docs/plugin-sdk/TESTING.md. Run a plugin's tests with `npm run plugin -- test <dir>`.
 *
 * Below it, the parts of the harness a plugin's own tests may build on, and fixtures. A plugin's (or a
 * solution's) tests import these from here, never the harness's files (@harness/core/...): this is the
 * contract kept between versions, so the tests run unchanged wherever the plugin is developed. How the
 * desktop app shows a plugin: @harness/plugin-sdk/testing/desktop.
 */
export { loadPlugin } from '../../../src/plugins/testkit.ts';
export type { PluginTestKit, ScriptedTurn, ChatResult, RouteResult, ToolCallRecord } from '../../../src/plugins/testkit.ts';

// Fixtures: plugin folders by name (pluginDir, shippedPlugins), temporary folders (removed when the test process ends), a scripted model, small PNG and GLB files.
export { FakeProvider, glbBytes, pluginDir, pngBytes, shippedPlugins, tempDir, testPicture, type ScriptedStep } from '../../../src/plugins/test-fixtures.ts';

// A harness of its own (createHarness({ dataDir, plugins: [dir] })) and the registry a plugin loads into.
export { createHarness, type Harness, type HarnessOptions } from '../../../src/kernel/harness.ts';
export { Registry } from '../../../src/kernel/registry.ts';
export { loadPlugin as loadPluginInto, readManifest } from '../../../src/plugins/loader.ts';
export { readPluginUi } from '../../../src/plugins/ui.ts';
export { readPluginGuide } from '../../../src/plugins/guides.ts';

// Where tools run, and what they are given.
export { LocalHost, type ExecOptions, type ExecResult, type ToolHost } from '../../../src/runtime/host.ts';
export { DockerHost, dockerAvailable, dockerDefaults, imageExists } from '../../../src/runtime/docker.ts';
export type { ToolContext } from '../../../src/tools/types.ts';
export { validateInput } from '../../../src/tools/index.ts';

// Gates, skills, workflows and evals, checked as the harness checks them.
export { formatGates, runGates } from '../../../src/gates/gates.ts';
export { skillsIn } from '../../../src/skills/skills.ts';
export { validateWorkflow } from '../../../src/graph/validate.ts';
export type { WorkflowDef } from '../../../src/graph/types.ts';
export { loadCases, runChecks } from '../../../src/eval/runner.ts';

// Messages and model providers.
export type { Block, Message } from '../../../src/core/types.ts';
export type { Provider, ProviderRequest, ProviderResponse } from '../../../src/providers/types.ts';

// The page manifest (ui) and guide contract.
export { composeGuide, GENERATED_MARKER, parseGuideMarkdown, uiEntries, validateUiManifest, type UiManifest } from '../../plugin-ui/src/index.ts';
