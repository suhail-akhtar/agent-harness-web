// The live bridge's operations: a fixed menu of safe, typed edits (no arbitrary code is
// evaluated from a request). Code the agent writes goes into Assets/Editor/Harness/ as a
// file, compiles like any script, and runs through script.invoke. Every change in edit mode
// is recorded for Undo, so the person can step back with Ctrl+Z.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using Object = UnityEngine.Object;

namespace Harness.Bridge.Editor
{
    public static class BridgeOps
    {
        public static void RegisterAll(HarnessServer s)
        {
            s.Register("status", Status);
            s.Register("console.read", a => new Dictionary<string, object> { { "entries", EditorBridge.ConsoleEntries(a.Str("level", "all"), a.Int("max", 200)) } });
            s.Register("console.clear", a => { EditorBridge.ClearConsole(); return HarnessVoid.Value; });
            s.Register("compile.status", a => new Dictionary<string, object> { { "compiling", EditorApplication.isCompiling }, { "updating", EditorApplication.isUpdating }, { "messages", EditorBridge.CompileMessages() } });
            s.Register("assets.refresh", Refresh);
            s.Register("describe", a => Describe.Project(a));
            s.Register("scene.hierarchy", a => SceneTools.Hierarchy(a.Int("depth", 6), a.Int("max", 2000), a.Bool("details", false)));
            s.Register("scene.open", SceneOpen);
            s.Register("scene.new", SceneNew);
            s.Register("scene.save", SceneSave);
            s.Register("object.get", ObjectGet);
            s.Register("object.create", ObjectCreate);
            s.Register("object.modify", ObjectModify);
            s.Register("object.delete", ObjectDelete);
            s.Register("component.add", a => { var go = SceneTools.Require(a.Str("path")); var c = Undo.AddComponent(go, SceneTools.ComponentType(a.Str("component"))); SceneTools.Dirty(go); return new Dictionary<string, object> { { "added", c.GetType().Name } }; });
            s.Register("component.remove", a => { var go = SceneTools.Require(a.Str("path")); Undo.DestroyObjectImmediate(SceneTools.GetComponent(go, a.Str("component"))); SceneTools.Dirty(go); return HarnessVoid.Value; });
            s.Register("component.set", ComponentSet);
            s.Register("component.get", ComponentGet);
            s.Register("prefab.create", PrefabCreate);
            s.Register("prefab.instantiate", a => ObjectCreate(a));
            s.Register("selection.get", a => new Dictionary<string, object> { { "objects", Selection.gameObjects.Select(g => (object)SceneTools.PathOf(g.transform)).ToList() }, { "assets", Selection.assetGUIDs.Select(g => (object)AssetDatabase.GUIDToAssetPath(g)).ToList() } });
            s.Register("selection.set", a => { Selection.objects = a.Strings("paths").Select(p => p.StartsWith("Assets/") ? AssetDatabase.LoadMainAssetAtPath(p) : (Object)SceneTools.Find(p)).Where(o => o != null).ToArray(); return HarnessVoid.Value; });
            s.Register("script.invoke", a => ScriptOps.Invoke(a));
            s.Register("layout.build", a => { RequireEditMode(); RequireClean(a); return LevelBuilder.Build(a, true); });
            s.Register("assets.import", a => { RequireEditMode(); return AssetOps.ImportLive(a); });
            s.Register("assets.export", a => AssetOps.ExportLive(a));
            s.Register("capture", Capture);
            s.Register("render.views", a => { RequireEditMode(); return CaptureOps.Render(a); });
            // A build in the open editor holds it until done, as File > Build does.
            s.Register("build", a => { RequireEditMode(); return BuildOps.Build(a); });
            s.Register("play.enter", a => PlayRunner.Enter(a));
            s.Register("play.exit", a => PlayRunner.Exit());
            s.Register("play.status", a => PlayRunner.Status());
            s.Register("play.run", a => PlayRunner.StartLive(a));
            s.Register("play.result", a => PlayRunner.Result(a.Str("id")));
            s.Register("play.step", a => RequirePlayback().Step(a));
            s.Register("play.observe", a => RequirePlayback().Observe(a));
            s.Register("play.state", a => new Dictionary<string, object> { { "state", HarnessState.Snapshot() }, { "events", HarnessState.EventsSince(a.Int("after", 0)) } });
        }

