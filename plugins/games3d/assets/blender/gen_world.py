# World pieces: L-system trees, modular level kits on a grid, buildings, terrain from a
# heightmap, and simple vehicles.

import math
import random

import bmesh
import bpy
from mathutils import Matrix, Vector

from util import auto_smooth, box, cylinder, displace_verts, hex_rgba, ico, material, mesh_object


def P(params, key, default):
    v = params.get(key, default)
    return default if v is None else v


def tree(params, seed):
    """Branches from 3D turtle segments (params.segments, made by the L-system in JS) as tapered tubes, leaves as clumps."""
    segs = params.get('segments') or []
    leaves = params.get('leaves') or []
    scale = P(params, 'scale', 1.0)
    bark = material('bark', P(params, 'bark', '#6a4a30'), 0.9, noise=0.35, noise_scale=20)
    leaf = material('leaf', P(params, 'leaf', '#4f9d3a'), 0.8, noise=0.35, noise_scale=6)
    bm = bmesh.new()
    sides = int(P(params, 'sides', 6))
    for s in segs:
        a, b = Vector(s['a']) * scale, Vector(s['b']) * scale
        d = b - a
        if d.length < 1e-5:
            continue
        r0, r1 = max(0.004, s['r0'] * scale), max(0.003, s['r1'] * scale)
        q = d.to_track_quat('Z', 'Y')
        ring0, ring1 = [], []
        for k in range(sides):
            ang = 2 * math.pi * k / sides
            off = Vector((math.cos(ang), math.sin(ang), 0))
            ring0.append(bm.verts.new(a + q @ (off * r0)))
            ring1.append(bm.verts.new(b + q @ (off * r1)))
        for k in range(sides):
            j = (k + 1) % sides
            bm.faces.new((ring0[k], ring0[j], ring1[j], ring1[k]))
    trunk = mesh_object('branches', bm, bark, smooth=True)
    parts = [trunk]
    rnd = random.Random(seed)
    # Leaves: a clump at each leaf point (merged into one mesh), sized by the tree.
    lbm = bmesh.new()
    size = P(params, 'leafSize', 0.35) * scale
    keep = leaves if len(leaves) <= 400 else rnd.sample(leaves, 400)
    for lf in keep:
        p = Vector(lf['p']) * scale
        r = size * (lf.get('size', 0.25) / 0.25)
        tmp = bmesh.new()
        bmesh.ops.create_icosphere(tmp, subdivisions=1, radius=r)
        for v in tmp.verts:
            v.co = v.co * Vector((1, 1, 0.8)) + p + Vector((rnd.uniform(-r, r) * 0.2, rnd.uniform(-r, r) * 0.2, 0))
        me = bpy.data.meshes.new('t')
        tmp.to_mesh(me)
        tmp.free()
        lbm.from_mesh(me)
        bpy.data.meshes.remove(me)
    if keep:
        parts.append(mesh_object('leaves', lbm, leaf, smooth=False))
    else:
        lbm.free()
    return parts


def kit(params, seed):
    """Modular pieces on a grid (default 2 m): each piece its own object, its origin on a grid corner."""
    g = P(params, 'grid', 2.0)
    hgt = P(params, 'wallHeight', 3.0)
    t = P(params, 'thickness', 0.2)
    stone = material('stone', P(params, 'wall', '#8a8890'), 0.85, noise=0.3, noise_scale=4)
    floor_m = material('floor', P(params, 'floor', '#6a6460'), 0.9, noise=0.35, noise_scale=3)
    wood = material('wood', P(params, 'wood', '#7a5232'), 0.7, noise=0.3, noise_scale=8)
    want = params.get('pieces') or ['floor', 'wall', 'corner', 'door', 'window', 'stairs', 'platform', 'pillar']
    out = []
    for name in want:
        if name == 'floor':
            o = box('floor', (g, g, 0.1), (0, 0, -0.1), floor_m, bevel=0.01)
        elif name == 'wall':
            o = box('wall', (g, t, hgt), (0, 0, 0), stone, bevel=0.01)
        elif name == 'corner':
            a = box('corner_a', (g / 2 + t / 2, t, hgt), (-g / 4 + t / 4, 0, 0), stone, bevel=0.01)
            b = box('corner_b', (t, g / 2 + t / 2, hgt), (0, -g / 4 + t / 4, 0), stone, bevel=0.01)
            from util import join
            o = join([a, b], 'corner')
        elif name in ('door', 'window'):
            bm = bmesh.new()
            ow, oh, oz = (g * 0.45, hgt * 0.7, 0) if name == 'door' else (g * 0.4, hgt * 0.35, hgt * 0.35)
            # Built from slabs around the opening (a hole without booleans: clean quads).
            slabs = [((-g / 2, (g - ow) / 2), (0, hgt)), (((g + ow) / 2 - g / 2, (g - ow) / 2), (0, hgt)), ((-ow / 2, ow), (oz + oh, hgt - oz - oh))]
            if oz > 0:
                slabs.append(((-ow / 2, ow), (0, oz)))
            from util import join
            pieces = []
            for (x0, w), (z0, hh) in slabs:
                if w > 0.001 and hh > 0.001:
                    pieces.append(box(f'{name}_slab', (w, t, hh), (x0 + w / 2, 0, z0), stone))
            if name == 'door':
                pieces.append(box('door_leaf', (ow * 0.96, t * 0.4, oh * 0.98), (0, t * 0.2, 0), wood, bevel=0.01))
            o = join(pieces, name)
        elif name == 'stairs':
            from util import join
            steps = int(P(params, 'steps', 6))
            rise = P(params, 'rise', 1.0) / steps
            o = join([box('step', (g, g / steps, rise * (i + 1)), (0, -g / 2 + g / steps * (i + 0.5), 0), stone, bevel=0.005) for i in range(steps)], 'stairs')
        elif name == 'platform':
            o = box('platform', (g, g, 0.3), (0, 0, P(params, 'platformHeight', 1.0) - 0.3), stone, bevel=0.02)
            from util import join
            legs = [box('leg', (0.2, 0.2, P(params, 'platformHeight', 1.0) - 0.3), (x * (g / 2 - 0.1), y * (g / 2 - 0.1), 0), stone) for x in (-1, 1) for y in (-1, 1)]
            o = join([o, *legs], 'platform')
        elif name == 'pillar':
            o = cylinder('pillar', 0.25, hgt, (0, 0, 0), stone, verts=12)
        else:
            continue
        o['studio_piece'] = name
        out.append(o)
    return out


