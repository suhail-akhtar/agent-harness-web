# PBR materials from procedural node trees (wood, stone, brick, metal, tiles, fabric, grass,
# sand), baked with Cycles to base colour, roughness and normal images on a plane, then
# put back on a preview sphere as an image-textured material that exports to glTF.

import os

import bmesh
import bpy

from util import hex_rgba, link, mesh_object, select_only, uv_sphere


def _tree(kind, colors, scale):
    m = bpy.data.materials.new(f'{kind}_procedural')
    m.use_nodes = True
    nt = m.node_tree
    N, L = nt.nodes, nt.links
    bsdf = N['Principled BSDF']
    coord = N.new('ShaderNodeTexCoord')
    mapping = N.new('ShaderNodeMapping')
    mapping.inputs['Scale'].default_value = (scale, scale, scale)
    L.new(coord.outputs['UV'], mapping.inputs['Vector'])
    vec = mapping.outputs['Vector']
    ramp = N.new('ShaderNodeValToRGB')
    a, b = hex_rgba(colors[0]), hex_rgba(colors[1])
    ramp.color_ramp.elements[0].color = a
    ramp.color_ramp.elements[1].color = b
    bump = N.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = 0.4
    rough = 0.6
    metallic = 0.0
    if kind == 'wood':
        noise = N.new('ShaderNodeTexNoise'); noise.inputs['Scale'].default_value = 3; noise.inputs['Detail'].default_value = 6
        wave = N.new('ShaderNodeTexWave'); wave.inputs['Scale'].default_value = 4; wave.inputs['Distortion'].default_value = 6; wave.inputs['Detail'].default_value = 4
        L.new(vec, noise.inputs['Vector']); L.new(vec, wave.inputs['Vector'])
        L.new(wave.outputs['Fac'], ramp.inputs['Fac']); L.new(wave.outputs['Fac'], bump.inputs['Height'])
        rough = 0.65
    elif kind in ('stone', 'grass', 'sand', 'dirt'):
        vor = N.new('ShaderNodeTexVoronoi'); vor.inputs['Scale'].default_value = 5 if kind == 'stone' else 30
        noise = N.new('ShaderNodeTexNoise'); noise.inputs['Scale'].default_value = 8; noise.inputs['Detail'].default_value = 8
        mix = N.new('ShaderNodeMath'); mix.operation = 'MULTIPLY'
        L.new(vec, vor.inputs['Vector']); L.new(vec, noise.inputs['Vector'])
        L.new(vor.outputs['Distance'], mix.inputs[0]); L.new(noise.outputs['Fac'], mix.inputs[1])
        L.new(mix.outputs['Value'], ramp.inputs['Fac']); L.new(mix.outputs['Value'], bump.inputs['Height'])
        rough = 0.9
    elif kind in ('brick', 'tiles'):
        br = N.new('ShaderNodeTexBrick')
        br.inputs['Color1'].default_value = a; br.inputs['Color2'].default_value = b
        br.inputs['Mortar'].default_value = hex_rgba(colors[2] if len(colors) > 2 else '#c8c0b0')
        br.inputs['Scale'].default_value = 4 if kind == 'brick' else 3
        if kind == 'tiles':
            br.offset = 0.0
            br.inputs['Brick Width'].default_value = 0.5; br.inputs['Row Height'].default_value = 0.5
        L.new(vec, br.inputs['Vector'])
        L.new(br.outputs['Color'], bsdf.inputs['Base Color'])
        L.new(br.outputs['Fac'], bump.inputs['Height'])
        bump.invert = True
        rough = 0.8 if kind == 'brick' else 0.3
        ramp = None
    elif kind == 'metal':
        noise = N.new('ShaderNodeTexNoise'); noise.inputs['Scale'].default_value = 40; noise.inputs['Detail'].default_value = 10
        L.new(vec, noise.inputs['Vector']); L.new(noise.outputs['Fac'], ramp.inputs['Fac'])
        L.new(noise.outputs['Fac'], bump.inputs['Height'])
        bump.inputs['Strength'].default_value = 0.1
        rough, metallic = 0.35, 1.0
    elif kind == 'fabric':
        w1 = N.new('ShaderNodeTexWave'); w1.inputs['Scale'].default_value = 60
        w2 = N.new('ShaderNodeTexWave'); w2.inputs['Scale'].default_value = 60; w2.bands_direction = 'Y'
        mx = N.new('ShaderNodeMath'); mx.operation = 'MAXIMUM'
        L.new(vec, w1.inputs['Vector']); L.new(vec, w2.inputs['Vector'])
        L.new(w1.outputs['Fac'], mx.inputs[0]); L.new(w2.outputs['Fac'], mx.inputs[1])
        L.new(mx.outputs['Value'], ramp.inputs['Fac']); L.new(mx.outputs['Value'], bump.inputs['Height'])
        rough = 0.95
    if ramp is not None:
        L.new(ramp.outputs['Color'], bsdf.inputs['Base Color'])
    L.new(bump.outputs['Normal'], bsdf.inputs['Normal'])
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metallic
    return m, rough, metallic