        static object Status(Args a)
        {
            var scene = SceneManager.GetActiveScene();
            return new Dictionary<string, object>
            {
                { "bridge", EditorBridge.Version }, { "unity", Application.unityVersion }, { "project", EditorBridge.ProjectRoot.Replace('\\', '/') },
                { "product", PlayerSettings.productName }, { "scene", scene.path }, { "sceneDirty", scene.isDirty },
                { "playing", EditorApplication.isPlaying }, { "paused", EditorApplication.isPaused }, { "compiling", EditorApplication.isCompiling },
                { "updating", EditorApplication.isUpdating }, { "buildTarget", EditorUserBuildSettings.activeBuildTarget.ToString() },
                { "renderPipeline", UnityEngine.Rendering.GraphicsSettings.currentRenderPipeline == null ? "Built-in" : UnityEngine.Rendering.GraphicsSettings.currentRenderPipeline.GetType().Name },
                { "selection", Selection.gameObjects.Select(g => (object)SceneTools.PathOf(g.transform)).ToList() },
            };
        }

        static void RequireEditMode()
        {
            if (EditorApplication.isPlayingOrWillChangePlaymode) throw new InvalidOperationException("the editor is in play mode: changes there are lost when it stops; play.exit first");
        }

        static void RequireClean(Args a)
        {
            var scene = SceneManager.GetActiveScene();
            if (scene.isDirty && !a.Bool("discard")) throw new InvalidOperationException("the open scene \"" + scene.name + "\" has unsaved changes: save it first (scene.save), or pass discard: true");
        }

        static HarnessPlayback RequirePlayback()
        {
            if (!EditorApplication.isPlaying) throw new InvalidOperationException("not in play mode: play.enter first (stepMode: true pauses the game between steps)");
            return HarnessPlayback.Ensure();
        }

        static object Refresh(Args a)
        {
            AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
            // When scripts changed, Unity compiles and reloads now: the connection drops; compile.status answers after it.
            return new Dictionary<string, object> { { "compiling", EditorApplication.isCompiling }, { "messages", EditorBridge.CompileMessages() } };
        }

        static object SceneOpen(Args a)
        {
            RequireEditMode();
            var path = a.Str("path");
            if (string.IsNullOrEmpty(path) || !File.Exists(Path.Combine(EditorBridge.ProjectRoot, path))) throw new ArgumentException("no scene at " + path);
            bool additive = a.Str("mode", "single") == "additive";
            if (!additive) RequireClean(a);
            var scene = EditorSceneManager.OpenScene(path, additive ? OpenSceneMode.Additive : OpenSceneMode.Single);
            return new Dictionary<string, object> { { "scene", scene.path }, { "roots", scene.rootCount } };
        }

        static object SceneNew(Args a)
        {
            RequireEditMode();
            RequireClean(a);
            var path = a.Str("path");
            var scene = EditorSceneManager.NewScene(a.Str("setup", "default") == "empty" ? NewSceneSetup.EmptyScene : NewSceneSetup.DefaultGameObjects, NewSceneMode.Single);
            if (!string.IsNullOrEmpty(path))
            {
                Directory.CreateDirectory(Path.GetDirectoryName(Path.Combine(EditorBridge.ProjectRoot, path)));
                EditorSceneManager.SaveScene(scene, path);
            }
            return new Dictionary<string, object> { { "scene", scene.path } };
        }

        static object SceneSave(Args a)
        {
            RequireEditMode();
            var scene = SceneManager.GetActiveScene();
            var path = a.Str("path", scene.path);
            if (string.IsNullOrEmpty(path)) throw new ArgumentException("the scene was never saved: pass path, e.g. Assets/Scenes/Main.unity");
            Directory.CreateDirectory(Path.GetDirectoryName(Path.Combine(EditorBridge.ProjectRoot, path)));
            if (!EditorSceneManager.SaveScene(scene, path)) throw new InvalidOperationException("Unity did not save " + path);
            if (a.Bool("addToBuild")) ProjectSetup.AddToBuild(path, false);
            return new Dictionary<string, object> { { "saved", path } };
        }

