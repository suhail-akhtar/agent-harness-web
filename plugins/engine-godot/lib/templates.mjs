// The godot tool's project templates: a minimal runnable Godot 4 project for a 2D, a 2.5D and
// a 3D game. Each has an input map, a main scene built in code, the StudioHook autoload
// (state, events and the --selftest hook), tests for the test action, export presets for
// Windows, the Web and Linux, and (2D, 2.5D) a sprite sheet and tiles in Studio's asset layout.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { heroSheet, tilesSheet } from './png.mjs';
import { presetsFile } from './presets.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_DIR = path.resolve(here, '..');

export const TEMPLATES = {
  '2d': { root: 'Node2D', what: 'a top-down 2D level on a TileMapLayer, a player animated from a sprite sheet (AnimatedSprite2D), coins, a score', checks: ['moves', 'animates', 'walls', 'collects'] },
  '2.5d': { root: 'Node3D', what: 'an isometric level (orthographic camera) with a billboard sprite hero (AnimatedSprite3D), blocks, coins, a score', checks: ['isometric', 'moves', 'animates', 'collects'] },
  '3d': { root: 'Node3D', what: 'a third-person collect-and-escape level: sky, sun, floor, a capsule player that runs and jumps, coins, an exit', checks: ['moves', 'jumps', 'lands', 'collects', 'exit'] },
};
export const TEMPLATE_ALIASES = { '2': '2d', '2.5': '2.5d', '25d': '2.5d', iso: '2.5d', isometric: '2.5d', '3': '3d' };

// Physical key codes, as Godot writes them in project.godot.
const KEYS = { A: 65, D: 68, W: 87, S: 83, E: 69, Space: 32, Enter: 4194309, Left: 4194319, Up: 4194320, Right: 4194321, Down: 4194322 };
const INPUT = { move_left: ['A', 'Left'], move_right: ['D', 'Right'], move_up: ['W', 'Up'], move_down: ['S', 'Down'], jump: ['Space'], action: ['E', 'Enter'] };

const keyEvent = (code) => `Object(InputEventKey,"resource_local_to_scene":false,"resource_name":"","device":-1,"window_id":0,"alt_pressed":false,"shift_pressed":false,"ctrl_pressed":false,"meta_pressed":false,"pressed":false,"keycode":0,"physical_keycode":${code},"key_label":0,"unicode":0,"location":0,"echo":false,"script":null)`;

/** The [input] section: each action with its keys. */
export function inputSection(map = INPUT) {
  const lines = ['[input]', ''];
  for (const [action, keys] of Object.entries(map)) {
    lines.push(`${action}={`, '"deadzone": 0.2,', `"events": [${keys.map((k) => keyEvent(KEYS[k])).join(', ')}]`, '}');
  }
  return lines.join('\n');
}

const quoteCfg = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function projectGodot(template, name) {
  const two = template === '2d';
  return [
    '; Engine configuration file (Godot 4). Made by the godot tool\'s project.create',
    `; (${template} template, engine-godot). Keep config_version=5.`,
    '',
    'config_version=5',
    '',
    '[application]',
    '',
    `config/name=${quoteCfg(name)}`,
    'run/main_scene="res://scenes/main.tscn"',
    '',
    '[autoload]',
    '',
    'StudioHook="*res://harness/studio_hook.gd"',
    '',
    '[display]',
    '',
    ...(two
      ? ['window/size/viewport_width=640', 'window/size/viewport_height=360', 'window/size/window_width_override=1280', 'window/size/window_height_override=720', 'window/stretch/mode="canvas_items"']
      : ['window/size/viewport_width=1280', 'window/size/viewport_height=720']),
    '',
    inputSection(),
    '',
    '[rendering]',
    '',
    'renderer/rendering_method="gl_compatibility"',
    'renderer/rendering_method.mobile="gl_compatibility"',
    ...(two ? ['textures/canvas_textures/default_texture_filter=0'] : []),
    '',
  ].join('\n');
}

const mainScene = (root) => `[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://scripts/main.gd" id="1"]\n\n[node name="Main" type="${root}"]\nscript = ExtResource("1")\n`;

/** An asset.json in Studio's layout (plugins/games3d/sdk/FORMATS.md). */
export function assetJson(o) {
  const now = new Date().toISOString();
  return `${JSON.stringify({
    id: o.id, name: o.name, kind: o.kind, dimension: '2d',
    files: [{ path: o.file, role: 'main' }],
    source: { type: 'procedural', generator: 'engine-godot:template', params: {} },
    license: { id: 'CC0-1.0', author: 'harness template' },
    tags: o.tags ?? [], style: 'pixel-art', meta: o.meta,
    engines: { godot: { path: `res://assets/${o.id}/${o.file}`, importedAt: now } },
    created: now, updated: now,
  }, null, 1)}\n`;
}

/** Every file of a template: project-relative path -> contents. */
export async function templateFiles(template, name) {
  const t = TEMPLATES[template];
  if (!t) throw new Error(`unknown template ${template} (2d, 2.5d or 3d)`);
  const read = (rel) => fs.readFile(path.join(PLUGIN_DIR, rel));
  const files = new Map([
    ['project.godot', projectGodot(template, name)],
    ['scenes/main.tscn', mainScene(t.root)],
    ['scripts/main.gd', await read(`templates/${template}/scripts/main.gd`)],
    ['tests/test_game.gd', await read(`templates/${template}/tests/test_game.gd`)],
    ['harness/studio_hook.gd', await read('gd/studio_hook.gd')],
    ['harness/sprite_sheet.gd', await read('gd/sprite_sheet.gd')],
    ['addons/harness_test/test_case.gd', await read('gd/test_case.gd')],
    ['export_presets.cfg', presetsFile()],
    ['.gitignore', '.godot/\n/build/\n'],
  ]);
  if (template !== '3d') {
    const hero = heroSheet(4, 32);
    files.set('assets/hero/hero.png', hero.png);
    files.set('assets/hero/asset.json', assetJson({
      id: 'hero', name: 'Hero (template)', kind: 'spritesheet', file: 'hero.png', tags: ['character', 'player'],
      meta: { frames: 4, frameSize: [32, 32], columns: 4, rows: 1, fps: 8, directions: 1, animations: { idle: { row: 0, from: 0, count: 1 }, walk: { row: 0, from: 0, count: 4, fps: 8, loop: true } } },
    }));
  }
  if (template === '2d') {
    const tiles = tilesSheet(16);
    files.set('assets/tiles/tiles.png', tiles.png);
    files.set('assets/tiles/asset.json', assetJson({
      id: 'tiles', name: 'Tiles (template)', kind: 'tileset', file: 'tiles.png', tags: ['tileset'],
      meta: { tile: 16, frameSize: [16, 16], columns: 3, rows: 1, names: ['grass', 'path', 'stone'], solid: ['stone'] },
    }));
  }
  return files;
}

/** .studio/project.json for a new Godot project (FORMATS.md), when the workspace has none. */
export function studioProject(name, template, engineProject) {
  return `${JSON.stringify({
    name, engine: 'godot', dimension: template, genre: '', created: new Date().toISOString(), engineProject, design: 'design/GDD.md',
    budgets: { fps: 60, frameMs: 16.7, memoryMb: 1024 }, stages: [], builds: [], playtests: [],
  }, null, 1)}\n`;
}
