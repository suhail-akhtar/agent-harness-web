// `npm run plugin -- test <dir>` runs a plugin's tests with this module preloaded (node --import): a
// plugin folder anywhere on the disk imports '@harness/plugin-sdk' (and its /testing, /ui) from this
// harness, with nothing installed in the folder.
import { register } from 'node:module';

const sdk = new URL('../../packages/plugin-sdk/src/', import.meta.url).href;
const hook = `
const SDK = ${JSON.stringify(sdk)};
const MAP = { '@harness/plugin-sdk': 'index.ts', '@harness/plugin-sdk/testing': 'testing.ts', '@harness/plugin-sdk/ui': 'ui.ts' };
export async function resolve(specifier, context, next) {
  if (Object.hasOwn(MAP, specifier)) return { url: SDK + MAP[specifier], shortCircuit: true };
  return next(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);
