/**
 * Types for a plugin's pages: the client `HarnessPluginUI.connect()` resolves to, and the UI kit's
 * components (`HarnessPluginUI.ui`). A page loads both as scripts (harness://app/sdk/plugin-ui.js and
 * plugin-ui.css); a page written in TypeScript and bundled may import them from here instead.
 */
export type { Harness } from '../../plugin-ui/src/sdk.ts';
export { connect, ui } from '../../plugin-ui/src/sdk.ts';
export type { Column, Field, Tone } from '../../plugin-ui/src/kit.ts';
