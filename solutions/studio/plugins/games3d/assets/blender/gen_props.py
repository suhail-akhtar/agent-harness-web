# Props: barrel, crate, chest, coin, gem, lamp, table, chair, fence, rock, bush, grass card.
# Each takes params (sizes in metres, colours as hex) and a seed, and returns the objects
# it made (meshes at identity transforms, the asset's base at z = 0).

import math
import random

import bmesh
import bpy
from mathutils import Matrix, Vector

from util import auto_smooth, box, cylinder, displace_verts, ico, join, material, mesh_object, uv_sphere


def P(params, key, default):
    v = params.get(key, default)
    return default if v is None else v


def barrel(params, seed):
    h, r = P(params, 'height', 0.9), P(params, 'radius', 0.3)
    bulge, staves = P(params, 'bulge', 0.12), int(P(params, 'staves', 16))
    wood = material('wood', P(params, 'wood', '#8a5a32'), 0.75, noise=0.35, noise_scale=12)
    metal = material('iron', P(params, 'metal', '#5a5e66'), 0.45, 0.9)
    rings = 12
    bm = bmesh.new()
    prof = []
    for i in range(rings + 1):
        t = i / rings
        z = t * h
        rr = r * (1 + bulge * math.sin(math.pi * t))
        prof.append((z, rr))
    vs = []
    for z, rr in prof:
        row = []
        for k in range(staves * 2):
            a = 2 * math.pi * k / (staves * 2)
            # Staves: every other vertex a little in, so the planks read in the silhouette and the shading.
            g = rr * (0.965 if k % 2 else 1.0)
            row.append(bm.verts.new((math.cos(a) * g, math.sin(a) * g, z)))
        vs.append(row)
    n = staves * 2
    for i in range(rings):
        for k in range(n):
            bm.faces.new((vs[i][k], vs[i][(k + 1) % n], vs[i + 1][(k + 1) % n], vs[i + 1][k]))
    for row, inset in ((vs[0], 0.0), (vs[-1], 0.0)):
        bm.faces.new(row if row is vs[-1] else list(reversed(row)))
    bm.normal_update()
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    body = mesh_object('barrel', bm, wood)
    # Sharp along the grooves between staves, smooth across each stave.
    auto_smooth(body, 8)
    parts = [body]
    # Hoops at a quarter and three quarters of the height, and at the rims.
    for t in (0.04, 0.27, 0.73, 0.96):
        z = t * h
        rr = r * (1 + bulge * math.sin(math.pi * t)) + 0.008
        parts.append(cylinder('hoop', rr, 0.035, (0, 0, z - 0.0175), metal, verts=32))
    # The lid, set a little into the top.
    lid = cylinder('lid', r * 0.93, 0.02, (0, 0, h - 0.03), material('lid', P(params, 'wood', '#8a5a32'), 0.8, noise=0.45, noise_scale=20), verts=32)
    parts.append(lid)
    return parts


def crate(params, seed):
    s = P(params, 'size', 0.8)
    wood = material('wood', P(params, 'wood', '#a8743e'), 0.8, noise=0.3, noise_scale=10)
    dark = material('frame', P(params, 'frame', '#6a4426'), 0.85, noise=0.3, noise_scale=10)
    parts = [box('core', (s * 0.94, s * 0.94, s * 0.94), (0, 0, s * 0.03), wood)]
    b = s * 0.12
    # Edge beams: four verticals, eight horizontals.
    for x in (-1, 1):
        for y in (-1, 1):
            parts.append(box('post', (b, b, s), (x * (s - b) / 2, y * (s - b) / 2, 0), dark, bevel=0.006))
    for z in (0, s - b):
        for y in (-1, 1):
            parts.append(box('rail', (s, b, b), (0, y * (s - b) / 2, z), dark, bevel=0.006))
        for x in (-1, 1):
            parts.append(box('rail', (b, s, b), (x * (s - b) / 2, 0, z), dark, bevel=0.006))
    # A diagonal brace on the front and back faces.
    for y in (-1, 1):
        d = box('brace', (s * 1.18, b * 0.8, b * 0.8), (0, 0, 0), dark, bevel=0.005)
        d.data.transform(Matrix.Translation((0, 0, -b * 0.4)))
        d.data.transform(Matrix.Rotation(math.radians(45 if y > 0 else -45), 4, 'Y'))
        d.data.transform(Matrix.Translation((0, y * (s / 2 - b * 0.35), s / 2)))
        parts.append(d)
    return parts


