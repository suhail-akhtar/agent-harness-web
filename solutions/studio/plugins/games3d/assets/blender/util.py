# Shared helpers for Studio's Blender generators: scene reset, materials, mesh building
# with bmesh, UVs, transforms. Units are metres, Z up, the front of a model faces -Y, and
# the origin sits at the base centre (the glTF exporter turns this into Y up, +Z front).

import math
import random

import bmesh
import bpy
from mathutils import Matrix, Vector


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = 'METRIC'
    scene.unit_settings.scale_length = 1.0
    scene.render.fps = 24
    return scene


def hex_rgba(h, a=1.0):
    h = h.lstrip('#')
    if len(h) == 3:
        h = ''.join(c * 2 for c in h)
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    # sRGB to linear: Blender's colour inputs are linear.
    lin = lambda c: c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return (lin(r), lin(g), lin(b), a)


def material(name, color='#8a6a4a', roughness=0.6, metallic=0.0, emission=None, emission_strength=0.0, alpha=1.0, transmission=0.0, noise=0.0, noise_scale=6.0):
    """A Principled material. noise > 0 darkens the colour by a procedural noise (for bakes and renders)."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = hex_rgba(color)
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Metallic'].default_value = metallic
    if emission:
        bsdf.inputs['Emission Color'].default_value = hex_rgba(emission)
        bsdf.inputs['Emission Strength'].default_value = emission_strength
    if transmission:
        bsdf.inputs['Transmission Weight'].default_value = transmission
    if alpha < 1.0:
        bsdf.inputs['Alpha'].default_value = alpha
        m.blend_method = 'BLEND'
    if noise > 0:
        tex = nt.nodes.new('ShaderNodeTexNoise')
        tex.inputs['Scale'].default_value = noise_scale
        ramp = nt.nodes.new('ShaderNodeValToRGB')
        c = hex_rgba(color)
        ramp.color_ramp.elements[0].color = (c[0] * (1 - noise), c[1] * (1 - noise), c[2] * (1 - noise), 1)
        ramp.color_ramp.elements[1].color = c
        nt.links.new(tex.outputs['Fac'], ramp.inputs['Fac'])
        nt.links.new(ramp.outputs['Color'], bsdf.inputs['Base Color'])
    return m


def link(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj


def mesh_object(name, bm, mat=None, smooth=False):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = link(bpy.data.objects.new(name, me))
    if mat:
        obj.data.materials.append(mat)
    for p in obj.data.polygons:
        p.use_smooth = smooth
    return obj


def select_only(objs):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]


def box(name, size, loc=(0, 0, 0), mat=None, bevel=0.0, segments=1):
    """A box of size (x, y, z) with its base centre at loc; bevel rounds the edges."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
    bmesh.ops.translate(bm, vec=Vector((loc[0], loc[1], loc[2] + size[2] / 2)), verts=bm.verts)
    if bevel > 0:
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, segments=segments, affect='EDGES', profile=0.5)
    return mesh_object(name, bm, mat)


def cylinder(name, radius, depth, loc=(0, 0, 0), mat=None, verts=16, radius_top=None, smooth=True, cap=True, axis='Z'):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=cap, cap_tris=False, segments=verts, radius1=radius, radius2=radius if radius_top is None else radius_top, depth=depth)
    if axis == 'X':
        bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(math.pi / 2, 3, 'Y'))
        bmesh.ops.translate(bm, vec=Vector(loc), verts=bm.verts)
    elif axis == 'Y':
        bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(math.pi / 2, 3, 'X'))
        bmesh.ops.translate(bm, vec=Vector(loc), verts=bm.verts)
    else:
        bmesh.ops.translate(bm, vec=Vector((loc[0], loc[1], loc[2] + depth / 2)), verts=bm.verts)
    obj = mesh_object(name, bm, mat, smooth)
    auto_smooth(obj)
    return obj


def uv_sphere(name, radius, loc=(0, 0, 0), mat=None, segments=16, rings=8, smooth=True):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segments, v_segments=rings, radius=radius)
    bmesh.ops.translate(bm, vec=Vector(loc), verts=bm.verts)
    return mesh_object(name, bm, mat, smooth)


def ico(name, radius, loc=(0, 0, 0), mat=None, subdiv=2, smooth=False):
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=subdiv, radius=radius)
    bmesh.ops.translate(bm, vec=Vector(loc), verts=bm.verts)
    return mesh_object(name, bm, mat, smooth)


def auto_smooth(obj, angle=40):
    """Smooth shading with sharp edges kept (Blender 4.1+: mark sharp edges by angle)."""
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    for e in bm.edges:
        if len(e.link_faces) == 2 and e.calc_face_angle(0) > math.radians(angle):
            e.smooth = False
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True


def join(objs, name):
    objs = [o for o in objs if o is not None]
    select_only(objs)
    bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    o.name = name
    o.data.name = name
    return o


def apply_transforms(obj):
    select_only([obj])
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def ensure_uvs(obj):
    """Every mesh gets UVs (smart projection when it has none): the gates check for them."""
    if obj.type != 'MESH' or obj.data.uv_layers:
        return
    select_only([obj])
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.02)
    bpy.ops.object.mode_set(mode='OBJECT')


def smart_uv(obj):
    select_only([obj])
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.02)
    bpy.ops.object.mode_set(mode='OBJECT')


def origin_to_base(obj):
    """Moves the origin to the bottom centre of the bounds (the object at the world origin)."""
    apply_transforms(obj)
    vs = [v.co for v in obj.data.vertices]
    minz = min(v.z for v in vs)
    cx = (min(v.x for v in vs) + max(v.x for v in vs)) / 2
    cy = (min(v.y for v in vs) + max(v.y for v in vs)) / 2
    obj.data.transform(Matrix.Translation(Vector((-cx, -cy, -minz))))
    obj.location = (0, 0, 0)


def displace_verts(obj, amount, seed=0, scale=1.0):
    """Moves vertices along their normals by a smooth pseudo-noise (rocks, terrain lumps)."""
    rnd = random.Random(seed)
    off = Vector((rnd.uniform(0, 100), rnd.uniform(0, 100), rnd.uniform(0, 100)))
    from mathutils import noise
    me = obj.data
    for v in me.vertices:
        n = noise.noise((v.co * scale) + off)
        n2 = noise.noise((v.co * scale * 2.3) + off * 1.7) * 0.5
        v.co += v.normal * (n + n2) * amount


def triangles(objs):
    dg = bpy.context.evaluated_depsgraph_get()
    total = 0
    for o in objs:
        if o.type != 'MESH':
            continue
        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        me.calc_loop_triangles()
        total += len(me.loop_triangles)
        ev.to_mesh_clear()
    return total


def bounds(objs):
    pts = []
    for o in objs:
        if o.type == 'MESH':
            pts += [o.matrix_world @ Vector(c) for c in o.bound_box]
    if not pts:
        return (0, 0, 0), (0, 0, 0)
    mn = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    mx = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return mn, mx


def clean_mesh(obj):
    """Merges coincident vertices and removes zero-area faces and zero-length edges (the gates count them)."""
    if obj.type != 'MESH':
        return
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.dissolve_degenerate(bm, edges=bm.edges, dist=1e-6)
    # Faces that are still slivers (area ~ 0) go.
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.calc_area() < 1e-10], context='FACES')
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
