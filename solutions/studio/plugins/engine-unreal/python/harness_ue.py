"""Helpers for Unreal Engine 5.8 editor Python, shipped by the harness (engine-unreal).

Import it in a script the `unreal` tool runs (it is on sys.path there):

    import harness_ue as h
    h.open_level("/Game/Levels/Lvl_Coins")
    h.build_level({...})
    h.save()

Every helper uses the 5.8 editor subsystems (EditorActorSubsystem, LevelEditorSubsystem,
SubobjectDataSubsystem) and the 5.8 Blueprint graph API (BlueprintGraphEditor,
BlueprintGraphPin). Units are centimetres, Z is up, rotations are (pitch, yaw, roll) degrees.
`h.result(...)` prints a HARNESS_JSON line the tool hands back as data.
"""

import json
import math
import os
import traceback

import unreal

# ---------- output ----------

def _plain(v):
    """A JSON-friendly copy of an unreal value."""
    if isinstance(v, (str, int, float, bool)) or v is None:
        return v
    if isinstance(v, (list, tuple, unreal.Array)):
        return [_plain(x) for x in v]
    if isinstance(v, (dict, unreal.Map)):
        return {str(k): _plain(x) for k, x in v.items()}
    if isinstance(v, unreal.Vector):
        return [round(v.x, 3), round(v.y, 3), round(v.z, 3)]
    if isinstance(v, unreal.Rotator):
        return [round(v.pitch, 3), round(v.yaw, 3), round(v.roll, 3)]
    if isinstance(v, unreal.Vector2D):
        return [round(v.x, 3), round(v.y, 3)]
    if isinstance(v, (unreal.LinearColor, unreal.Color)):
        return [v.r, v.g, v.b, v.a]
    if isinstance(v, unreal.Name) or isinstance(v, unreal.Text):
        return str(v)
    if isinstance(v, unreal.Object):
        return v.get_path_name()
    if isinstance(v, unreal.EnumBase):
        return v.name
    return str(v)


def result(tag, data=None):
    """Hands data back to the tool: one HARNESS_JSON line in the log."""
    print("HARNESS_JSON " + json.dumps({"tag": tag, "data": _plain(data)}))


def problem(message):
    """A problem the tool reports with the result (the run still finishes)."""
    unreal.log_error("HARNESS_PROBLEM " + str(message))


# ---------- basics ----------

def actors():
    return unreal.get_editor_subsystem(unreal.EditorActorSubsystem)


def levels():
    return unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)


def world():
    return unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()


def asset_tools():
    return unreal.AssetToolsHelpers.get_asset_tools()


EAL = unreal.EditorAssetLibrary
BEL = unreal.BlueprintEditorLibrary
GraphEditor = unreal.BlueprintGraphEditor


def vec(v, default=(0, 0, 0)):
    v = default if v is None else v
    if isinstance(v, unreal.Vector):
        return v
    if isinstance(v, (int, float)):
        return unreal.Vector(v, v, v)
    return unreal.Vector(float(v[0]), float(v[1]), float(v[2]))


def rot(r):
    if r is None:
        return unreal.Rotator(0, 0, 0)
    if isinstance(r, unreal.Rotator):
        return r
    # pitch, yaw, roll (the order the editor shows)
    return unreal.Rotator(roll=float(r[2]) if len(r) > 2 else 0.0, pitch=float(r[0]), yaw=float(r[1]))


def split_path(path):
    """'/Game/A/B' -> ('/Game/A', 'B')."""
    path = path.rstrip("/")
    folder, name = path.rsplit("/", 1)
    return folder, name.split(".")[0]


def load(path):
    """An asset or class by path; class paths may end in _C. None when missing."""
    if path is None:
        return None
    if not isinstance(path, str):
        return path
    if path.startswith("/Script/"):
        return unreal.load_class(None, path) if "." in path else None
    obj = unreal.load_object(None, path if "." in path.rsplit("/", 1)[-1] else path + "." + path.rsplit("/", 1)[-1])
    return obj


def load_class(path_or_class):
    """A UClass from a class, a /Script/ path, a Blueprint asset path or a native class name ('StaticMeshActor')."""
    c = path_or_class
    if isinstance(c, unreal.Class):
        return c
    if isinstance(c, type):
        return c.static_class()
    if isinstance(c, unreal.Blueprint):
        return c.generated_class()
    if isinstance(c, str):
        if not c.startswith("/"):
            native = getattr(unreal, c, None)
            if native is not None:
                return native.static_class()
            raise ValueError("no class named " + c)
        if c.startswith("/Script/"):
            return unreal.load_class(None, c)
        leaf = c.rsplit("/", 1)[-1]
        if "." not in leaf:
            c = c + "." + leaf + "_C"
        elif not c.endswith("_C"):
            c = c + "_C"
        cls = unreal.load_class(None, c)
        if cls is None:
            raise ValueError("no Blueprint class at " + c)
        return cls
    raise ValueError("not a class: %r" % (c,))


SHAPES = {
    "cube": "/Engine/BasicShapes/Cube.Cube",
    "sphere": "/Engine/BasicShapes/Sphere.Sphere",
    "cylinder": "/Engine/BasicShapes/Cylinder.Cylinder",
    "cone": "/Engine/BasicShapes/Cone.Cone",
    "plane": "/Engine/BasicShapes/Plane.Plane",
}


def mesh(name_or_path):
    path = SHAPES.get(name_or_path, name_or_path)
    m = unreal.load_object(None, path)
    if m is None:
        raise ValueError("no static mesh at " + str(path))
    return m


# ---------- levels ----------

def open_level(path):
    """Opens a level (map) asset in the editor world."""
    if not levels().load_level(path):
        raise RuntimeError("could not open level " + path)
    return world()


def new_level(path, template=None, partitioned=False):
    """Makes and opens a new level. template: a map to copy (e.g. '/Engine/Maps/Templates/OpenWorld'), else empty."""
    if EAL.does_asset_exist(path):
        return open_level(path)
    ok = levels().new_level_from_template(path, template) if template else levels().new_level(path, partitioned)
    if not ok:
        raise RuntimeError("could not create level " + path)
    return world()


def save():
    """Saves the open level and every changed asset."""
    levels().save_all_dirty_levels()
    unreal.EditorLoadingAndSavingUtils.save_dirty_packages(True, True)


def current_level_path():
    return world().get_path_name().split(".")[0]


# ---------- actors ----------

def spawn(cls, location=None, rotation=None, scale=None, label=None, folder=None, mesh_path=None, material=None, props=None, tags=None):
    """Spawns an actor of a class (native name, /Script path, Blueprint path) and sets it up."""
    klass = load_class(cls)
    a = actors().spawn_actor_from_class(klass, vec(location), rot(rotation))
    if a is None:
        raise RuntimeError("could not spawn " + str(cls))
    if scale is not None:
        a.set_actor_scale3d(vec(scale))
    if label:
        a.set_actor_label(label)
    if folder:
        a.set_folder_path(folder)
    if mesh_path is not None or material is not None:
        smc = a.get_component_by_class(unreal.StaticMeshComponent)
        if smc is not None:
            if mesh_path is not None:
                smc.set_static_mesh(mesh(mesh_path))
            if material is not None:
                smc.set_material(0, load(material) if isinstance(material, str) else material)
    if tags:
        a.set_editor_property("tags", [unreal.Name(t) for t in tags])
    if props:
        set_props(a, props)
    return a


def set_props(obj, props):
    """Sets editor properties by name (snake_case); vectors and rotators may be lists."""
    for k, v in (props or {}).items():
        if k == "collision_profile":
            obj.set_collision_profile_name(v)
            continue
        if k == "material":
            obj.set_material(0, load(v) if isinstance(v, str) else v)
            continue
        cur = obj.get_editor_property(k)
        if isinstance(cur, unreal.Vector) and isinstance(v, (list, tuple)):
            v = vec(v)
        elif isinstance(cur, unreal.Rotator) and isinstance(v, (list, tuple)):
            v = rot(v)
        elif isinstance(cur, unreal.LinearColor) and isinstance(v, (list, tuple)):
            v = unreal.LinearColor(*v)
        elif isinstance(cur, unreal.Color) and isinstance(v, (list, tuple)):
            v = unreal.Color(*[int(x) for x in v])
        obj.set_editor_property(k, v)
    return obj


def find_actors(label=None, cls=None, tag=None):
    out = []
    klass = load_class(cls) if cls else None
    for a in actors().get_all_level_actors():
        if label and a.get_actor_label() != label and not a.get_actor_label().startswith(label + "_"):
            continue
        if klass and not unreal.MathLibrary.class_is_child_of(a.get_class(), klass):
            continue
        if tag and not a.actor_has_tag(tag):
            continue
        out.append(a)
    return out


def delete_actors(items):
    for a in items:
        actors().destroy_actor(a)


def box(label, center, size, material=None, folder="Level"):
    """A box of size (x, y, z) cm centred at center, from the 100 cm engine cube."""
    s = vec(size)
    return spawn("StaticMeshActor", location=center, scale=(s.x / 100.0, s.y / 100.0, s.z / 100.0), label=label, folder=folder, mesh_path="cube", material=material)


# ---------- materials ----------