def chest(params, seed):
    w, d, h = P(params, 'width', 0.9), P(params, 'depth', 0.55), P(params, 'height', 0.5)
    wood = material('wood', P(params, 'wood', '#8a5530'), 0.7, noise=0.35, noise_scale=10)
    band = material('band', P(params, 'band', '#d8a838'), 0.35, 1.0)
    parts = [box('base', (w, d, h * 0.62), (0, 0, 0), wood, bevel=0.01)]
    lid = cylinder('lid', d / 2, w, (0, 0, h * 0.62), wood, verts=16, axis='X')
    # Keep only the upper half of the lid's cylinder.
    bm = bmesh.new()
    bm.from_mesh(lid.data)
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=(0, 0, h * 0.62), plane_no=(0, 0, -1), clear_outer=True)
    bmesh.ops.contextual_create(bm, geom=[e for e in bm.edges if e.is_boundary])
    bm.to_mesh(lid.data)
    bm.free()
    lid.data.transform(Matrix.Scale(0.75, 4, (0, 0, 1)))
    lid.data.transform(Matrix.Translation((0, 0, h * 0.62 * 0.25)))
    parts.append(lid)
    for x in (-0.32, 0.32):
        parts.append(box('band', (0.05, d + 0.01, h * 0.62 + 0.005), (x * w, 0, 0), band))
        b2 = cylinder('lidband', d / 2 * 1.02, 0.05, (x * w - 0.025, 0, h * 0.62), band, verts=16, axis='X')
        bm = bmesh.new(); bm.from_mesh(b2.data)
        bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=(0, 0, h * 0.62), plane_no=(0, 0, -1), clear_outer=True)
        bm.to_mesh(b2.data); bm.free()
        b2.data.transform(Matrix.Translation((0, 0, -h * 0.62))); b2.data.transform(Matrix.Scale(0.76, 4, (0, 0, 1))); b2.data.transform(Matrix.Translation((0, 0, h * 0.62)))
        parts.append(b2)
    parts.append(box('lock', (0.1, 0.03, 0.12), (0, -d / 2 - 0.012, h * 0.62 - 0.08), band, bevel=0.008))
    return parts


def coin(params, seed):
    r, t = P(params, 'radius', 0.12), P(params, 'thickness', 0.02)
    gold = material('gold', P(params, 'color', '#f2c042'), 0.25, 1.0)
    c = cylinder('coin', r, t, (0, 0, 0), gold, verts=32, axis='Y')
    bm = bmesh.new(); bm.from_mesh(c.data)
    bmesh.ops.bevel(bm, geom=[e for e in bm.edges if len(e.link_faces) == 2 and e.calc_face_angle(0) > 1.0], offset=t * 0.25, segments=2, affect='EDGES')
    # The face: an inset rim on both sides.
    caps = [f for f in bm.faces if abs(f.normal.y) > 0.99 and len(f.verts) > 8]
    r1 = bmesh.ops.inset_region(bm, faces=caps, thickness=r * 0.14, depth=0, use_even_offset=True)
    bmesh.ops.inset_region(bm, faces=caps, thickness=0.004, depth=-t * 0.15, use_even_offset=True)
    bm.to_mesh(c.data); bm.free()
    auto_smooth(c, 35)
    c.data.transform(Matrix.Translation((0, 0, r)))
    return [c]


