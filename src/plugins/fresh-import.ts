import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

// A plugin's code imported again after it changed (a live reload): Node keeps every module it
// imported, so the new import carries ?hv=<n>, and a loader hook gives the same mark to every file
// that module imports from its own folder (its helpers load fresh too; node_modules and Node's
// own modules do not).

const HOOK = `
export async function resolve(specifier, context, next) {
  const r = await next(specifier, context);
  const parent = context.parentURL;
  if (!parent || !parent.startsWith('file:') || !r.url.startsWith('file:') || r.url.includes('/node_modules/')) return r;
  const mark = new URL(parent).searchParams.get('hv');
  const root = new URL(parent).searchParams.get('hvroot');
  if (!mark || !root || !r.url.startsWith(root)) return r;
  const u = new URL(r.url);
  u.searchParams.set('hv', mark);
  u.searchParams.set('hvroot', root);
  return { ...r, url: u.href };
}
`;

let registered = false;
let count = 0;

/** Imports `file` fresh: it and the files it imports from under `root`, not Node's cached copies. */
export async function freshImport(file: string, root: string): Promise<unknown> {
  if (!registered) { register(`data:text/javascript,${encodeURIComponent(HOOK)}`); registered = true; }
  const u = pathToFileURL(file);
  u.searchParams.set('hv', String(++count));
  u.searchParams.set('hvroot', pathToFileURL(root).href.replace(/\/?$/, '/'));
  return import(u.href);
}
