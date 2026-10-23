// Export presets the godot tool writes: Windows desktop, the Web and Linux. Godot fills in
// every option left out with its default, so a preset stays short. include_filter keeps
// the asset.json files (Studio's asset layout) in the export: they are not resources.

import { presetsIn } from '../../games3d/lib-engines.mjs';

export const PRESETS = {
  windows: { name: 'Windows Desktop', platform: 'Windows Desktop', output: 'build/windows/game.exe', options: ['binary_format/embed_pck=false', 'binary_format/architecture="x86_64"', 'codesign/enable=false', 'application/modify_resources=false'] },
  web: { name: 'Web', platform: 'Web', output: 'build/web/index.html', options: ['variant/extensions_support=false', 'variant/thread_support=false', 'vram_texture_compression/for_desktop=true', 'vram_texture_compression/for_mobile=false'] },
  linux: { name: 'Linux', platform: 'Linux', output: 'build/linux/game.x86_64', options: ['binary_format/embed_pck=false', 'binary_format/architecture="x86_64"'] },
};

/** The preset kind for this server's own desktop platform. */
export const hostPreset = (platform = process.platform) => (platform === 'win32' ? 'windows' : 'linux');

const cfgString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** One preset section. exportPath is relative to the project folder. */
export function presetSection(kind, index, name, exportPath, include = 'assets/*.json') {
  const k = PRESETS[kind];
  if (!k) throw new Error(`unknown preset kind ${kind} (windows, web or linux)`);
  return [
    `[preset.${index}]`, '',
    `name=${cfgString(name)}`, `platform=${cfgString(k.platform)}`, 'runnable=true', 'dedicated_server=false', 'custom_features=""',
    'export_filter="all_resources"', `include_filter=${cfgString(include)}`, 'exclude_filter=""', `export_path=${cfgString(exportPath)}`, '',
    `[preset.${index}.options]`, '', ...k.options, '',
  ].join('\n');
}

/** export_presets.cfg with a preset added (a new file when there is none). */
export function addPreset(cfg, kind, name, exportPath, include) {
  const next = Math.max(-1, ...presetsIn(cfg).map((p) => p.index)) + 1;
  const head = cfg && cfg.trim() ? `${cfg.replace(/\s*$/, '')}\n\n` : '';
  return head + presetSection(kind, next, name, exportPath, include);
}

/** A whole export_presets.cfg with these kinds, each exporting to ../build/<kind>/ beside the project. */
export function presetsFile(kinds = ['windows', 'web', 'linux']) {
  return kinds.reduce((cfg, k) => addPreset(cfg, k, PRESETS[k].name, `../${PRESETS[k].output}`), '');
}