def building(params, seed):
    w, d = P(params, 'width', 6.0), P(params, 'depth', 5.0)
    floors, fh = int(P(params, 'floors', 2)), P(params, 'floorHeight', 3.0)
    rnd = random.Random(seed)
    wall = material('wall', P(params, 'wall', '#d8c8a8'), 0.85, noise=0.2, noise_scale=3)
    roof = material('roof', P(params, 'roof', '#a8443a'), 0.7, noise=0.25, noise_scale=8)
    trim = material('trim', P(params, 'trim', '#5a3a2a'), 0.7)
    glass = material('window', '#7ab0d8', 0.1, 0.2, emission='#ffd890', emission_strength=0.4 if P(params, 'lit', False) else 0)
    h = floors * fh
    parts = [box('walls', (w, d, h), (0, 0, 0), wall)]
    parts.append(box('base', (w + 0.1, d + 0.1, 0.4), (0, 0, 0), trim))
    # Windows on every floor of the front and back; a door in the front.
    cols = max(1, int(w / 2))
    for f in range(floors):
        for c in range(cols):
            x = -w / 2 + (c + 0.5) * w / cols
            if f == 0 and c == cols // 2:
                parts.append(box('door', (0.9, 0.08, 2.0), (x, -d / 2 - 0.03, 0.4), trim, bevel=0.02))
                continue
            for side in (-1, 1):
                parts.append(box('window', (0.8, 0.06, 1.0), (x, side * (d / 2 + 0.02), f * fh + 1.0), glass))
                parts.append(box('sill', (0.95, 0.12, 0.08), (x, side * (d / 2 + 0.05), f * fh + 0.95), trim))
    # A gable roof along x.
    rh = P(params, 'roofHeight', d * 0.45)
    bm = bmesh.new()
    o = 0.25
    pts = [(-w / 2 - o, -d / 2 - o, h), (w / 2 + o, -d / 2 - o, h), (w / 2 + o, 0, h + rh), (-w / 2 - o, 0, h + rh), (-w / 2 - o, d / 2 + o, h), (w / 2 + o, d / 2 + o, h)]
    v = [bm.verts.new(p) for p in pts]
    bm.faces.new((v[0], v[1], v[2], v[3]))
    bm.faces.new((v[3], v[2], v[5], v[4]))
    bm.faces.new((v[0], v[3], v[4]))
    bm.faces.new((v[1], v[5], v[2]))
    bm.faces.new((v[0], v[4], v[5], v[1]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    parts.append(mesh_object('roof', bm, roof))
    # Gable walls under the roof ends.
    gbm = bmesh.new()
    for x in (-w / 2, w / 2):
        gv = [gbm.verts.new(p) for p in ((x, -d / 2, h), (x, d / 2, h), (x, 0, h + rh * 0.96))]
        gbm.faces.new(gv)
    bmesh.ops.recalc_face_normals(gbm, faces=gbm.faces)
    parts.append(mesh_object('gables', gbm, wall))
    if P(params, 'chimney', rnd.random() < 0.6):
        parts.append(box('chimney', (0.5, 0.5, rh + 0.8), (w * 0.25, d * 0.15, h), trim))
    return parts


def terrain(params, seed):
    """A grid displaced by a heightmap image (16-bit PNG), coloured by height and slope (vertex colours)."""
    path = params.get('heightmap')
    size = P(params, 'size', 64.0)
    height = P(params, 'heightM', 12.0)
    res = int(P(params, 'resolution', 128))
    heights = None
    if path:
        img = bpy.data.images.load(path)
        img.colorspace_settings.name = 'Non-Color'
        W, H = img.size
        px = list(img.pixels)
        def sample(u, v):
            x, y = u * (W - 1), (1 - v) * (H - 1)
            x0, y0 = int(x), int(y)
            x1, y1 = min(W - 1, x0 + 1), min(H - 1, y0 + 1)
            tx, ty = x - x0, y - y0
            g = lambda i, j: px[(j * W + i) * 4]
            # Blender stores rows bottom-up: flip v.
            jj = lambda j: H - 1 - j
            a = g(x0, jj(y0)) * (1 - tx) + g(x1, jj(y0)) * tx
            b = g(x0, jj(y1)) * (1 - tx) + g(x1, jj(y1)) * tx
            return a * (1 - ty) + b * ty
        heights = sample
    else:
        from mathutils import noise
        off = Vector((seed * 13.1, seed * 7.7, 0))
        heights = lambda u, v: max(0.0, min(1.0, 0.45 + 0.6 * noise.fractal(Vector((u * 2.2, v * 2.2, 0)) + off, 0.45, 2.0, 4)))
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.new('UVMap')
    col = bm.loops.layers.color.new('Col')
    verts = []
    for j in range(res + 1):
        row = []
        for i in range(res + 1):
            u, v = i / res, j / res
            row.append(bm.verts.new(((u - 0.5) * size, (v - 0.5) * size, heights(u, v) * height)))
        verts.append(row)
    for j in range(res):
        for i in range(res):
            f = bm.faces.new((verts[j][i], verts[j][i + 1], verts[j + 1][i + 1], verts[j + 1][i]))
            for loop, (a, b) in zip(f.loops, ((i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1))):
                loop[uvl].uv = (a / res, b / res)
    bm.normal_update()
    sand, grass, rock, snow = (hex_rgba(c) for c in ('#d8c890', '#5f9a3a', '#7a7068', '#f0f2f6'))
    for f in bm.faces:
        for loop in f.loops:
            z = loop.vert.co.z / height
            slope = 1 - loop.vert.normal.z
            c = sand if z < 0.18 else snow if z > 0.82 else grass
            if slope > 0.35 and 0.18 <= z <= 0.82:
                c = rock
            loop[col] = c
    m = bpy.data.materials.new('terrain')
    m.use_nodes = True
    nt = m.node_tree
    vc = nt.nodes.new('ShaderNodeVertexColor')
    vc.layer_name = 'Col'
    nt.links.new(vc.outputs['Color'], nt.nodes['Principled BSDF'].inputs['Base Color'])
    nt.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.9
    o = mesh_object('terrain', bm, m, smooth=True)
    return [o]


def vehicle(params, seed):
    """A simple car: body, cabin, four wheels (separate objects, named so an engine can spin them), lights."""
    L, W, H = P(params, 'length', 4.0), P(params, 'width', 1.8), P(params, 'height', 1.4)
    paint = material('paint', P(params, 'color', '#c83a3a'), 0.3, 0.4)
    glass = material('glass', '#203040', 0.05, 0.2)
    rubber = material('tyre', '#1a1a1e', 0.9)
    rim = material('rim', '#c8c8d0', 0.3, 1.0)
    light = material('light', '#fff8e0', 0.2, emission='#fff4d0', emission_strength=3.0)
    wr = H * 0.24
    parts = [box('body', (W, L, H * 0.42), (0, 0, wr * 0.9), paint, bevel=0.08, segments=2)]
    cab = box('cabin', (W * 0.86, L * 0.48, H * 0.36), (0, L * 0.06, wr * 0.9 + H * 0.42), glass, bevel=0.06, segments=2)
    # Taper the cabin roof: pull the top verts in.
    for v in cab.data.vertices:
        if v.co.z > wr * 0.9 + H * 0.42 + H * 0.2:
            v.co.x *= 0.88
            v.co.y = v.co.y * 0.8 + L * 0.012
    parts.append(cab)
    parts.append(box('roof', (W * 0.74, L * 0.36, 0.05), (0, L * 0.07, wr * 0.9 + H * 0.78), paint, bevel=0.02))
    for x in (-1, 1):
        for y in (-1, 1):
            w = cylinder(f"wheel_{'F' if y < 0 else 'R'}{'L' if x < 0 else 'R'}", wr, 0.24, (x * (W / 2 - 0.08), y * L * 0.32, wr), rubber, verts=20, axis='X')
            hub = cylinder('hub', wr * 0.55, 0.26, (x * (W / 2 - 0.08), y * L * 0.32, wr), rim, verts=12, axis='X')
            from util import join
            parts.append(join([w, hub], w.name))
    for x in (-1, 1):
        parts.append(box('headlight', (0.3, 0.04, 0.12), (x * W * 0.32, -L / 2 - 0.005, wr * 0.9 + H * 0.24), light))
    return parts


GENERATORS = {'tree': tree, 'kit': kit, 'building': building, 'terrain': terrain, 'vehicle': vehicle}