def color_material(path, rgb=(0.8, 0.8, 0.8), emissive=0.0, metallic=0.0, roughness=0.5):
    """A simple opaque material with a Color vector parameter (instances can change it)."""
    if EAL.does_asset_exist(path):
        return load(path)
    folder, name = split_path(path)
    mat = asset_tools().create_asset(name, folder, unreal.Material, unreal.MaterialFactoryNew())
    MEL = unreal.MaterialEditingLibrary
    col = MEL.create_material_expression(mat, unreal.MaterialExpressionVectorParameter, -400, 0)
    col.set_editor_property("parameter_name", "Color")
    col.set_editor_property("default_value", unreal.LinearColor(rgb[0], rgb[1], rgb[2], 1.0))
    MEL.connect_material_property(col, "", unreal.MaterialProperty.MP_BASE_COLOR)
    for prop, value, y in ((unreal.MaterialProperty.MP_METALLIC, metallic, 200), (unreal.MaterialProperty.MP_ROUGHNESS, roughness, 300)):
        c = MEL.create_material_expression(mat, unreal.MaterialExpressionConstant, -400, y)
        c.set_editor_property("r", float(value))
        MEL.connect_material_property(c, "", prop)
    if emissive:
        mul = MEL.create_material_expression(mat, unreal.MaterialExpressionMultiply, -200, 100)
        mul.set_editor_property("const_b", float(emissive))
        MEL.connect_material_expressions(col, "", mul, "A")
        MEL.connect_material_property(mul, "", unreal.MaterialProperty.MP_EMISSIVE_COLOR)
    MEL.recompile_material(mat)
    EAL.save_loaded_asset(mat)
    return mat


def texture_material(path, base_color, normal=None, roughness=None, tiling=1.0):
    """A material from imported textures (asset paths): BaseColor, optional Normal and Roughness, with UV tiling."""
    if EAL.does_asset_exist(path):
        return load(path)
    folder, name = split_path(path)
    mat = asset_tools().create_asset(name, folder, unreal.Material, unreal.MaterialFactoryNew())
    MEL = unreal.MaterialEditingLibrary
    uv = MEL.create_material_expression(mat, unreal.MaterialExpressionTextureCoordinate, -800, 0)
    uv.set_editor_property("u_tiling", float(tiling))
    uv.set_editor_property("v_tiling", float(tiling))

    def sample(tex_path, y, prop, sampler=None):
        t = MEL.create_material_expression(mat, unreal.MaterialExpressionTextureSampleParameter2D, -500, y)
        t.set_editor_property("parameter_name", prop.name.replace("MP_", "").title())
        t.set_editor_property("texture", load(tex_path))
        if sampler is not None:
            t.set_editor_property("sampler_type", sampler)
        MEL.connect_material_expressions(uv, "", t, "UVs")
        MEL.connect_material_property(t, "RGB" if prop != unreal.MaterialProperty.MP_ROUGHNESS else "R", prop)
        return t

    sample(base_color, 0, unreal.MaterialProperty.MP_BASE_COLOR)
    if normal:
        sample(normal, 300, unreal.MaterialProperty.MP_NORMAL, unreal.MaterialSamplerType.SAMPLERTYPE_NORMAL)
    if roughness:
        sample(roughness, 600, unreal.MaterialProperty.MP_ROUGHNESS, unreal.MaterialSamplerType.SAMPLERTYPE_LINEAR_COLOR)
    MEL.recompile_material(mat)
    EAL.save_loaded_asset(mat)
    return mat


def material_instance(path, parent, vectors=None, scalars=None, textures=None):
    """A material instance of parent with parameter values: vectors {name: [r,g,b,a]}, scalars {name: x}, textures {name: path}."""
    MEL = unreal.MaterialEditingLibrary
    if EAL.does_asset_exist(path):
        mi = load(path)
    else:
        folder, name = split_path(path)
        mi = asset_tools().create_asset(name, folder, unreal.MaterialInstanceConstant, unreal.MaterialInstanceConstantFactoryNew())
    MEL.set_material_instance_parent(mi, load(parent) if isinstance(parent, str) else parent)
    for k, v in (vectors or {}).items():
        c = list(v) + [1.0] * (4 - len(v))
        MEL.set_material_instance_vector_parameter_value(mi, k, unreal.LinearColor(*c[:4]))
    for k, v in (scalars or {}).items():
        MEL.set_material_instance_scalar_parameter_value(mi, k, float(v))
    for k, v in (textures or {}).items():
        MEL.set_material_instance_texture_parameter_value(mi, k, load(v))
    MEL.update_material_instance(mi)
    EAL.save_loaded_asset(mi)
    return mi


# ---------- importing ----------

def import_files(files, dest="/Game/Imported", replace=True, combine_meshes=True):
    """Imports FBX, glTF/GLB, OBJ, USD, textures (png, jpg, tga, exr) and audio (wav, ogg) with AssetImportTask.
    In 5.8 Interchange handles glTF, FBX, OBJ and textures. Returns the imported asset paths."""
    tasks = []
    for f in files:
        t = unreal.AssetImportTask()
        t.set_editor_property("filename", os.path.abspath(f))
        t.set_editor_property("destination_path", dest)
        t.set_editor_property("automated", True)
        t.set_editor_property("replace_existing", replace)
        t.set_editor_property("save", True)
        tasks.append(t)
    asset_tools().import_asset_tasks(tasks)
    out = []
    for t in tasks:
        paths = list(t.get_editor_property("imported_object_paths") or [])
        if not paths:
            problem("nothing was imported from " + t.get_editor_property("filename"))
        out.extend(str(p) for p in paths)
    return out


def export_asset(asset_path, file_path):
    """Exports an asset (a static mesh to .fbx/.obj/.gltf/.glb, a texture to .png...) with the matching exporter."""
    obj = load(asset_path)
    task = unreal.AssetExportTask()
    task.set_editor_property("object", obj)
    task.set_editor_property("filename", os.path.abspath(file_path))
    task.set_editor_property("automated", True)
    task.set_editor_property("replace_identical", True)
    task.set_editor_property("prompt", False)
    ok = unreal.Exporter.run_asset_export_task(task)
    if not ok:
        problem("could not export %s to %s" % (asset_path, file_path))
    return ok


# ---------- Blueprints ----------

def pin_type(t):
    """An EdGraphPinType from 'int', 'bool', 'real' (float), 'string', 'name', 'text', 'byte',
    'vector', 'rotator', 'transform', 'object:<class>' or 'class:<class>'."""
    if isinstance(t, unreal.EdGraphPinType):
        return t
    t = {"float": "real", "double": "real", "integer": "int", "str": "string"}.get(t, t)
    if t in ("int", "byte", "bool", "real", "name", "string", "text"):
        return BEL.get_basic_type_by_name(t)
    if t in ("vector", "rotator", "transform", "linearcolor"):
        struct = {"vector": unreal.Vector, "rotator": unreal.Rotator, "transform": unreal.Transform, "linearcolor": unreal.LinearColor}[t]
        return BEL.get_struct_type(struct.static_struct())
    if t.startswith("object:"):
        return BEL.get_object_reference_type(load_class(t[7:]))
    if t.startswith("class:"):
        return BEL.get_class_reference_type(load_class(t[6:]))
    if t.startswith("array:"):
        return BEL.get_array_type(pin_type(t[6:]))
    raise ValueError("unknown variable type " + t)


def create_blueprint(path, parent="Actor"):
    """A Blueprint class asset (an Actor by default), or the one already at path."""
    if EAL.does_asset_exist(path):
        return load(path)
    bp = BEL.create_blueprint_asset_with_parent(path, load_class(parent))
    if bp is None:
        raise RuntimeError("could not create Blueprint " + path)
    return bp


def _subobjects():
    return unreal.get_engine_subsystem(unreal.SubobjectDataSubsystem)


def components(bp):
    """name -> component template of a Blueprint (from its construction script)."""
    sub = _subobjects()
    lib = unreal.SubobjectDataBlueprintFunctionLibrary
    out = {}
    for h in sub.k2_gather_subobject_data_for_blueprint(bp):
        data = lib.get_data(h)
        obj = lib.get_object_for_blueprint(data, bp)
        if obj is not None and isinstance(obj, unreal.ActorComponent):
            out[str(lib.get_variable_name(data))] = obj
    return out


def add_component(bp, name, cls, parent=None, props=None, root=False):
    """Adds a component to a Blueprint (under parent, a component name, else the root), sets its properties.
    root=True makes it the new scene root. Returns the component template."""
    existing = components(bp)
    if name in existing:
        comp = existing[name]
        if props:
            set_props(comp, props)
        return comp
    sub = _subobjects()
    lib = unreal.SubobjectDataBlueprintFunctionLibrary
    handles = sub.k2_gather_subobject_data_for_blueprint(bp)
    by_name = {str(lib.get_variable_name(lib.get_data(h))): h for h in handles}
    parent_handle = by_name.get(parent) if parent else handles[0]
    if parent_handle is None:
        raise ValueError("no component %s in %s" % (parent, bp.get_name()))
    params = unreal.AddNewSubobjectParams(parent_handle=parent_handle, new_class=load_class(cls), blueprint_context=bp)
    handle, reason = sub.add_new_subobject(params)
    if not lib.is_handle_valid(handle):
        raise RuntimeError("could not add %s to %s: %s" % (name, bp.get_name(), reason))
    sub.rename_subobject(handle, unreal.Text(name))
    if root:
        sub.make_new_scene_root(handles[0], handle, bp)
    comp = lib.get_object_for_blueprint(lib.get_data(handle), bp)
    if props:
        set_props(comp, props)
    return comp


