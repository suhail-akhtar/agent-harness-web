# A stylized blocky humanoid: box parts skinned rigidly to an armature (hips, spine,
# chest, neck, head, arms, legs, feet) with four actions: idle, walk, run, jump.
# Facing -Y in Blender (+Z in glTF), about 1.8 m tall, its origin between the feet.

import math
import random

import bmesh
import bpy
from mathutils import Vector

from util import hex_rgba, link, material

SKIN = ['#f2c9a0', '#e0a878', '#c48a5a', '#8a5a3a', '#5a3a28']
HAIR = ['#2a1e18', '#5a3a22', '#a06a30', '#d8b060', '#8a2a20', '#404048']
SHIRT = ['#3d7fd0', '#c8423e', '#3e9a4a', '#8a4ab0', '#d08a2a', '#2a8a8a']
PANTS = ['#3a3f5a', '#4a3828', '#2a2a30', '#5a5a3a']

BONES = [
    # name, head, tail, parent
    ('hips', (0, 0, 0.88), (0, 0, 1.0), None),
    ('spine', (0, 0, 1.0), (0, 0, 1.22), 'hips'),
    ('chest', (0, 0, 1.22), (0, 0, 1.44), 'spine'),
    ('neck', (0, 0, 1.44), (0, 0, 1.52), 'chest'),
    ('head', (0, 0, 1.52), (0, 0, 1.86), 'neck'),
    ('upper_arm.L', (0.29, 0, 1.41), (0.29, 0, 1.13), 'chest'),
    ('forearm.L', (0.29, 0, 1.13), (0.29, 0, 0.86), 'upper_arm.L'),
    ('upper_arm.R', (-0.29, 0, 1.41), (-0.29, 0, 1.13), 'chest'),
    ('forearm.R', (-0.29, 0, 1.13), (-0.29, 0, 0.86), 'upper_arm.R'),
    ('thigh.L', (0.1, 0, 0.88), (0.1, 0, 0.5), 'hips'),
    ('shin.L', (0.1, 0, 0.5), (0.1, 0, 0.1), 'thigh.L'),
    ('foot.L', (0.1, 0, 0.1), (0.1, -0.16, 0.05), 'shin.L'),
    ('thigh.R', (-0.1, 0, 0.88), (-0.1, 0, 0.5), 'hips'),
    ('shin.R', (-0.1, 0, 0.5), (-0.1, 0, 0.1), 'thigh.R'),
    ('foot.R', (-0.1, 0, 0.1), (-0.1, -0.16, 0.05), 'shin.R'),
]


def _parts(colors):
    # (bone, material, size x y z, centre-bottom x y z)
    p = [
        ('head', 'skin', (0.36, 0.34, 0.33), (0, 0, 1.52)),
        ('head', 'hair', (0.38, 0.36, 0.1), (0, 0.005, 1.77)),
        ('head', 'hair', (0.38, 0.1, 0.24), (0, 0.135, 1.56)),
        ('head', 'eye', (0.06, 0.02, 0.07), (0.08, -0.171, 1.65)),
        ('head', 'eye', (0.06, 0.02, 0.07), (-0.08, -0.171, 1.65)),
        ('neck', 'skin', (0.14, 0.14, 0.1), (0, 0, 1.43)),
        ('chest', 'shirt', (0.44, 0.25, 0.24), (0, 0, 1.21)),
        ('spine', 'shirt', (0.4, 0.23, 0.22), (0, 0, 1.0)),
        ('hips', 'pants', (0.38, 0.22, 0.14), (0, 0, 0.87)),
        ('hips', 'belt', (0.4, 0.24, 0.05), (0, 0, 0.98)),
        ('upper_arm.L', 'shirt', (0.13, 0.13, 0.3), (0.29, 0, 1.12)),
        ('forearm.L', 'skin', (0.11, 0.11, 0.27), (0.29, 0, 0.86)),
        ('forearm.L', 'skin', (0.12, 0.13, 0.11), (0.29, 0, 0.76)),
        ('upper_arm.R', 'shirt', (0.13, 0.13, 0.3), (-0.29, 0, 1.12)),
        ('forearm.R', 'skin', (0.11, 0.11, 0.27), (-0.29, 0, 0.86)),
        ('forearm.R', 'skin', (0.12, 0.13, 0.11), (-0.29, 0, 0.76)),
        ('thigh.L', 'pants', (0.16, 0.17, 0.39), (0.1, 0, 0.5)),
        ('shin.L', 'pants', (0.14, 0.15, 0.4), (0.1, 0, 0.1)),
        ('foot.L', 'shoes', (0.15, 0.27, 0.1), (0.1, -0.05, 0.0)),
        ('thigh.R', 'pants', (0.16, 0.17, 0.39), (-0.1, 0, 0.5)),
        ('shin.R', 'pants', (0.14, 0.15, 0.4), (-0.1, 0, 0.1)),
        ('foot.R', 'shoes', (0.15, 0.27, 0.1), (-0.1, -0.05, 0.0)),
    ]
    return p