def gem(params, seed):
    r = P(params, 'radius', 0.15)
    mat = material('gem', P(params, 'color', '#3ab0e8'), 0.05, 0.0, transmission=0.6)
    n = int(P(params, 'facets', 8))
    bm = bmesh.new()
    crown_h, pav_h, table = r * 0.45, r * 1.0, 0.55
    girdle = [bm.verts.new((math.cos(2 * math.pi * i / n) * r, math.sin(2 * math.pi * i / n) * r, pav_h)) for i in range(n)]
    top = [bm.verts.new((math.cos(2 * math.pi * (i + 0.5) / n) * r * table, math.sin(2 * math.pi * (i + 0.5) / n) * r * table, pav_h + crown_h)) for i in range(n)]
    tip = bm.verts.new((0, 0, 0))
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((girdle[i], girdle[j], top[i]))
        bm.faces.new((girdle[j], top[j], top[i]))
        bm.faces.new((girdle[j], girdle[i], tip))
    bm.faces.new(top)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return [mesh_object('gem', bm, mat, smooth=False)]


def lamp(params, seed):
    h = P(params, 'height', 2.2)
    iron = material('iron', P(params, 'metal', '#2a2a30'), 0.5, 0.8)
    glow = material('glass', '#ffe8a0', 0.2, emission=P(params, 'light', '#ffd070'), emission_strength=6.0)
    parts = [cylinder('base', 0.16, 0.12, (0, 0, 0), iron, verts=12, radius_top=0.11),
             cylinder('post', 0.04, h - 0.45, (0, 0, 0.12), iron, verts=10),
             box('glass', (0.2, 0.2, 0.26), (0, 0, h - 0.33), glow),
             cylinder('cap', 0.19, 0.12, (0, 0, h - 0.07), iron, verts=4, radius_top=0.02, smooth=False)]
    for x in (-1, 1):
        for y in (-1, 1):
            parts.append(box('frame', (0.025, 0.025, 0.28), (x * 0.1, y * 0.1, h - 0.34), iron))
    parts.append(box('bottom', (0.24, 0.24, 0.03), (0, 0, h - 0.36), iron))
    parts[-2 - 4].data.transform(Matrix.Rotation(math.radians(45), 4, 'Z'))
    return parts


def table(params, seed):
    w, d, h = P(params, 'width', 1.4), P(params, 'depth', 0.8), P(params, 'height', 0.76)
    wood = material('wood', P(params, 'wood', '#9a6a3c'), 0.6, noise=0.3, noise_scale=8)
    parts = [box('top', (w, d, 0.05), (0, 0, h - 0.05), wood, bevel=0.01)]
    for x in (-1, 1):
        for y in (-1, 1):
            parts.append(box('leg', (0.06, 0.06, h - 0.05), (x * (w / 2 - 0.08), y * (d / 2 - 0.08), 0), wood, bevel=0.004))
    for y in (-1, 1):
        parts.append(box('apron', (w - 0.16, 0.025, 0.08), (0, y * (d / 2 - 0.08), h - 0.13), wood))
    return parts


def chair(params, seed):
    s, h = P(params, 'seat', 0.45), P(params, 'height', 0.95)
    wood = material('wood', P(params, 'wood', '#8a5a32'), 0.6, noise=0.3, noise_scale=8)
    sh = 0.46
    parts = [box('seat', (s, s, 0.04), (0, 0, sh - 0.04), wood, bevel=0.006)]
    for x in (-1, 1):
        for y in (-1, 1):
            top = h if y > 0 else sh - 0.04
            parts.append(box('leg', (0.04, 0.04, top), (x * (s / 2 - 0.03), y * (s / 2 - 0.03), 0), wood, bevel=0.003))
    for i in range(3):
        parts.append(box('slat', (s - 0.06, 0.02, 0.05), (0, s / 2 - 0.03, sh + 0.12 + i * 0.13), wood))
    return parts


