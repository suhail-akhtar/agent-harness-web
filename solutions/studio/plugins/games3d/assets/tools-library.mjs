// studio_library: the project's assets and the shared library (~/.harness/assets): list,
// search, show, import files as assets (with a licence), publish to the library, copy
// into the project, verify hashes, and rehash after a deliberate edit.

import { readIn } from '../lib-engines.mjs';
import { guarded, unknownAction } from './common.mjs';
import { assetsDir, copyToProject, importFiles, libraryRoot, manifestProblems, projectAssets, projectOf, publishAsset, searchAssets, sha256, verifyAsset } from './library.mjs';
import { writeIn } from '../lib-engines.mjs';

const ACTIONS = ['list', 'search', 'show', 'import', 'publish', 'copy', 'verify', 'rehash'];

export const libraryTool = {
  name: 'studio_library',
  description: `Studio's asset library. Every asset is a folder .studio/assets/<id>/ in the project with asset.json (kind, files, source, licence, hashes, tags, style, meta); the shared library is ${'`'}~/.harness/assets${'`'} (all projects of this harness). action: "list" the project's assets; "search" by kind, tags (all must match), style, text, licence, where (project|library|both); "show" one asset's manifest; "import" files already in the workspace as an asset (needs license {id, author?, url?}); "publish" a project asset to the shared library; "copy" a library asset into the project (hashes checked after the copy); "verify" every asset's files against its hashes; "rehash" an asset after you edited one of its files on purpose.`,
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ACTIONS, description: 'What to do: list, search, show, import, publish, copy, verify or rehash' },
      id: { type: 'string', description: 'The asset id, e.g. "sprite-character-1" (show, publish, copy, rehash; verify one; import: the new id, default from the name)' }, as: { type: 'string', description: 'copy: the id in the project' },
      kind: { type: 'string', description: 'search: only this kind; import: the asset kind (default model), e.g. texture, sprite, audio' }, tags: { type: 'array', items: { type: 'string' }, description: 'search: tags that must all match; import: the asset\'s tags' }, style: { type: 'string', description: 'search: only this style; import: the asset\'s style label (e.g. "pixel-16")' }, text: { type: 'string', description: 'search: words to find in ids, names and tags' }, license: { type: ['string', 'object'], description: 'import: the licence {id, author?, url?} or just its id, e.g. "CC0-1.0"; search: a licence id to match' },
      where: { type: 'string', enum: ['project', 'library', 'both'], description: 'search: the project, the shared library or both (default both)' }, limit: { type: 'number', description: 'search: most results to return (default 50)' },
      files: { type: 'array', items: { type: ['string', 'object'] }, description: 'import: workspace paths (or {path, role, as})' },
      name: { type: 'string', description: 'import: what the asset is called (default the first file\'s name)' }, meta: { type: 'object', description: 'import: extra manifest metadata, e.g. {"size":[64,64]}' }, source: { type: 'object', description: 'import: where the files came from, recorded in the manifest (default the workspace paths)' },
      overwrite: { type: 'boolean', description: 'publish/copy: replace an asset with the same id already there (default false)' }, project: { type: 'string', description: 'Project folder (with .studio/project.json); default found' },
    },
    required: ['action'],
  },
  kind: 'edit',
  kindsFor: (i) => (['list', 'search', 'show', 'verify'].includes(String(i.action)) ? ['read'] : ['edit']),
  sendsOut: false,
  summarize: (i) => `${i.action} ${i.id ?? i.text ?? i.kind ?? ''}`.trim(),
  run: guarded('studio_library', async (input, ctx) => {
    const { host, signal } = ctx;
    const a = String(input.action ?? '');
    const project = await projectOf(host, input.project);
    if (a === 'list') {
      const all = await projectAssets(host, project, signal);
      if (!all.length) return `No assets in ${assetsDir(project)} yet. The shared library is ${libraryRoot()}.`;
      return all.map((x) => (x.manifest ? `${x.manifest.id} [${x.manifest.kind}] ${x.manifest.name}: ${x.manifest.files.length} file(s), ${x.manifest.license?.id ?? 'NO LICENCE'}, ${x.manifest.source?.type}${x.manifest.tags?.length ? `, tags ${x.manifest.tags.join(' ')}` : ''}` : `${x.id}: ${x.error}`)).join('\n');
    }
    if (a === 'search') {
      const res = await searchAssets(host, project, { kind: input.kind, tags: input.tags, style: input.style, text: input.text, license: typeof input.license === 'string' ? input.license : undefined, where: input.where, limit: input.limit }, signal);
      return res.length ? res.map((r) => `${r.where}: ${r.id} [${r.kind}] ${r.name} (${r.license}; ${r.source}${r.tags?.length ? `; ${r.tags.join(' ')}` : ''}${r.style ? `; style ${r.style}` : ''})`).join('\n') : 'No matching assets.';
    }
    if (a === 'show') {
      if (!input.id) throw new Error('show needs id');
      return (await readIn(host, `${assetsDir(project)}/${input.id}/asset.json`, signal)).toString('utf8');
    }
    if (a === 'import') {
      if (!Array.isArray(input.files) || !input.files.length) throw new Error('import needs files: workspace paths');
      const lic = typeof input.license === 'string' ? { id: input.license } : input.license;
      const r = await importFiles(host, project, { id: input.id, name: input.name, kind: input.kind ?? 'model', files: input.files, license: lic, source: input.source, tags: input.tags, style: input.style, meta: input.meta }, signal);
      const p = manifestProblems(r.manifest, r.manifest.id);
      return `Imported ${r.manifest.id} into ${r.dir} (${r.manifest.files.length} file(s), ${r.manifest.license.id}).${p.length ? `\nProblems: ${p.join('; ')}` : ''}`;
    }
    if (a === 'publish') { if (!input.id) throw new Error('publish needs id'); const r = await publishAsset(host, project, String(input.id), { overwrite: !!input.overwrite }, signal); return `Published ${r.id} (${r.files} files) to the shared library at ${r.to}.`; }
    if (a === 'copy') { if (!input.id) throw new Error('copy needs id'); const r = await copyToProject(host, project, String(input.id), { overwrite: !!input.overwrite, as: input.as }, signal); return `Copied library asset ${input.id} into ${r.dir} (${r.files} files, hashes verified).`; }
    if (a === 'verify') {
      const all = (await projectAssets(host, project, signal)).filter((x) => !input.id || x.id === input.id);
      const out = [];
      for (const x of all) {
        if (!x.manifest) { out.push(`${x.id}: ${x.error}`); continue; }
        const v = await verifyAsset((p) => readIn(host, `${x.dir}/${p}`, signal), x.manifest);
        const p = manifestProblems(x.manifest, x.id);
        out.push(`${x.id}: ${v.ok && !p.length ? 'ok' : [...p, ...(v.missing.length ? [`missing ${v.missing.join(', ')}`] : []), ...(v.changed.length ? [`changed ${v.changed.join(', ')}`] : [])].join('; ')}`);
      }
      return out.join('\n') || 'No assets.';
    }
    if (a === 'rehash') {
      if (!input.id) throw new Error('rehash needs id');
      const dir = `${assetsDir(project)}/${input.id}`;
      const m = JSON.parse((await readIn(host, `${dir}/asset.json`, signal)).toString('utf8'));
      for (const f of m.files) m.hashes[f.path] = sha256(await readIn(host, `${dir}/${f.path}`, signal));
      m.updated = new Date().toISOString();
      await writeIn(host, `${dir}/asset.json`, `${JSON.stringify(m, null, 2)}\n`, signal);
      return `Rehashed ${m.files.length} file(s) of ${input.id}.`;
    }
    return unknownAction('studio_library', a, ACTIONS);
  }),
};