def build(params, seed):
    rnd = random.Random(seed)
    colors = {
        'skin': params.get('skin') or rnd.choice(SKIN), 'hair': params.get('hair') or rnd.choice(HAIR),
        'shirt': params.get('shirt') or rnd.choice(SHIRT), 'pants': params.get('pants') or rnd.choice(PANTS),
        'shoes': params.get('shoes') or '#3a2a20', 'belt': params.get('belt') or '#2a1e16', 'eye': '#1a1428',
    }
    mats = {k: material(k, v, 0.7 if k != 'eye' else 0.3) for k, v in colors.items()}
    order = list(mats.keys())
    # One mesh: every part a box, its vertices in the vertex group of its bone.
    bm = bmesh.new()
    deform = bm.verts.layers.deform.verify()
    uvl = bm.loops.layers.uv.new('UVMap')
    bone_index = {b[0]: i for i, b in enumerate(BONES)}
    for bone, mat, size, base in _parts(colors):
        tmp = bmesh.new()
        tmp.loops.layers.uv.new('UVMap')
        bmesh.ops.create_cube(tmp, size=1.0, calc_uvs=True)
        for v in tmp.verts:
            v.co = Vector((v.co.x * size[0] + base[0], v.co.y * size[1] + base[1], (v.co.z + 0.5) * size[2] + base[2]))
        me = bpy.data.meshes.new('t')
        tmp.to_mesh(me)
        tmp.free()
        for poly in me.polygons:
            poly.material_index = order.index(mat)
        before = len(bm.verts)
        bm.from_mesh(me)
        bpy.data.meshes.remove(me)
        bm.verts.ensure_lookup_table()
        for v in bm.verts[before:]:
            v[deform][bone_index[bone]] = 1.0
    me = bpy.data.meshes.new('character')
    bm.to_mesh(me)
    bm.free()
    body = link(bpy.data.objects.new('character', me))
    for k in order:
        me.materials.append(mats[k])
    for b in BONES:
        body.vertex_groups.new(name=b[0])
    # The armature.
    arm = bpy.data.armatures.new('rig')
    rig = link(bpy.data.objects.new('rig', arm))
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='EDIT')
    for name, head, tail, parent in BONES:
        eb = arm.edit_bones.new(name)
        eb.head, eb.tail = head, tail
        eb.roll = 0
        if parent:
            eb.parent = arm.edit_bones[parent]
            eb.use_connect = False
    bpy.ops.object.mode_set(mode='OBJECT')
    body.parent = rig
    mod = body.modifiers.new('rig', 'ARMATURE')
    mod.object = rig
    for pb in rig.pose.bones:
        pb.rotation_mode = 'XYZ'
    make_actions(rig)
    return [body, rig]


def _key(rig, frame, pose):
    """pose: { bone: (rx, ry, rz) degrees or {'rot': (...), 'loc': (...)} }"""
    for name, v in pose.items():
        pb = rig.pose.bones[name]
        rot, loc = (v.get('rot', (0, 0, 0)), v.get('loc')) if isinstance(v, dict) else (v, None)
        pb.rotation_euler = tuple(math.radians(a) for a in rot)
        pb.keyframe_insert('rotation_euler', frame=frame)
        if loc is not None:
            pb.location = loc
            pb.keyframe_insert('location', frame=frame)


def _action(rig, name, frames, pose_at, cyclic=True):
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    rig.animation_data_create()
    rig.animation_data.action = act
    every = [pb.name for pb in rig.pose.bones]
    for f in range(frames + (1 if cyclic else 0)):
        t = (f % frames) / frames if cyclic else f / max(1, frames - 1)
        pose = {n: (0, 0, 0) for n in every}
        pose['hips'] = {'rot': (0, 0, 0), 'loc': (0, 0, 0)}
        pose.update(pose_at(t))
        _key(rig, f + 1, pose)
    # Linear keys for loops (no ease at the seam).
    for fc in act.fcurves:
        for kp in fc.keyframe_points:
            kp.interpolation = 'BEZIER' if not cyclic else 'LINEAR'
    act.frame_range = (1, frames + (1 if cyclic else 0))
    return act