        static object ObjectGet(Args a)
        {
            var go = SceneTools.Require(a.Str("path"));
            int budget = 500;
            var d = SceneTools.Node(go, a.Int("depth", 1), ref budget, true);
            if (a.Bool("properties", true))
            {
                var comps = new List<object>();
                foreach (var c in go.GetComponents<Component>()) if (c != null) comps.Add(Properties(c, a.Int("maxProperties", 40)));
                d["properties"] = comps;
            }
            return d;
        }

        /// <summary>A component's visible serialized properties (name, type, value as text).</summary>
        static Dictionary<string, object> Properties(Component c, int max)
        {
            var props = new Dictionary<string, object>();
            var so = new SerializedObject(c);
            var it = so.GetIterator();
            for (bool enter = true; it.NextVisible(enter) && props.Count < max; enter = false)
            {
                if (it.name == "m_Script") continue;
                props[it.name] = Value(it);
            }
            return new Dictionary<string, object> { { "type", c.GetType().Name }, { "properties", props } };
        }

        static object Value(SerializedProperty p)
        {
            switch (p.propertyType)
            {
                case SerializedPropertyType.Integer: return p.intValue;
                case SerializedPropertyType.Boolean: return p.boolValue;
                case SerializedPropertyType.Float: return Math.Round(p.floatValue, 4);
                case SerializedPropertyType.String: return p.stringValue;
                case SerializedPropertyType.Color: return p.colorValue;
                case SerializedPropertyType.Vector2: return p.vector2Value;
                case SerializedPropertyType.Vector3: return p.vector3Value;
                case SerializedPropertyType.Quaternion: return p.quaternionValue.eulerAngles;
                case SerializedPropertyType.Enum: return p.enumValueIndex >= 0 && p.enumValueIndex < p.enumNames.Length ? p.enumNames[p.enumValueIndex] : p.intValue.ToString();
                case SerializedPropertyType.ObjectReference:
                    if (p.objectReferenceValue == null) return null;
                    var path = AssetDatabase.GetAssetPath(p.objectReferenceValue);
                    return string.IsNullOrEmpty(path) ? p.objectReferenceValue.name : path;
                default: return p.propertyType.ToString();
            }
        }

        static object ComponentGet(Args a)
        {
            var go = SceneTools.Require(a.Str("path"));
            return Properties(SceneTools.GetComponent(go, a.Str("component")), a.Int("maxProperties", 200));
        }

        static object ComponentSet(Args a)
        {
            var go = SceneTools.Require(a.Str("path"));
            var c = SceneTools.GetComponent(go, a.Str("component"));
            Undo.RecordObject(c, "Harness: set " + a.Str("property"));
            var values = a.Raw("values") as Dictionary<string, object>;
            if (values == null) values = new Dictionary<string, object> { { a.Str("property"), a.Raw("value") } };
            foreach (var kv in values) SceneTools.SetProperty(c, kv.Key, kv.Value);
            SceneTools.Dirty(go);
            return Properties(c, 60);
        }

        /// <summary>A new object: a primitive, a prefab instance or an empty one, placed and given components.</summary>
        public static object ObjectCreate(Args a)
        {
            GameObject go;
            var prefab = a.Str("prefab");
            var primitive = a.Str("primitive");
            if (!string.IsNullOrEmpty(prefab))
            {
                var asset = AssetDatabase.LoadAssetAtPath<GameObject>(prefab);
                if (asset == null) throw new ArgumentException("no prefab at " + prefab);
                go = (GameObject)PrefabUtility.InstantiatePrefab(asset);
            }
            else if (!string.IsNullOrEmpty(primitive))
            {
                PrimitiveType type;
                if (!Enum.TryParse(primitive, true, out type)) throw new ArgumentException("primitive is one of " + string.Join(", ", Enum.GetNames(typeof(PrimitiveType))));
                go = GameObject.CreatePrimitive(type);
            }
            else go = new GameObject();
            if (a.Has("name")) go.name = a.Str("name");
            if (a.Has("parent")) go.transform.SetParent(SceneTools.Require(a.Str("parent")).transform, false);
            Place(go, a);
            foreach (var c in a.Strings("components")) go.AddComponent(SceneTools.ComponentType(c));
            if (a.Has("color")) Tint(go, Args.ToColor(a.Raw("color"), Color.white));
            if (!Application.isPlaying) Undo.RegisterCreatedObjectUndo(go, "Harness: create " + go.name);
            SceneTools.Dirty(go);
            int budget = 50;
            return SceneTools.Node(go, 1, ref budget, true);
        }