def fence(params, seed):
    length, h = P(params, 'length', 2.0), P(params, 'height', 1.0)
    posts = max(2, int(P(params, 'posts', 3)))
    wood = material('wood', P(params, 'wood', '#9a7048'), 0.8, noise=0.35, noise_scale=10)
    rnd = random.Random(seed)
    parts = []
    for i in range(posts):
        x = -length / 2 + length * i / (posts - 1)
        ph = h * (1 + rnd.uniform(-0.04, 0.04))
        p = box('post', (0.09, 0.09, ph), (x, 0, 0), wood, bevel=0.006)
        # A pointed top.
        tip = cylinder('tip', 0.064, 0.08, (x, 0, ph), wood, verts=4, radius_top=0.0, smooth=False)
        tip.data.transform(Matrix.Translation((-x, 0, 0))); tip.data.transform(Matrix.Rotation(math.radians(45), 4, 'Z')); tip.data.transform(Matrix.Translation((x, 0, 0)))
        parts += [p, tip]
    for z in (h * 0.3, h * 0.72):
        parts.append(box('rail', (length + 0.06, 0.04, 0.09), (0, -0.065, z), wood, bevel=0.004))
    return parts


def rock(params, seed):
    s = P(params, 'size', 0.8)
    rnd = random.Random(seed)
    mat = material('stone', P(params, 'color', '#8a8a90'), 0.9, noise=0.4, noise_scale=5)
    o = ico('rock', s / 2, (0, 0, 0), mat, subdiv=3)
    o.data.transform(Matrix.Diagonal((rnd.uniform(0.9, 1.3), rnd.uniform(0.75, 1.1), rnd.uniform(0.55, 0.85), 1)))
    displace_verts(o, s * 0.09, seed, scale=2.2 / s)
    displace_verts(o, s * 0.03, seed + 1, scale=6 / s)
    # Flatten the bottom so it sits on the ground.
    for v in o.data.vertices:
        if v.co.z < -s * 0.18:
            v.co.z = -s * 0.18 + (v.co.z + s * 0.18) * 0.15
    o.data.update()
    auto_smooth(o, 32)
    return [o]


def bush(params, seed):
    s = P(params, 'size', 0.9)
    rnd = random.Random(seed)
    mat = material('leaf', P(params, 'color', '#4f9d3a'), 0.85, noise=0.4, noise_scale=8)
    parts = []
    for i in range(int(P(params, 'clumps', 6))):
        r = s * rnd.uniform(0.22, 0.34)
        a = rnd.uniform(0, 2 * math.pi)
        d = rnd.uniform(0, s * 0.25)
        o = ico('clump', r, (math.cos(a) * d, math.sin(a) * d, r * 0.75 + rnd.uniform(0, s * 0.15)), mat, subdiv=2)
        displace_verts(o, r * 0.18, seed + i, scale=3 / r)
        parts.append(o)
    return parts


def grass_card(params, seed):
    """Crossed quads with a grass texture whose alpha cuts the blades (the texture is in params.texture)."""
    h, w = P(params, 'height', 0.5), P(params, 'width', 0.6)
    m = bpy.data.materials.new('grass')
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes.get('Principled BSDF')
    tex_path = params.get('texture')
    if tex_path:
        img = bpy.data.images.load(tex_path)
        tex = nt.nodes.new('ShaderNodeTexImage')
        tex.image = img
        nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
        nt.links.new(tex.outputs['Alpha'], bsdf.inputs['Alpha'])
        m.blend_method = 'CLIP' if hasattr(m, 'blend_method') else m.blend_method
    else:
        from util import hex_rgba
        bsdf.inputs['Base Color'].default_value = hex_rgba('#5fae4a')
    bsdf.inputs['Roughness'].default_value = 0.8
    parts = []
    for k in range(int(P(params, 'cards', 3))):
        bm = bmesh.new()
        a = math.pi * k / int(P(params, 'cards', 3))
        dx, dy = math.cos(a) * w / 2, math.sin(a) * w / 2
        v = [bm.verts.new(p) for p in ((-dx, -dy, 0), (dx, dy, 0), (dx, dy, h), (-dx, -dy, h))]
        f = bm.faces.new(v)
        uv = bm.loops.layers.uv.new('UVMap')
        for loop, co in zip(f.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
            loop[uv].uv = co
        parts.append(mesh_object('card', bm, m))
    return parts


GENERATORS = {
    'barrel': barrel, 'crate': crate, 'chest': chest, 'coin': coin, 'gem': gem, 'lamp': lamp, 'table': table,
    'chair': chair, 'fence': fence, 'rock': rock, 'bush': bush, 'grass': grass_card,
}