def make_actions(rig):
    # Bones pointing down (legs, arms): +X rotation swings the far end backward (+Y), so forward is negative.
    s = lambda t, ph=0: math.sin(2 * math.pi * t + ph)
    def idle(t):
        b = s(t)
        return {'chest': (b * 1.5, 0, 0), 'head': (-b * 1.5, 0, 0), 'upper_arm.L': (0, 0, 3 + b * 1.5), 'upper_arm.R': (0, 0, -3 - b * 1.5),
                'hips': {'rot': (0, 0, 0), 'loc': (0, b * 0.008, 0)}}
    def walk(t):
        a = s(t)
        return {'thigh.L': (-a * 28, 0, 0), 'thigh.R': (a * 28, 0, 0), 'shin.L': (max(0, a) * 35, 0, 0), 'shin.R': (max(0, -a) * 35, 0, 0),
                'foot.L': (-a * 8, 0, 0), 'foot.R': (a * 8, 0, 0), 'upper_arm.L': (a * 24, 0, 3), 'upper_arm.R': (-a * 24, 0, -3),
                'forearm.L': (-10, 0, 0), 'forearm.R': (-10, 0, 0), 'chest': (0, 0, a * 4),
                'hips': {'rot': (0, 0, -a * 3), 'loc': (0, abs(math.cos(2 * math.pi * t)) * 0.03 - 0.015, 0)}}
    def run(t):
        a = s(t)
        return {'thigh.L': (-a * 48 - 10, 0, 0), 'thigh.R': (a * 48 - 10, 0, 0), 'shin.L': (max(0, a) * 85 + 10, 0, 0), 'shin.R': (max(0, -a) * 85 + 10, 0, 0),
                'upper_arm.L': (a * 45, 0, 6), 'upper_arm.R': (-a * 45, 0, -6), 'forearm.L': (-65, 0, 0), 'forearm.R': (-65, 0, 0),
                'spine': (-8, 0, 0), 'chest': (-4, 0, a * 6), 'head': (8, 0, 0),
                'hips': {'rot': (0, 0, -a * 5), 'loc': (0, abs(math.cos(2 * math.pi * t)) * 0.06 - 0.04, 0)}}
    def jump(t):
        # Crouch, push off, tuck in the air, land.
        if t < 0.2:
            k = t / 0.2
            return {'thigh.L': (-45 * k, 0, 0), 'thigh.R': (-45 * k, 0, 0), 'shin.L': (80 * k, 0, 0), 'shin.R': (80 * k, 0, 0), 'spine': (-15 * k, 0, 0),
                    'upper_arm.L': (30 * k, 0, 5), 'upper_arm.R': (30 * k, 0, -5), 'hips': {'rot': (0, 0, 0), 'loc': (0, -0.16 * k, 0)}}
        if t < 0.4:
            k = (t - 0.2) / 0.2
            return {'thigh.L': (-45 + 45 * k, 0, 0), 'thigh.R': (-45 + 45 * k, 0, 0), 'shin.L': (80 - 80 * k, 0, 0), 'shin.R': (80 - 80 * k, 0, 0), 'foot.L': (20 * k, 0, 0), 'foot.R': (20 * k, 0, 0),
                    'upper_arm.L': (30 - 190 * k, 0, 5), 'upper_arm.R': (30 - 190 * k, 0, -5), 'hips': {'rot': (0, 0, 0), 'loc': (0, -0.16 + 0.5 * k, 0)}}
        if t < 0.75:
            k = (t - 0.4) / 0.35
            return {'thigh.L': (-55, 0, 0), 'thigh.R': (-30, 0, 0), 'shin.L': (70, 0, 0), 'shin.R': (60, 0, 0), 'upper_arm.L': (-160 + 100 * k, 0, 15), 'upper_arm.R': (-160 + 100 * k, 0, -15),
                    'hips': {'rot': (0, 0, 0), 'loc': (0, 0.34 + 0.1 * math.sin(math.pi * k) - 0.3 * k, 0)}}
        k = (t - 0.75) / 0.25
        return {'thigh.L': (-55 + 20 * k, 0, 0), 'thigh.R': (-30 - 5 * k, 0, 0), 'shin.L': (70 - 10 * k, 0, 0), 'shin.R': (60, 0, 0), 'upper_arm.L': (-60 + 80 * k, 0, 8), 'upper_arm.R': (-60 + 80 * k, 0, -8),
                'hips': {'rot': (0, 0, 0), 'loc': (0, 0.04 - 0.16 * k, 0)}}
    acts = [_action(rig, 'idle', 48, idle), _action(rig, 'walk', 24, walk), _action(rig, 'run', 16, run), _action(rig, 'jump', 24, jump, cyclic=False)]
    rig.animation_data.action = acts[0]
    return acts


GENERATORS = {'character': build}