def add_variable(bp, name, type_name="int", default=None, editable=False, category=None):
    """A member variable with a default value (set on the class defaults after the next compile)."""
    if name not in [str(n) for n in BEL.list_member_variable_names(bp, False)]:
        BEL.add_member_variable(bp, name, pin_type(type_name))
    if editable:
        BEL.set_blueprint_variable_instance_editable(bp, name, True)
    if category:
        BEL.set_blueprint_variable_category(bp, name, unreal.Text(category))
    if default is not None:
        _pending_defaults.setdefault(bp.get_path_name(), {})[name] = default
    return name


_pending_defaults = {}


def compile_blueprint(bp):
    """Compiles a Blueprint and applies pending variable defaults. Returns the errors (node title: message)."""
    BEL.compile_blueprint(bp)
    for name, value in _pending_defaults.pop(bp.get_path_name(), {}).items():
        cdo = unreal.get_default_object(BEL.generated_class(bp))
        cdo.set_editor_property(name, value)
    errors = []
    for g in BEL.list_graphs(bp):
        ed = GraphEditor.get_graph_editor(g)
        if ed is None:
            continue
        for n in ed.list_nodes_with_errors():
            errors.append("%s/%s: %s" % (g.get_name(), n.get_node_title(), n.get_editor_property("error_msg")))
    status = bp.get_editor_property("status")
    if status == unreal.BlueprintStatus.BS_ERROR and not errors:
        errors.append("%s does not compile" % bp.get_name())
    for e in errors:
        problem("Blueprint %s: %s" % (bp.get_name(), e))
    return errors


def save_asset(asset):
    EAL.save_loaded_asset(asset, False)


def event_graph(bp):
    return GraphEditor.get_graph_editor(BEL.find_event_graph(bp))


def event(bp, name, pos=(0, 0)):
    """An event node in the event graph: ReceiveBeginPlay, ReceiveTick, ReceiveDrawHUD... (added when missing)."""
    ed = event_graph(bp)
    node = ed.find_event_node(name)
    if node is None:
        node = BEL.add_event_override(bp, name, unreal.IntPoint(pos[0], pos[1]))
    if node is None:
        raise RuntimeError("no event %s on %s" % (name, bp.get_name()))
    return node


class Graph(object):
    """A small wrapper over BlueprintGraphEditor: nodes by function path, pins by name, wiring.

        g = h.Graph(bp)                       # the event graph
        begin = g.event("ReceiveBeginPlay")
        p = g.call("/Script/Engine.KismetSystemLibrary:PrintString", InString="hello")
        g.then(begin, p)                      # exec wire
    """

    def __init__(self, bp, name=None):
        self.bp = bp
        self.ed = GraphEditor.get_graph_editor_by_name(bp, name) if name else event_graph(bp)
        if self.ed is None:
            raise RuntimeError("no graph %s in %s" % (name or "EventGraph", bp.get_name()))
        self.x = 300
        self.y = 0

    def _place(self, node, pos=None):
        if node is None:
            return node
        if pos is None:
            pos = (self.x, self.y)
            self.x += 320
        node.set_node_pos(unreal.IntPoint(int(pos[0]), int(pos[1])))
        return node

    def event(self, name, pos=None):
        n = event(self.bp, name, pos or (0, self.y))
        return n

    def component_event(self, component_name, delegate="OnComponentBeginOverlap"):
        comp = components(self.bp).get(component_name)
        if comp is None:
            raise ValueError("no component " + component_name)
        n = self.ed.add_component_bound_event_node(comp, delegate)
        if n is None:
            raise RuntimeError("could not bind %s.%s" % (component_name, delegate))
        return self._place(n, (0, self.y))

    def custom_event(self, name):
        return self._place(self.ed.add_custom_event_node(name), (0, self.y))

    def call(self, function_path, pos=None, **pins):
        """A function call node: '/Script/Engine.KismetSystemLibrary:PrintString', a Blueprint's
        '/Game/X/BP_Y.BP_Y_C:Fn', or a function of this Blueprint by name. Literal pins by name."""
        n = self.ed.add_call_function_node(function_path)
        if n is None and ":" in function_path:
            n = self.ed.add_call_function_node(function_path.replace(":", "."))
        if n is None:
            raise RuntimeError("no function " + function_path)
        self._place(n, pos)
        for k, v in pins.items():
            self.set(n, k, v)
        return n

    def node(self, menu_path, pos=None, context=None):
        """Any node the Blueprint menu has, by 'Category|Name' without spaces (e.g. 'Utilities|FlowControl|Branch')."""
        n = self.ed.create_node_from_name(menu_path, unreal.Vector2D(self.x, self.y), context or [], None)
        if n is None:
            raise RuntimeError("no node " + menu_path)
        return self._place(n, pos)

    def branch(self, pos=None):
        return self._place(self.ed.add_branch_node(), pos)

    def get(self, var, pos=None):
        return self._place(self.ed.add_get_member_variable_node(var, ""), pos)

    def setter(self, var, pos=None):
        return self._place(self.ed.add_set_member_variable_node(var, ""), pos)

    def macro(self, path, pos=None):
        return self._place(self.ed.add_macro_node(path), pos)

    def pin(self, node, name, output=None):
        """A pin by name: inputs first unless output=True (or the name is only an output)."""
        if output is not True:
            p = node.find_input_pin(name)
            if p.is_valid():
                return p
        p = node.find_output_pin(name)
        if p.is_valid():
            return p
        names = [str(x.get_pin_name()) for x in node.list_all_pins()]
        raise ValueError("no pin %s on %s (pins: %s)" % (name, node.get_node_title(), ", ".join(names)))

    def out(self, node, name=None):
        """An output pin: by name, else the node's single result."""
        if name is None:
            p = node.find_result_pin()
            if not p.is_valid():
                raise ValueError("%s has no single result pin" % node.get_node_title())
            return p
        return self.pin(node, name, output=True)

    def set(self, node, name, value):
        """A literal on an input pin. Math nodes (==, +, <...) are wildcards until a typed pin is
        wired to them: their literals wait and are set by the wire that types them."""
        if isinstance(value, bool):
            value = "true" if value else "false"
        elif isinstance(value, (list, tuple)):
            value = "(X=%s,Y=%s,Z=%s)" % tuple(value[:3]) if len(value) == 3 else ",".join(str(x) for x in value)
        elif isinstance(value, unreal.Object):
            value = value.get_path_name()
        p = self.pin(node, name)
        if "Wildcard" in str(p.get_pin_type_display_string()):
            self._pending.setdefault(node.get_path_name(), []).append((node, name, str(value)))
            return
        if not p.set_pin_value(str(value)):
            raise ValueError("could not set %s.%s to %s" % (node.get_node_title(), name, value))

    @property
    def _pending(self):
        if not hasattr(self, "_pending_literals"):
            self._pending_literals = {}
        return self._pending_literals

    def wire(self, a, b):
        """Connects two pins (output to input); raises when Unreal refuses."""
        if not a.try_create_connection(b):
            raise RuntimeError("cannot connect %s.%s -> %s.%s" % (a.get_owning_node().get_node_title(), a.get_pin_name(), b.get_owning_node().get_node_title(), b.get_pin_name()))
        for n in (a.get_owning_node(), b.get_owning_node()):
            waiting = self._pending.pop(n.get_path_name(), None)
            for node, name, value in waiting or []:
                self.set(node, name, value)

    def length(self, array_pin):
        """Array length, wired to an array pin."""
        n = self.call("/Script/Engine.KismetArrayLibrary:Array_Length")
        self.wire(array_pin, n.find_input_pin("TargetArray"))
        return n

    def array_get(self, array_pin, index_pin):
        """Array item (a copy), wired to an array pin and an int pin."""
        n = self.call("/Script/Engine.KismetArrayLibrary:Array_Get")
        ins = list(n.list_input_pins())
        self.wire(array_pin, ins[0])
        self.wire(index_pin, ins[1])
        return n

    def check(self):
        """Raises when a literal never found a typed pin (a math node left unwired)."""
        if self._pending:
            left = ["%s.%s" % (n.get_node_title(), name) for items in self._pending.values() for n, name, _ in items]
            raise RuntimeError("literals still waiting for a wire: " + ", ".join(left))

    def then(self, *nodes):
        """Chains exec pins: each node's then (or the named output pin, given as (node, 'True')) to the next's execute."""
        for a, b in zip(nodes, nodes[1:]):
            src = self.pin(a[0], a[1], output=True) if isinstance(a, tuple) else (a.find_then_pin() if a.find_then_pin().is_valid() else self.pin(a, "then", output=True))
            dst = b.find_execute_pin() if not isinstance(b, tuple) else self.pin(b[0], b[1])
            self.wire(src, dst)
        self.y += 400
        self.x = 300

    def flow(self, *nodes):
        """Like then(), skipping pure nodes (no exec pins), so a chain can list every node it uses."""
        keep = [n for i, n in enumerate(nodes) if i == 0 or isinstance(n, tuple) or _has_exec(n)]
        self.then(*keep)


