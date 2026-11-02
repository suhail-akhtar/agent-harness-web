// Module resolution hooks for sdk-loader.mjs: the SDK's packages as the harness has them.
const FROM = new URL('../../../package.json', import.meta.url).href;
const OURS = /^(@modelcontextprotocol\/(server|client|core)(\/.*)?|@duckdb\/node-api|zod(\/.*)?)$/;

export async function resolve(specifier, context, next) {
  if (OURS.test(specifier)) return next(specifier, { ...context, parentURL: FROM });
  return next(specifier, context);
}