PRESETS = {
    'wood': ['#5a3a20', '#a8743e'], 'stone': ['#4a4a50', '#9a9aa0'], 'brick': ['#8a3a2a', '#b05a3e', '#c8c0b0'],
    'metal': ['#6a6e76', '#b8bcc4'], 'tiles': ['#d8d8d0', '#b8c0c8', '#606068'], 'fabric': ['#5a2a3a', '#a84a5a'],
    'grass': ['#2f5a1f', '#6aa83a'], 'sand': ['#b8a070', '#e8d8a8'], 'dirt': ['#3a2818', '#7a5a3a'],
}


def bake(params, seed, out_dir, name):
    """Bakes a preset (or colours) to images; returns (objects for export, files written, info)."""
    kind = params.get('preset', 'wood')
    colors = params.get('colors') or PRESETS.get(kind, PRESETS['wood'])
    size = int(params.get('size', 512))
    scale = float(params.get('scale', 2.0))
    m, rough, metallic = _tree(kind, colors, scale)
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=0.5, calc_uvs=False)
    uv = bm.loops.layers.uv.new('UVMap')
    for f in bm.faces:
        for loop in f.loops:
            loop[uv].uv = (loop.vert.co.x + 0.5, loop.vert.co.y + 0.5)
    plane = mesh_object('bake_plane', bm, m)
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 4
    scene.render.bake.margin = 4
    nt = m.node_tree
    files = {}
    passes = [('basecolor', 'DIFFUSE', {'COLOR'}, 'sRGB'), ('roughness', 'ROUGHNESS', set(), 'Non-Color'), ('normal', 'NORMAL', set(), 'Non-Color')]
    for label, kind_b, filt, space in passes:
        img = bpy.data.images.new(f'{name}_{label}', size, size, alpha=False, float_buffer=False)
        img.colorspace_settings.name = space
        node = nt.nodes.new('ShaderNodeTexImage')
        node.image = img
        nt.nodes.active = node
        select_only([plane])
        if filt:
            bpy.ops.object.bake(type=kind_b, pass_filter=filt, margin=4)
        else:
            bpy.ops.object.bake(type=kind_b, margin=4)
        path = os.path.join(out_dir, f'{label}.png')
        img.filepath_raw = path
        img.file_format = 'PNG'
        img.save()
        files[label] = path
        nt.nodes.remove(node)
    bpy.data.objects.remove(plane)
    # The exported material: the baked images on a sphere.
    em = bpy.data.materials.new(name)
    em.use_nodes = True
    N, L = em.node_tree.nodes, em.node_tree.links
    bsdf = N['Principled BSDF']
    def tex(label, space):
        t = N.new('ShaderNodeTexImage')
        t.image = bpy.data.images.load(files[label])
        t.image.colorspace_settings.name = space
        return t
    L.new(tex('basecolor', 'sRGB').outputs['Color'], bsdf.inputs['Base Color'])
    L.new(tex('roughness', 'Non-Color').outputs['Color'], bsdf.inputs['Roughness'])
    nm = N.new('ShaderNodeNormalMap')
    L.new(tex('normal', 'Non-Color').outputs['Color'], nm.inputs['Color'])
    L.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    bsdf.inputs['Metallic'].default_value = metallic
    sphere = uv_sphere(name, 0.5, (0, 0, 0.5), em, segments=32, rings=16)
    return [sphere], files, {'preset': kind, 'colors': colors, 'roughness': rough, 'metallic': metallic, 'size': size}