def _has_exec(node):
    """Whether a node has an exec input (pure nodes have none)."""
    return any(str(p.get_pin_name()) == "execute" for p in node.list_input_pins())


# ---------- game framework ----------

def set_game_mode(game_mode, level=True, project=False):
    """Sets the game mode: the open level's World Settings override, and/or the project default (GameMapsSettings)."""
    cls = load_class(game_mode)
    if level:
        ws = world().get_world_settings()
        ws.set_editor_property("default_game_mode", cls)
    if project:
        settings = unreal.get_default_object(unreal.GameMapsSettings)
        settings.set_editor_property("global_default_game_mode", unreal.SoftClassPath(cls.get_path_name()))
        set_ini("DefaultEngine.ini", "/Script/EngineSettings.GameMapsSettings", "GlobalDefaultGameMode", cls.get_path_name())
    return cls


def set_ini(file_name, section, key, value):
    """Sets key=value in [section] of the project's Config/<file_name> (the editor's Python cannot
    save a settings object's config, so the file is edited; this session sees it next start)."""
    path = os.path.join(unreal.Paths.project_config_dir(), file_name)
    try:
        with open(path, "r", encoding="utf-8") as f:
            lines = f.read().replace("\r\n", "\n").split("\n")
    except IOError:
        lines = []
    head = "[%s]" % section
    if head not in [l.strip() for l in lines]:
        while lines and not lines[-1].strip():
            lines.pop()
        lines += ["", head, "%s=%s" % (key, value), ""]
    else:
        i = [l.strip() for l in lines].index(head) + 1
        j = i
        done = False
        while j < len(lines) and not lines[j].strip().startswith("["):
            if lines[j].split("=", 1)[0].strip() == key:
                lines[j] = "%s=%s" % (key, value)
                done = True
                break
            j += 1
        if not done:
            while j > i and not lines[j - 1].strip():
                j -= 1
            lines.insert(j, "%s=%s" % (key, value))
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


def set_default_maps(game_map=None, editor_map=None):
    """The map the game and the editor open (DefaultEngine.ini GameMapsSettings)."""
    settings = unreal.get_default_object(unreal.GameMapsSettings)
    section = "/Script/EngineSettings.GameMapsSettings"
    if game_map:
        settings.set_editor_property("game_default_map", unreal.SoftObjectPath(_map_object(game_map)))
        set_ini("DefaultEngine.ini", section, "GameDefaultMap", _map_object(game_map))
    if editor_map:
        settings.set_editor_property("editor_startup_map", unreal.SoftObjectPath(_map_object(editor_map)))
        set_ini("DefaultEngine.ini", section, "EditorStartupMap", _map_object(editor_map))


def _map_object(p):
    leaf = p.rsplit("/", 1)[-1]
    return p if "." in leaf else p + "." + leaf


# ---------- level building ----------

def build_level(layout):
    """Builds a level from a description (all optional; sizes and positions in cm):

    {
      "map": "/Game/Levels/Lvl_Coins",        # created when missing, else opened ("current": keep the open one)
      "clear": True,                           # remove what an earlier build_level made (folder Level/Generated)
      "floor": {"size": [4000, 4000], "z": 0, "thickness": 50, "material": "/Game/M/M_Floor"},
      "walls": {"height": 400, "thickness": 50, "material": ...},  # around the floor
      "platforms": [{"at": [x, y, z], "size": [x, y, z], "material": ...}],
      "boxes": [{"label": "Crate", "at": [...], "size": [...]}],
      "pickups": {"class": "/Game/Coins/BP_Coin", "at": [[x, y, z], ...]},
      "actors": [{"class": "PointLight", "at": [...], "rotation": [...], "props": {...}}],
      "lights": {"sun": True, "sky": True, "fog": True, "points": [{"at": [...], "intensity": 5000}]},
      "player_start": [x, y, z] or {"at": [...], "yaw": 0},
      "exit": {"class": "/Game/Coins/BP_Exit", "at": [...]} or {"at": [...], "size": [...]} (a TriggerBox),
      "game_mode": "/Game/Coins/BP_CoinGameMode",
      "camera": {"at": [...], "rotation": [pitch, yaw, roll], "label": "ShotCam"}
    }
    Returns a summary (actors made per kind)."""
    made = {}
    m = layout.get("map")
    if m and m != "current":
        new_level(m, layout.get("template"))
    folder = "Level/Generated"
    if layout.get("clear", True):
        delete_actors([a for a in actors().get_all_level_actors() if str(a.get_folder_path()).startswith(folder)])

    def count(k, n=1):
        made[k] = made.get(k, 0) + n

    f = layout.get("floor")
    if f:
        sx, sy = f.get("size", [4000, 4000])
        t = f.get("thickness", 50)
        z = f.get("z", 0)
        box("Floor", (f.get("at", [0, 0])[0], f.get("at", [0, 0])[1], z - t / 2.0), (sx, sy, t), f.get("material"), folder)
        count("floor")
        w = layout.get("walls")
        if w:
            h = w.get("height", 400)
            th = w.get("thickness", 50)
            cx, cy = f.get("at", [0, 0])
            for i, (px, py, wx, wy) in enumerate(((cx, cy + sy / 2.0, sx, th), (cx, cy - sy / 2.0, sx, th), (cx + sx / 2.0, cy, th, sy), (cx - sx / 2.0, cy, th, sy))):
                box("Wall_%d" % i, (px, py, z + h / 2.0), (wx, wy, h), w.get("material"), folder)
            count("walls", 4)
    for i, p in enumerate(layout.get("platforms", [])):
        box(p.get("label", "Platform_%d" % i), p["at"], p.get("size", [400, 400, 50]), p.get("material"), folder)
        count("platforms")
    for i, b in enumerate(layout.get("boxes", [])):
        box(b.get("label", "Box_%d" % i), b["at"], b.get("size", [100, 100, 100]), b.get("material"), folder)
        count("boxes")
    pk = layout.get("pickups")
    if pk:
        for i, at in enumerate(pk.get("at", [])):
            spawn(pk["class"], location=at, label="%s_%d" % (pk.get("label", "Pickup"), i), folder=folder)
            count("pickups")
    for i, a in enumerate(layout.get("actors", [])):
        spawn(a["class"], location=a.get("at"), rotation=a.get("rotation"), scale=a.get("scale"), label=a.get("label"), folder=folder, mesh_path=a.get("mesh"), material=a.get("material"), props=a.get("props"))
        count("actors")
    lt = layout.get("lights")
    if lt:
        have = {a.get_class().get_name() for a in actors().get_all_level_actors()}
        if lt.get("sun", True) and "DirectionalLight" not in have:
            spawn("DirectionalLight", location=(0, 0, 1000), rotation=(-45, 30, 0), label="Sun", folder=folder, props={})
            sun = find_actors(label="Sun")[0]
            sun.light_component.set_editor_property("atmosphere_sun_light", True)
            count("lights")
        if lt.get("sky", True) and "SkyAtmosphere" not in have:
            spawn("SkyAtmosphere", label="SkyAtmosphere", folder=folder)
            count("lights")
        if lt.get("sky", True) and "SkyLight" not in have:
            sl = spawn("SkyLight", location=(0, 0, 500), label="SkyLight", folder=folder)
            sl.light_component.set_editor_property("real_time_capture", True)
            count("lights")
        if lt.get("fog") and "ExponentialHeightFog" not in have:
            spawn("ExponentialHeightFog", label="Fog", folder=folder)
            count("lights")
        for i, p in enumerate(lt.get("points", [])):
            pl = spawn("PointLight", location=p["at"], label="Light_%d" % i, folder=folder)
            pl.point_light_component.set_editor_property("intensity", float(p.get("intensity", 5000)))
            if p.get("color"):
                pl.point_light_component.set_editor_property("light_color", unreal.Color(*[int(c) for c in p["color"]]))
            count("lights")
    ps = layout.get("player_start")
    if ps is not None:
        at = ps.get("at") if isinstance(ps, dict) else ps
        yaw = ps.get("yaw", 0) if isinstance(ps, dict) else 0
        delete_actors(find_actors(cls="PlayerStart"))
        spawn("PlayerStart", location=at, rotation=(0, yaw, 0), label="PlayerStart", folder=folder)
        count("player_start")
    ex = layout.get("exit")
    if ex:
        if ex.get("class"):
            spawn(ex["class"], location=ex["at"], rotation=ex.get("rotation"), label="Exit", folder=folder)
        else:
            tb = spawn("TriggerBox", location=ex["at"], label="Exit", folder=folder, tags=["Exit"])
            s = vec(ex.get("size", [200, 200, 200]))
            tb.collision_component.set_editor_property("box_extent", unreal.Vector(s.x / 2.0, s.y / 2.0, s.z / 2.0))
        count("exit")
    cam = layout.get("camera")
    if cam:
        delete_actors(find_actors(label=cam.get("label", "ShotCam")))
        spawn("CameraActor", location=cam["at"], rotation=cam.get("rotation"), label=cam.get("label", "ShotCam"), folder=folder)
        count("camera")
    if layout.get("game_mode"):
        set_game_mode(layout["game_mode"])
    return made


# ---------- the collect-and-escape kit ----------

