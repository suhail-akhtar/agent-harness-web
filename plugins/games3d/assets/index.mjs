// Studio assets: registered by ../index.mjs. The asset studio's tools and gates:
//   studio_image    raster work on PNGs: process, draw, fonts, normal maps, palettes
//   studio_sprite   pixel-art sprites, animated sheets, tilesets and autotiles, UI kits, parallax, iso, particles
//   studio_procgen  noise, heightmaps, dungeons, caves, mazes, platformers (solved), maps, WFC, L-systems, names
//   studio_audio    sfxr-style sound effects, music loops, loudness normalization
//   studio_model    Blender generators: props, kits, buildings, terrain, trees, a rigged character, vehicles, materials
//   studio_library  the project's assets and the shared library (~/.harness/assets)
//   studio_source   optional CC0 libraries and paid generators, off unless the operator turns them on
// and the gates asset-manifest, asset-budget, asset-3d, asset-2d, audio-valid, level-playable.

import { defineTool } from '../../../src/plugins/api.ts';
import { registerGates } from './gates.mjs';
import { imageTool, spriteTool } from './tools-2d.mjs';
import { audioTool } from './tools-audio.mjs';
import { libraryTool } from './tools-library.mjs';
import { modelTool } from './tools-model.mjs';
import { procgenTool } from './tools-procgen.mjs';
import { sourceTool } from './tools-sources.mjs';

export function setupAssets(api) {
  for (const t of [imageTool, spriteTool, procgenTool, audioTool, modelTool, libraryTool, sourceTool(api)]) api.registerTool(defineTool(t));
  registerGates(api);
}