        static void Place(GameObject go, Args a)
        {
            var t = go.transform;
            if (a.Has("position")) t.localPosition = a.Vec3("position", t.localPosition);
            if (a.Has("rotation")) t.localEulerAngles = a.Vec3("rotation", t.localEulerAngles);
            if (a.Has("scale")) t.localScale = a.Vec3("scale", t.localScale);
        }

        /// <summary>Gives an object a coloured material saved under Assets/Harness/Generated/Materials (or tints its sprite).</summary>
        public static void Tint(GameObject go, Color c)
        {
            var sr = go.GetComponent<SpriteRenderer>();
            if (sr != null) { sr.color = c; return; }
            var r = go.GetComponent<Renderer>();
            if (r != null) r.sharedMaterial = LevelBuilder.MakeMaterial("Tint_" + ColorUtility.ToHtmlStringRGB(c), c);
        }

        static object ObjectModify(Args a)
        {
            var go = SceneTools.Require(a.Str("path"));
            Undo.RecordObject(go, "Harness: modify " + go.name);
            Undo.RecordObject(go.transform, "Harness: move " + go.name);
            if (a.Has("name")) go.name = a.Str("name");
            if (a.Has("active")) go.SetActive(a.Bool("active"));
            if (a.Has("tag")) go.tag = a.Str("tag");
            if (a.Has("layer")) go.layer = LayerMask.NameToLayer(a.Str("layer"));
            if (a.Has("parent"))
            {
                var p = a.Str("parent");
                Undo.SetTransformParent(go.transform, string.IsNullOrEmpty(p) || p == "/" ? null : SceneTools.Require(p).transform, "Harness: parent " + go.name);
            }
            Place(go, a);
            foreach (var c in a.Strings("addComponents")) Undo.AddComponent(go, SceneTools.ComponentType(c));
            foreach (var c in a.Strings("removeComponents")) Undo.DestroyObjectImmediate(SceneTools.GetComponent(go, c));
            if (a.Has("color")) Tint(go, Args.ToColor(a.Raw("color"), Color.white));
            foreach (var x in a.List("set"))
            {
                var s = new Args(x as Dictionary<string, object>);
                var comp = SceneTools.GetComponent(go, s.Str("component"));
                Undo.RecordObject(comp, "Harness: set " + s.Str("property"));
                SceneTools.SetProperty(comp, s.Str("property"), s.Raw("value"));
            }
            SceneTools.Dirty(go);
            int budget = 50;
            return SceneTools.Node(go, 1, ref budget, true);
        }

        static object ObjectDelete(Args a)
        {
            var go = SceneTools.Require(a.Str("path"));
            var scene = go.scene;
            Undo.DestroyObjectImmediate(go);
            if (!Application.isPlaying) EditorSceneManager.MarkSceneDirty(scene);
            return HarnessVoid.Value;
        }

        static object PrefabCreate(Args a)
        {
            RequireEditMode();
            var go = SceneTools.Require(a.Str("path"));
            var output = a.Str("out", "Assets/Prefabs/" + go.name + ".prefab");
            if (!output.StartsWith("Assets/") || !output.EndsWith(".prefab")) throw new ArgumentException("out is a path like Assets/Prefabs/Door.prefab");
            Directory.CreateDirectory(Path.GetDirectoryName(Path.Combine(EditorBridge.ProjectRoot, output)));
            bool ok;
            if (a.Bool("connect", true)) PrefabUtility.SaveAsPrefabAssetAndConnect(go, output, InteractionMode.UserAction, out ok);
            else PrefabUtility.SaveAsPrefabAsset(go, output, out ok);
            if (!ok) throw new InvalidOperationException("Unity did not save the prefab " + output);
            return new Dictionary<string, object> { { "prefab", output } };
        }

        static object Capture(Args a)
        {
            if (EditorApplication.isPlaying) return HarnessPlayback.Ensure().Observe(a);
            var r = CaptureOps.Capture(a);
            return r;
        }
    }
}