SYS = "/Script/Engine.KismetSystemLibrary"
STATS = "/Script/Engine.GameplayStatics"
MATH = "/Script/Engine.KismetMathLibrary"
STR = "/Script/Engine.KismetStringLibrary"


def _class_path(bp):
    return BEL.generated_class(bp).get_path_name()


def _player_check(g, overlap):
    """OtherActor == the player's pawn, for an overlap event node."""
    pawn = g.call(STATS + ":GetPlayerPawn", PlayerIndex=0)
    eq = g.call(MATH + ":EqualEqual_ObjectObject")
    g.wire(g.pin(overlap, "OtherActor", output=True), g.pin(eq, "A"))
    g.wire(g.out(pawn, "ReturnValue"), g.pin(eq, "B"))
    return eq


def template_game_mode():
    """The template's own game mode Blueprint (BP_ThirdPersonGameMode, BP_TopDownGameMode...), or None."""
    reg = unreal.AssetRegistryHelpers.get_asset_registry()
    for a in reg.get_assets_by_path("/Game", recursive=True):
        name = str(a.asset_name)
        if str(a.asset_class_path.asset_name) == "Blueprint" and name.startswith("BP_") and name.endswith("GameMode") and not str(a.package_path).startswith("/Game/CoinKit"):
            return str(a.package_name)
    return None


def coin_game_kit(folder="/Game/CoinKit", coin_mesh=None, coin_material=None, base_game_mode=None):
    """Makes the Blueprints of a collect-and-escape game, wired with the 5.8 graph API:

    - BP_CoinGameMode (child of the template's game mode, so the template's pawn stays):
      Score and Total; BeginPlay counts the coins; AddScore(Amount) adds and logs
      "HARNESS_EVENT score n"; its HUD class is BP_CoinHUD.
    - BP_CoinHUD: draws "Coins: n / total" every frame (HUD DrawText: UMG's widget tree is not
      editable from Python in 5.8, so the score is drawn by the HUD, in every build).
    - BP_Coin: a spinning gold coin; the player touching it calls AddScore(1) and destroys it.
    - BP_Exit: a glowing pad with a trigger; when the player steps on it with no coin left it
      logs "HARNESS_EVENT win", shows YOU WIN, and quits the game two seconds later.
    Returns the asset paths. Existing assets are kept (delete the folder to rebuild)."""
    paths = {k: "%s/%s" % (folder, k) for k in ("BP_CoinGameMode", "BP_CoinHUD", "BP_Coin", "BP_Exit", "M_Coin", "M_Exit")}
    mat = coin_material or color_material(paths["M_Coin"], (1.0, 0.75, 0.05), emissive=0.4, metallic=1.0, roughness=0.25)
    if isinstance(mat, str):
        mat = load(mat)

    # The game mode first (the coin calls it), then the coin (the game mode counts it).
    gm_new = not EAL.does_asset_exist(paths["BP_CoinGameMode"])
    base_game_mode = base_game_mode or template_game_mode()
    parent = base_game_mode if base_game_mode and EAL.does_asset_exist(base_game_mode) else "GameModeBase"
    gm = create_blueprint(paths["BP_CoinGameMode"], parent)
    if gm_new:
        add_variable(gm, "Score", "int", 0)
        add_variable(gm, "Total", "int", 0)
        compile_blueprint(gm)
        fn = GraphEditor.create_and_edit_function_graph(gm, "AddScore")
        fn.add_graph_input_parameter("Amount", pin_type("int"), "1")
        g = Graph(gm, "AddScore")
        entry = fn.find_graph_entry_pin().get_owning_node()
        add = g.call(MATH + ":Add_IntInt")
        g.wire(g.out(g.get("Score")), g.pin(add, "A"))
        g.wire(g.pin(entry, "Amount", output=True), g.pin(add, "B"))
        set_score = g.setter("Score")
        g.wire(g.out(add, "ReturnValue"), g.pin(set_score, "Score"))
        text = g.call(STR + ":Concat_StrStr", A="HARNESS_EVENT score ")
        conv = g.call(STR + ":Conv_IntToString")
        # A fresh read of Score: the pure + node would be evaluated again for the print, after the set.
        g.wire(g.out(g.get("Score")), g.pin(conv, "InInt"))
        g.wire(g.out(conv, "ReturnValue"), g.pin(text, "B"))
        say = g.call(SYS + ":PrintString", bPrintToScreen=False)
        g.wire(g.out(text, "ReturnValue"), g.pin(say, "InString"))
        g.then(entry, set_score, say)
        g.check()
        # ScoreText(): "Coins: <Score> / <Total>", for the HUD.
        fn = GraphEditor.create_and_edit_function_graph(gm, "ScoreText")
        ret = fn.add_graph_output_parameter("Text", pin_type("string"))
        fn.set_is_pure_function(True)
        g = Graph(gm, "ScoreText")
        entry = fn.find_graph_entry_pin().get_owning_node()
        s1 = g.call(STR + ":Conv_IntToString")
        s2 = g.call(STR + ":Conv_IntToString")
        g.wire(g.out(g.get("Score")), g.pin(s1, "InInt"))
        g.wire(g.out(g.get("Total")), g.pin(s2, "InInt"))
        c1 = g.call(STR + ":Concat_StrStr", A="Coins: ")
        g.wire(g.out(s1, "ReturnValue"), g.pin(c1, "B"))
        c2 = g.call(STR + ":Concat_StrStr", B=" / ")
        g.wire(g.out(c1, "ReturnValue"), g.pin(c2, "A"))
        c3 = g.call(STR + ":Concat_StrStr")
        g.wire(g.out(c2, "ReturnValue"), g.pin(c3, "A"))
        g.wire(g.out(s2, "ReturnValue"), g.pin(c3, "B"))
        g.wire(g.out(c3, "ReturnValue"), g.pin(ret, "Text"))
        g.then(entry, ret)
        g.check()
        compile_blueprint(gm)

    hud_new = not EAL.does_asset_exist(paths["BP_CoinHUD"])
    hud = create_blueprint(paths["BP_CoinHUD"], "HUD")
    if hud_new:
        g = Graph(hud)
        draw = g.event("ReceiveDrawHUD")
        find = g.call(STATS + ":GetActorOfClass", ActorClass=_class_path(gm))
        text = g.call(_class_path(gm) + ":ScoreText")
        g.wire(g.out(find, "ReturnValue"), g.pin(text, "self"))
        dt = g.call("/Script/Engine.HUD:DrawText", ScreenX=40, ScreenY=30, Scale=2.5)
        g.set(dt, "TextColor", "(R=1.000000,G=0.850000,B=0.100000,A=1.000000)")
        g.wire(g.pin(text, "Text", output=True), g.pin(dt, "Text"))
        g.flow(draw, find, text, dt)
        g.check()
        compile_blueprint(hud)
        save_asset(hud)
        unreal.get_default_object(BEL.generated_class(gm)).set_editor_property("hud_class", BEL.generated_class(hud))
        compile_blueprint(gm)

    coin_new = not EAL.does_asset_exist(paths["BP_Coin"])
    coin = create_blueprint(paths["BP_Coin"], "Actor")
    if coin_new:
        add_component(coin, "Trigger", "SphereComponent", props={"sphere_radius": 70.0})
        add_component(coin, "Mesh", "StaticMeshComponent", parent="Trigger", props={
            "static_mesh": mesh(coin_mesh or "cylinder"),
            "relative_scale3d": unreal.Vector(0.6, 0.6, 0.08),
            "relative_rotation": unreal.Rotator(roll=90.0, pitch=0.0, yaw=0.0),
            "collision_profile": "NoCollision",
            "material": mat,
        })
        add_component(coin, "Spin", "RotatingMovementComponent", props={"rotation_rate": unreal.Rotator(0, 120, 0)})
        # Collected: the pawn's capsule and mesh can both overlap in one frame; a coin counts once.
        add_variable(coin, "Collected", "bool", False)
        compile_blueprint(coin)
        g = Graph(coin)
        ov = g.component_event("Trigger", "OnComponentBeginOverlap")
        fresh = g.call(MATH + ":Not_PreBool")
        g.wire(g.out(g.get("Collected")), g.pin(fresh, "A"))
        both = g.call(MATH + ":BooleanAND")
        g.wire(g.out(_player_check(g, ov), "ReturnValue"), g.pin(both, "A"))
        g.wire(g.out(fresh, "ReturnValue"), g.pin(both, "B"))
        br = g.branch()
        g.wire(g.out(both, "ReturnValue"), br.find_input_pin("Condition"))
        mark = g.setter("Collected")
        g.set(mark, "Collected", True)
        find = g.call(STATS + ":GetActorOfClass", ActorClass=_class_path(gm))
        add_score = g.call(_class_path(gm) + ":AddScore")
        g.wire(g.out(find, "ReturnValue"), g.pin(add_score, "self"))
        destroy = g.call("/Script/Engine.Actor:K2_DestroyActor")
        g.then(ov, br)
        g.then((br, "then"), mark, find, add_score, destroy)
        g.check()
        compile_blueprint(coin)

    exit_new = not EAL.does_asset_exist(paths["BP_Exit"])
    ex = create_blueprint(paths["BP_Exit"], "Actor")
    if exit_new:
        add_component(ex, "Trigger", "BoxComponent", props={"box_extent": unreal.Vector(150, 150, 150)})
        add_component(ex, "Marker", "StaticMeshComponent", parent="Trigger", props={
            "static_mesh": mesh("cylinder"),
            "relative_scale3d": unreal.Vector(3.0, 3.0, 0.05),
            "relative_location": unreal.Vector(0, 0, -145),
            "collision_profile": "NoCollision",
            "material": color_material(paths["M_Exit"], (0.1, 0.9, 0.3), emissive=1.5),
        })
        compile_blueprint(ex)
        g = Graph(ex)
        ov = g.component_event("Trigger", "OnComponentBeginOverlap")
        is_player = _player_check(g, ov)
        coins = g.call(STATS + ":GetAllActorsOfClass", ActorClass=_class_path(coin))
        left = g.length(g.pin(coins, "OutActors", output=True))
        none_left = g.call(MATH + ":EqualEqual_IntInt")
        g.wire(g.out(left), g.pin(none_left, "A"))
        g.set(none_left, "B", 0)
        both = g.call(MATH + ":BooleanAND")
        g.wire(g.out(is_player, "ReturnValue"), g.pin(both, "A"))
        g.wire(g.out(none_left, "ReturnValue"), g.pin(both, "B"))
        br = g.branch()
        g.wire(g.out(both, "ReturnValue"), br.find_input_pin("Condition"))
        win = g.call(SYS + ":PrintString", InString="HARNESS_EVENT win YOU WIN", Duration=10.0)
        g.set(win, "TextColor", "(R=0.100000,G=1.000000,B=0.300000,A=1.000000)")
        # A scripted play profiles with the CSV profiler: stop it so the capture is complete.
        stop_csv = g.call(SYS + ":ExecuteConsoleCommand", Command="CsvProfile Stop")
        delay = g.call(SYS + ":Delay", Duration=2.0)
        quit_game = g.call(SYS + ":QuitGame")
        g.then(ov, coins, br)
        g.then((br, "then"), win, stop_csv, delay, quit_game)
        g.check()
        compile_blueprint(ex)

    if gm_new:
        g = Graph(gm)
        begin = g.event("ReceiveBeginPlay")
        coins = g.call(STATS + ":GetAllActorsOfClass", ActorClass=_class_path(coin))
        set_total = g.setter("Total")
        g.wire(g.out(g.length(g.pin(coins, "OutActors", output=True))), g.pin(set_total, "Total"))
        g.then(begin, coins, set_total)
        g.check()
        compile_blueprint(gm)
    for k in ("BP_CoinGameMode", "BP_CoinHUD", "BP_Coin", "BP_Exit"):
        save_asset(load(paths[k]))
    return paths


# ---------- the play driver (scripted input in any build) ----------

DRIVER = "/Game/Harness/BP_HarnessDriver"
DRIVER_VERSION = 2


def play_driver(path=DRIVER):
    """An actor that runs a timeline of console commands given on the game's command line:
    -HarnessTimeline="0|Input.+key W;1500|Input.-key W;1600|HighResShot 1280x720". Each entry
    is <ms since the level started>|<console command>, at most one per frame. Without the
    argument it does nothing, so it can stay in a shipped level. It works in the editor's
    -game mode and in packaged Development builds, where no Python or Remote Control runs:
    Input.+key / Input.-key are Enhanced Input's own console commands (held each frame).
    With a timeline it also ignores mouse look, so the real mouse over the window cannot turn
    the scripted player. An older driver is rebuilt in place (its level instances stay)."""
    bp = create_blueprint(path, "Actor")
    try:
        if unreal.get_default_object(BEL.generated_class(bp)).get_editor_property("HarnessVersion") == DRIVER_VERSION:
            return bp
    except Exception:
        pass
    ed = event_graph(bp)
    old = list(ed.list_all_nodes())
    if old:
        ed.remove_nodes(old)
    add_variable(bp, "Entries", "array:string")
    add_variable(bp, "Index", "int", 0)
    add_variable(bp, "StartSeconds", "real", 0.0)
    add_variable(bp, "HarnessVersion", "int", DRIVER_VERSION)
    compile_blueprint(bp)
    g = Graph(bp)
    begin = g.event("ReceiveBeginPlay")
    cmdline = g.call(SYS + ":GetCommandLine")
    parse = g.call(SYS + ":ParseParamValue", InParam="HarnessTimeline=")
    g.wire(g.out(cmdline, "ReturnValue"), g.pin(parse, "InString"))
    split = g.call(STR + ":ParseIntoArray", Delimiter=";", CullEmptyStrings=True)
    g.wire(g.pin(parse, "OutValue", output=True), g.pin(split, "SourceString"))
    set_entries = g.setter("Entries")
    g.wire(g.out(split, "ReturnValue"), g.pin(set_entries, "Entries"))
    now = g.call(STATS + ":GetRealTimeSeconds")
    set_start = g.setter("StartSeconds")
    g.wire(g.out(now, "ReturnValue"), g.pin(set_start, "StartSeconds"))
    scripted = g.branch()
    g.wire(g.pin(parse, "ReturnValue", output=True), scripted.find_input_pin("Condition"))
    pc = g.call(STATS + ":GetPlayerController", PlayerIndex=0)
    no_look = g.call("/Script/Engine.Controller:SetIgnoreLookInput", bNewLookInput=True)
    g.wire(g.out(pc, "ReturnValue"), g.pin(no_look, "self"))
    say = g.call(SYS + ":PrintString", InString="HARNESS_EVENT driver ready", bPrintToScreen=False)
    g.flow(begin, cmdline, parse, split, set_entries, set_start, scripted)
    g.flow((scripted, "then"), pc, no_look, say)

    tick = g.event("ReceiveTick")
    less = g.call(MATH + ":Less_IntInt")
    g.wire(g.out(g.get("Index")), g.pin(less, "A"))
    g.wire(g.out(g.length(g.out(g.get("Entries")))), g.pin(less, "B"))
    more = g.branch()
    g.wire(g.out(less, "ReturnValue"), more.find_input_pin("Condition"))
    item = g.array_get(g.out(g.get("Entries")), g.out(g.get("Index")))
    cut = g.call(STR + ":Split", InStr="|")
    g.wire(list(item.list_output_pins())[0], g.pin(cut, "SourceString"))
    at_ms = g.call(STR + ":Conv_StringToDouble")
    g.wire(g.pin(cut, "LeftS", output=True), g.pin(at_ms, "InString"))
    elapsed = g.call(MATH + ":Subtract_DoubleDouble")
    g.wire(g.out(g.call(STATS + ":GetRealTimeSeconds"), "ReturnValue"), g.pin(elapsed, "A"))
    g.wire(g.out(g.get("StartSeconds")), g.pin(elapsed, "B"))
    elapsed_ms = g.call(MATH + ":Multiply_DoubleDouble")
    g.wire(g.out(elapsed, "ReturnValue"), g.pin(elapsed_ms, "A"))
    g.set(elapsed_ms, "B", 1000.0)
    due = g.call(MATH + ":LessEqual_DoubleDouble")
    g.wire(g.out(at_ms, "ReturnValue"), g.pin(due, "A"))
    g.wire(g.out(elapsed_ms, "ReturnValue"), g.pin(due, "B"))
    now_due = g.branch()
    g.wire(g.out(due, "ReturnValue"), now_due.find_input_pin("Condition"))
    run = g.call(SYS + ":ExecuteConsoleCommand")
    g.wire(g.pin(cut, "RightS", output=True), g.pin(run, "Command"))
    inc = g.call(MATH + ":Add_IntInt")
    g.wire(g.out(g.get("Index")), g.pin(inc, "A"))
    g.set(inc, "B", 1)
    set_idx = g.setter("Index")
    g.wire(g.out(inc, "ReturnValue"), g.pin(set_idx, "Index"))
    g.then(tick, more)
    g.then((more, "then"), now_due)
    g.flow((now_due, "then"), item, cut, run, set_idx)
    g.check()
    errors = compile_blueprint(bp)
    if errors:
        raise RuntimeError("the play driver does not compile: " + "; ".join(errors))
    unreal.get_default_object(BEL.generated_class(bp)).set_editor_property("HarnessVersion", DRIVER_VERSION)
    bp.set_editor_property("blueprint_description", "Runs -HarnessTimeline console commands (the harness's scripted play). Inert without it.")
    save_asset(bp)
    return bp


def ensure_play_driver(level=None, path=DRIVER):
    """Puts one play driver in a level (the open one by default), and a camera the harness's game
    captures move to where they look from (Python cannot spawn actors in a running game), and
    saves it."""
    if level:
        open_level(level)
    bp = play_driver(path)
    changed = False
    if not find_actors(cls=path):
        spawn(path, location=(0, 0, 0), label="HarnessDriver", folder="Harness")
        changed = True
    if not find_actors(label="HarnessCamera"):
        spawn("CameraActor", location=(0, 0, 500), label="HarnessCamera", folder="Harness")
        changed = True
    if changed:
        save()
    return bp


# ---------- 2D and 2.5D setups ----------

def side_scroller_setup(character="/Game/ThirdPerson/Blueprints/BP_ThirdPersonCharacter", ortho_width=1800.0, distance=1500.0):
    """Makes the template character a side-scroller: movement locked to the X-Z plane, the camera
    boom swung to the side, an orthographic camera. 2.5D: 3D art, 2D play."""
    bp = load(character)
    comps = components(bp)
    cdo = unreal.get_default_object(BEL.generated_class(bp))
    move = cdo.get_editor_property("character_movement")
    move.set_editor_property("constrain_to_plane", True)
    move.set_editor_property("plane_constraint_normal", unreal.Vector(0, 1, 0))
    move.set_editor_property("snap_to_plane_at_start", True)
    move.set_editor_property("orient_rotation_to_movement", True)
    boom = next((c for c in comps.values() if isinstance(c, unreal.SpringArmComponent)), None)
    cam = next((c for c in comps.values() if isinstance(c, unreal.CameraComponent)), None)
    if boom is not None:
        boom.set_editor_property("target_arm_length", float(distance))
        boom.set_editor_property("use_pawn_control_rotation", False)
        boom.set_editor_property("inherit_yaw", False)
        boom.set_editor_property("inherit_pitch", False)
        boom.set_editor_property("inherit_roll", False)
        boom.set_editor_property("do_collision_test", False)
        boom.set_editor_property("relative_rotation", unreal.Rotator(roll=0.0, pitch=0.0, yaw=-90.0))
    if cam is not None:
        cam.set_editor_property("projection_mode", unreal.CameraProjectionMode.ORTHOGRAPHIC)
        cam.set_editor_property("ortho_width", float(ortho_width))
    cdo.set_editor_property("use_controller_rotation_yaw", False)
    compile_blueprint(bp)
    save_asset(bp)
    return bp


def top_down_2d_setup(character="/Game/TopDown/Blueprints/BP_TopDownCharacter", ortho_width=3000.0):
    """Makes the top-down template's camera orthographic, looking straight down (a 2D view of a 3D world)."""
    bp = load(character)
    comps = components(bp)
    boom = next((c for c in comps.values() if isinstance(c, unreal.SpringArmComponent)), None)
    cam = next((c for c in comps.values() if isinstance(c, unreal.CameraComponent)), None)
    if boom is not None:
        boom.set_editor_property("relative_rotation", unreal.Rotator(roll=0.0, pitch=-90.0, yaw=0.0))
        boom.set_editor_property("do_collision_test", False)
    if cam is not None:
        cam.set_editor_property("projection_mode", unreal.CameraProjectionMode.ORTHOGRAPHIC)
        cam.set_editor_property("ortho_width", float(ortho_width))
    compile_blueprint(bp)
    save_asset(bp)
    return bp


# ---------- describing ----------

def describe_blueprint(bp):
    gen = BEL.generated_class(bp)
    info = {
        "path": bp.get_path_name().split(".")[0],
        "parent": BEL.get_blueprint_parent_class(bp).get_path_name() if BEL.get_blueprint_parent_class(bp) else None,
        "variables": [],
        "graphs": [str(n) for n in _safe(lambda: BEL.list_graph_names(bp), [])],
        "events": _safe(lambda: [n.get_node_title() for n in event_graph(bp).list_nodes_of_class(unreal.K2Node_Event)], []) if BEL.find_event_graph(bp) else [],
        "components": {k: v.get_class().get_name() for k, v in _safe(lambda: components(bp), {}).items()},
        "status": _plain(bp.get_editor_property("status")),
    }
    for name in _safe(lambda: BEL.list_member_variable_names(bp, False), []):
        t = _safe(lambda: BEL.get_member_variable_type(bp, str(name)), None)
        v = {"name": str(name)}
        if t is not None:
            v["type"] = _safe(lambda: _type_name(BEL.pin_type_to_json_schema(t, gen)), None)
        try:
            v["default"] = _plain(unreal.get_default_object(gen).get_editor_property(str(name)))
        except Exception:
            pass
        info["variables"].append(v)
    info["functions"] = [g for g in info["graphs"] if g not in ("EventGraph", "UserConstructionScript")]
    return info


def _type_name(schema):
    """A short type name from a pin type's JSON schema ("integer", "array of string", a class...)."""
    s = json.loads(schema) if isinstance(schema, str) else schema
    if not isinstance(s, dict):
        return str(s)
    if s.get("type") == "array" and isinstance(s.get("items"), dict):
        return "array of " + _type_name(s["items"])
    return s.get("title") or s.get("format") or s.get("type") or json.dumps(s)[:60]


def _path_text(v):
    """A soft object or class path as text."""
    for fn in ("export_text", "to_string"):
        if hasattr(v, fn):
            try:
                return str(getattr(v, fn)())
            except Exception:
                pass
    try:
        return unreal.SystemLibrary.conv_soft_obj_path_to_string(v)
    except Exception:
        return str(v)


def _safe(fn, default):
    try:
        return fn()
    except Exception:
        return default


def describe(levels_too=True, max_actors=300, blueprints=True, under="/Game"):
    """The project as data: levels, the open level's actors (class, transform, folder), assets
    under /Game by class, Blueprints with variables, functions and components, and settings."""
    reg = unreal.AssetRegistryHelpers.get_asset_registry()
    assets = reg.get_assets_by_path(under, recursive=True)
    by_class = {}
    level_paths = []
    bp_paths = []
    for a in assets:
        cls = str(a.asset_class_path.asset_name)
        by_class.setdefault(cls, []).append(str(a.package_name))
        if cls == "World":
            level_paths.append(str(a.package_name))
        if cls in ("Blueprint", "WidgetBlueprint"):
            bp_paths.append(str(a.package_name))
    out = {
        "engine": unreal.SystemLibrary.get_engine_version(),
        "project": unreal.Paths.get_project_file_path(),
        "levels": sorted(level_paths),
        "assets": {k: sorted(v)[:200] for k, v in sorted(by_class.items())},
        "assetCount": len(assets),
    }
    w = world()
    out["openLevel"] = w.get_path_name().split(".")[0]
    acts = []
    for a in actors().get_all_level_actors()[:max_actors]:
        acts.append({
            "label": a.get_actor_label(),
            "class": a.get_class().get_path_name(),
            "location": _plain(a.get_actor_location()),
            "rotation": _plain(a.get_actor_rotation()),
            "scale": _plain(a.get_actor_scale3d()),
            "folder": str(a.get_folder_path()),
        })
    out["actors"] = acts
    ws = w.get_world_settings()
    gm = ws.get_editor_property("default_game_mode")
    out["levelGameMode"] = gm.get_path_name() if gm else None
    maps = unreal.get_default_object(unreal.GameMapsSettings)
    out["settings"] = {
        "gameDefaultMap": _path_text(maps.get_editor_property("game_default_map")),
        "editorStartupMap": _path_text(maps.get_editor_property("editor_startup_map")),
        "globalDefaultGameMode": _path_text(maps.get_editor_property("global_default_game_mode")),
    }
    if blueprints:
        out["blueprints"] = []
        for p in sorted(bp_paths)[:60]:
            bp = load(p)
            if isinstance(bp, unreal.Blueprint):
                out["blueprints"].append(_safe(lambda: describe_blueprint(bp), {"path": p}))
    return out


# ---------- checking ----------

def check_project(levels_to_load=None):
    """Loads every level and compiles every Blueprint under /Game: the errors found."""
    errors = []
    reg = unreal.AssetRegistryHelpers.get_asset_registry()
    bps = [a for a in reg.get_assets_by_path("/Game", recursive=True) if str(a.asset_class_path.asset_name) in ("Blueprint", "WidgetBlueprint")]
    compiled = 0
    for a in bps:
        bp = load(str(a.package_name))
        if not isinstance(bp, unreal.Blueprint):
            continue
        try:
            BEL.compile_blueprint(bp)
            compiled += 1
            if bp.get_editor_property("status") == unreal.BlueprintStatus.BS_ERROR:
                errors.append("Blueprint %s does not compile" % a.package_name)
        except Exception as e:
            errors.append("Blueprint %s: %s" % (a.package_name, e))
    maps = levels_to_load
    if maps is None:
        maps = [str(a.package_name) for a in reg.get_assets_by_path("/Game", recursive=True) if str(a.asset_class_path.asset_name) == "World"]
    loaded = 0
    for m in maps[:20]:
        if not levels().load_level(m):
            errors.append("level %s does not load" % m)
        else:
            loaded += 1
    for e in errors:
        problem(e)
    return {"blueprints": compiled, "levels": loaded, "errors": errors}


# ---------- tests ----------

_checks = []


def check(name, ok, detail=""):
    """One functional-style check in Python (the test action collects them): passes when ok is truthy."""
    _checks.append({"name": str(name), "pass": bool(ok), "detail": str(detail)})
    if not ok:
        problem("check failed: %s %s" % (name, detail))
    return bool(ok)


def report_checks():
    result("checks", _checks)
    return _checks


def functional_test_count(path, actor_class, expected, what=None, level=None, location=(0, 0, 0), label=None):
    """A functional test (a Blueprint child of FunctionalTest) that passes when the level holds
    `expected` actors of a class, placed in the level so Automation finds it under
    'Project.Functional Tests.<level>.<label>'. Returns the test's label."""
    if level:
        open_level(level)
    if not EAL.does_asset_exist(path):
        bp = create_blueprint(path, "/Script/FunctionalTesting.FunctionalTest")
        g = Graph(bp)
        start = g.event("ReceiveStartTest")
        found = g.call(STATS + ":GetAllActorsOfClass", ActorClass=load_class(actor_class).get_path_name())
        count = g.length(g.pin(found, "OutActors", output=True))
        assert_ = g.call("/Script/FunctionalTesting.FunctionalTest:AssertEqual_Int", Expected=int(expected), What=what or ("%s count" % str(actor_class).rsplit("/", 1)[-1]))
        g.wire(g.out(count), g.pin(assert_, "Actual"))
        finish = g.call("/Script/FunctionalTesting.FunctionalTest:FinishTest", TestResult="Succeeded", Message="checked")
        g.flow(start, found, assert_, finish)
        g.check()
        errors = compile_blueprint(bp)
        if errors:
            raise RuntimeError("the functional test does not compile: " + "; ".join(errors))
        save_asset(bp)
    label = label or split_path(path)[1]
    delete_actors(find_actors(label=label))
    spawn(path, location=location, label=label, folder="Tests")
    save()
    return label


# ---------- captures and renders (run with rendering on) ----------

def _after_frames(frames, fn):
    """Calls fn() after that many editor ticks, then quits the editor (the script stays alive until then)."""
    unreal.EditorPythonScripting.set_keep_python_script_alive(True)
    state = {"n": 0}

    def tick(dt):
        state["n"] += 1
        if state["n"] < frames:
            return
        unreal.unregister_slate_post_tick_callback(state["handle"])
        try:
            fn()
        except Exception as e:
            problem("%s: %s" % (type(e).__name__, e))
            unreal.log_error(traceback.format_exc())
        unreal.SystemLibrary.quit_editor()

    state["handle"] = unreal.register_slate_post_tick_callback(tick)


def look_at_rotation(location, target):
    loc, tgt = vec(location), vec(target)
    return unreal.MathLibrary.find_look_at_rotation(loc, tgt)


def capture_editor(out_png, width=1280, height=720, camera=None, location=None, rotation=None, target=None, fov=70.0, level=None, frames=90, exposure=None):
    """Renders the level from a camera with a scene capture into a PNG (editor view: no player,
    no gameplay). camera: the label of a CameraActor in the level; else location and rotation
    (or target to look at). Several frames pass first so shaders and textures settle. Quits."""
    if level:
        open_level(level)
    w = world()
    if camera:
        cams = find_actors(label=camera)
        if not cams:
            raise ValueError("no actor labelled " + camera)
        location, rotation = cams[0].get_actor_location(), cams[0].get_actor_rotation()
        comp = cams[0].get_component_by_class(unreal.CameraComponent)
        if comp is not None:
            fov = comp.get_editor_property("field_of_view")
    if location is None:
        location = (-1500, -1500, 1200)
    if rotation is None:
        rotation = look_at_rotation(location, target or (0, 0, 0))
    cap = actors().spawn_actor_from_class(unreal.SceneCapture2D, vec(location), rot(rotation), True)
    comp = cap.capture_component2d
    rt = unreal.RenderingLibrary.create_render_target2d(w, int(width), int(height), unreal.TextureRenderTargetFormat.RTF_RGBA8_SRGB)
    comp.set_editor_property("texture_target", rt)
    comp.set_editor_property("capture_source", unreal.SceneCaptureSource.SCS_FINAL_COLOR_LDR)
    comp.set_editor_property("capture_every_frame", True)
    comp.set_editor_property("fov_angle", float(fov))
    if exposure is not None:
        pp = comp.get_editor_property("post_process_settings")
        pp.set_editor_property("override_auto_exposure_bias", True)
        pp.set_editor_property("auto_exposure_bias", float(exposure))
        comp.set_editor_property("post_process_settings", pp)
    folder, name = os.path.split(os.path.abspath(out_png))
    os.makedirs(folder, exist_ok=True)

    def shoot():
        comp.capture_scene()
        unreal.RenderingLibrary.export_render_target(w, rt, folder, name)
        actors().destroy_actor(cap)
        result("capture", {"file": os.path.join(folder, name), "location": vec(location), "rotation": rot(rotation)})

    _after_frames(frames, shoot)


def turntable_sequence(path="/Game/Harness/Render/LS_Turntable", target=(0, 0, 100), radius=800.0, height=300.0, seconds=6.0, fps=30, focal_length=24.0, level=None):
    """A Level Sequence with a cine camera orbiting target once: the camera, its transform keys
    and a camera cut. Returns the sequence asset."""
    if level:
        open_level(level)
    if EAL.does_asset_exist(path):
        EAL.delete_asset(path)
    folder, name = split_path(path)
    ls = asset_tools().create_asset(name, folder, unreal.LevelSequence, unreal.LevelSequenceFactoryNew())
    frames = int(round(seconds * fps))
    ls.set_display_rate(unreal.FrameRate(int(fps), 1))
    ls.set_tick_resolution(unreal.FrameRate(int(fps), 1))
    ls.set_playback_start(0)
    ls.set_playback_end(frames)
    delete_actors(find_actors(label="TurntableCam"))
    cam = spawn("CineCameraActor", location=(radius, 0, height), label="TurntableCam", folder="Harness")
    cine = cam.get_cine_camera_component()
    cine.set_editor_property("current_focal_length", float(focal_length))
    # Everything sharp: no depth of field.
    focus = cine.get_editor_property("focus_settings")
    focus.set_editor_property("focus_method", unreal.CameraFocusMethod.DISABLE)
    cine.set_editor_property("focus_settings", focus)
    binding = ls.add_possessable(cam)
    track = binding.add_track(unreal.MovieScene3DTransformTrack)
    section = track.add_section()
    section.set_range(0, frames)
    ch = section.get_all_channels()
    t = vec(target)
    steps = max(8, frames // 4)
    for i in range(steps + 1):
        f = int(round(frames * i / steps))
        a = 2.0 * math.pi * i / steps
        loc = unreal.Vector(t.x + radius * math.cos(a), t.y + radius * math.sin(a), t.z + height)
        r = unreal.MathLibrary.find_look_at_rotation(loc, t)
        fn = unreal.FrameNumber(f)
        for c, v in zip(ch[:6], (loc.x, loc.y, loc.z, r.roll, r.pitch, r.yaw)):
            c.add_key(fn, v)
    cut_track = ls.add_track(unreal.MovieSceneCameraCutTrack)
    cut = cut_track.add_section()
    cut.set_range(0, frames)
    cut.set_camera_binding_id(ls.get_binding_id(binding))
    save_asset(ls)
    save()
    return ls


def render_sequence(sequence, out_dir, width=1280, height=720, level=None, format="png", quit_after=True, motion_blur=False):
    """Renders a Level Sequence with Movie Render Queue (PIE executor) into out_dir as an image
    sequence ({sequence_name}.{frame_number}.png). Quits the editor when done."""
    lvl = level or current_level_path()
    subsystem = unreal.get_editor_subsystem(unreal.MoviePipelineQueueSubsystem)
    queue = subsystem.get_queue()
    for j in list(queue.get_jobs()):
        queue.delete_job(j)
    job = queue.allocate_new_job(unreal.MoviePipelineExecutorJob)
    seq_path = sequence.get_path_name() if isinstance(sequence, unreal.Object) else _map_object(sequence)
    job.set_editor_property("sequence", unreal.SoftObjectPath(seq_path))
    job.set_editor_property("map", unreal.SoftObjectPath(_map_object(lvl)))
    job.set_editor_property("job_name", "harness")
    config = job.get_configuration()
    out = config.find_or_add_setting_by_class(unreal.MoviePipelineOutputSetting)
    out.set_editor_property("output_directory", unreal.DirectoryPath(os.path.abspath(out_dir)))
    out.set_editor_property("output_resolution", unreal.IntPoint(int(width), int(height)))
    out.set_editor_property("file_name_format", "{sequence_name}.{frame_number}")
    out.set_editor_property("override_existing_output", True)
    config.find_or_add_setting_by_class(unreal.MoviePipelineDeferredPassBase)
    if not motion_blur:
        cvars = config.find_or_add_setting_by_class(unreal.MoviePipelineConsoleVariableSetting)
        cvars.add_or_update_console_variable("r.MotionBlurQuality", 0.0)
    fmt = {"png": unreal.MoviePipelineImageSequenceOutput_PNG, "jpg": unreal.MoviePipelineImageSequenceOutput_JPG, "exr": unreal.MoviePipelineImageSequenceOutput_EXR}[format]
    config.find_or_add_setting_by_class(fmt)
    unreal.EditorPythonScripting.set_keep_python_script_alive(True)
    executor = subsystem.render_queue_with_executor(unreal.MoviePipelinePIEExecutor)
    t0 = __import__("time").time()

    def finished(exec_, success):
        result("render", {"success": bool(success), "dir": os.path.abspath(out_dir), "seconds": round(__import__("time").time() - t0, 1)})
        if quit_after:
            unreal.SystemLibrary.quit_editor()

    executor.on_executor_finished_delegate.add_callable_unique(finished)
    _keep.append((executor, finished))
    return executor


_keep = []


# ---------- running a function and reporting ----------

def run(fn, *args, **kwargs):
    """Runs fn, reports its return value (tag 'result') or the error, and never raises."""
    try:
        value = fn(*args, **kwargs)
        result("result", value)
        return value
    except Exception as e:
        problem("%s: %s" % (type(e).__name__, e))
        unreal.log_error(traceback.format_exc())
        return None
