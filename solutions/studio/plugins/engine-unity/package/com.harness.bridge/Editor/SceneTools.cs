// Finding and describing scene objects for the bridge and the batch entry points: objects
// by path ("Level/Player") or id ("#12345"), the hierarchy as JSON, component types by
// name, and setting serialized properties from JSON values.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using Object = UnityEngine.Object;

namespace Harness.Bridge.Editor
{
    public static class SceneTools
    {
        /// <summary>A GameObject in the open scenes by "Root/Child/Name", or by "#instanceId". Inactive ones too.</summary>
        public static GameObject Find(string path)
        {
            if (string.IsNullOrEmpty(path)) return null;
            if (path[0] == '#')
            {
                int id;
                if (int.TryParse(path.Substring(1), out id)) return EditorUtility.InstanceIDToObject(id) as GameObject;
                return null;
            }
            var parts = path.Trim('/').Split('/');
            for (int s = 0; s < SceneManager.sceneCount; s++)
            {
                var scene = SceneManager.GetSceneAt(s);
                if (!scene.isLoaded) continue;
                foreach (var root in scene.GetRootGameObjects())
                {
                    if (root.name != parts[0]) continue;
                    var t = root.transform;
                    for (int i = 1; i < parts.Length && t != null; i++) t = Child(t, parts[i]);
                    if (t != null) return t.gameObject;
                }
            }
            return null;
        }

        public static GameObject Require(string path)
        {
            var go = Find(path);
            if (go == null) throw new ArgumentException("no GameObject \"" + path + "\" in the open scenes (paths are Root/Child/Name; scene.hierarchy lists them)");
            return go;
        }

        static Transform Child(Transform t, string name)
        {
            for (int i = 0; i < t.childCount; i++) if (t.GetChild(i).name == name) return t.GetChild(i);
            return null;
        }

        public static string PathOf(Transform t)
        {
            var names = new List<string>();
            for (var x = t; x != null; x = x.parent) names.Add(x.name);
            names.Reverse();
            return string.Join("/", names.ToArray());
        }

        static List<object> V(Vector3 v) { return new List<object> { Math.Round(v.x, 3), Math.Round(v.y, 3), Math.Round(v.z, 3) }; }

        /// <summary>One object as JSON, with its children to `depth` (a budget caps the whole tree).</summary>
        public static Dictionary<string, object> Node(GameObject go, int depth, ref int budget, bool details)
        {
            budget--;
            var t = go.transform;
            var d = new Dictionary<string, object>
            {
                { "name", go.name }, { "id", "#" + go.GetInstanceID() }, { "active", go.activeSelf },
                { "position", V(t.localPosition) }, { "rotation", V(t.localEulerAngles) }, { "scale", V(t.localScale) },
                { "components", go.GetComponents<Component>().Where(c => c != null && !(c is Transform)).Select(c => (object)c.GetType().Name).ToList() },
            };
            if (go.tag != "Untagged") d["tag"] = go.tag;
            if (go.layer != 0) d["layer"] = LayerMask.LayerToName(go.layer);
            if (PrefabUtility.IsPartOfPrefabInstance(go) && PrefabUtility.GetOutermostPrefabInstanceRoot(go) == go)
                d["prefab"] = PrefabUtility.GetPrefabAssetPathOfNearestInstanceRoot(go);
            if (details)
            {
                d["worldPosition"] = V(t.position);
                d["path"] = PathOf(t);
                var r = go.GetComponent<Renderer>();
                if (r != null) d["bounds"] = new Dictionary<string, object> { { "center", V(r.bounds.center) }, { "size", V(r.bounds.size) } };
            }
            if (t.childCount > 0)
            {
                if (depth <= 0 || budget <= 0) d["childCount"] = t.childCount;
                else
                {
                    var kids = new List<object>();
                    for (int i = 0; i < t.childCount && budget > 0; i++) kids.Add(Node(t.GetChild(i).gameObject, depth - 1, ref budget, details));
                    d["children"] = kids;
                    if (kids.Count < t.childCount) d["childCount"] = t.childCount;
                }
            }
            return d;
        }

        /// <summary>The open scenes and their objects.</summary>
        public static Dictionary<string, object> Hierarchy(int depth, int max, bool details)
        {
            int budget = Mathf.Clamp(max, 1, 20000);
            var scenes = new List<object>();
            for (int s = 0; s < SceneManager.sceneCount; s++)
            {
                var scene = SceneManager.GetSceneAt(s);
                if (!scene.isLoaded) continue;
                var roots = new List<object>();
                foreach (var go in scene.GetRootGameObjects()) { if (budget <= 0) break; roots.Add(Node(go, depth, ref budget, details)); }
                scenes.Add(new Dictionary<string, object> { { "name", scene.name }, { "path", scene.path }, { "dirty", scene.isDirty }, { "active", scene == SceneManager.GetActiveScene() }, { "objects", roots } });
            }
            return new Dictionary<string, object> { { "scenes", scenes }, { "truncated", budget <= 0 } };
        }

        static Dictionary<string, Type> typeCache;

        /// <summary>A Component type by name ("Rigidbody", "UnityEngine.Rigidbody", "Harness.Bridge.HarnessCollectible").</summary>
        public static Type ComponentType(string name)
        {
            if (typeCache == null)
            {
                typeCache = new Dictionary<string, Type>(StringComparer.OrdinalIgnoreCase);
                foreach (var t in TypeCache.GetTypesDerivedFrom<Component>())
                {
                    if (t.IsAbstract || t.IsGenericType) continue;
                    typeCache[t.FullName] = t;
                    if (!typeCache.ContainsKey(t.Name) || t.Namespace == "UnityEngine") typeCache[t.Name] = t;
                }
            }
            Type found;
            if (typeCache.TryGetValue(name, out found)) return found;
            throw new ArgumentException("no component type \"" + name + "\" (a class deriving from Component; scripts must compile first)");
        }

        public static Component GetComponent(GameObject go, string type)
        {
            var c = go.GetComponent(ComponentType(type));
            if (c == null) throw new ArgumentException(go.name + " has no " + type + " (it has " + string.Join(", ", go.GetComponents<Component>().Where(x => x != null).Select(x => x.GetType().Name).ToArray()) + ")");
            return c;
        }

        /// <summary>Sets a serialized field ("m_Mass" or "mass", a public field of a script) from a JSON value.</summary>
        public static void SetProperty(Object target, string name, object value)
        {
            var so = new SerializedObject(target);
            var p = so.FindProperty(name);
            if (p == null && name.Length > 0) p = so.FindProperty("m_" + char.ToUpperInvariant(name[0]) + name.Substring(1));
            if (p == null)
            {
                var names = new List<string>();
                var it = so.GetIterator();
                for (bool enter = true; it.NextVisible(enter); enter = false) names.Add(it.name);
                throw new ArgumentException(target.GetType().Name + " has no serialized property \"" + name + "\" (it has " + string.Join(", ", names.ToArray()) + ")");
            }
            Assign(p, value);
            so.ApplyModifiedProperties();
        }

        static float F(object v) { return Convert.ToSingle(v, CultureInfo.InvariantCulture); }

        static void Assign(SerializedProperty p, object v)
        {
            switch (p.propertyType)
            {
                case SerializedPropertyType.Integer: p.intValue = Convert.ToInt32(v, CultureInfo.InvariantCulture); break;
                case SerializedPropertyType.LayerMask: p.intValue = v is string ? LayerMask.GetMask(((string)v).Split(',')) : Convert.ToInt32(v, CultureInfo.InvariantCulture); break;
                case SerializedPropertyType.Boolean: p.boolValue = Convert.ToBoolean(v, CultureInfo.InvariantCulture); break;
                case SerializedPropertyType.Float: p.floatValue = F(v); break;
                case SerializedPropertyType.String: p.stringValue = Convert.ToString(v, CultureInfo.InvariantCulture); break;
                case SerializedPropertyType.Color: p.colorValue = Args.ToColor(v, p.colorValue); break;
                case SerializedPropertyType.Vector2: { var x = Args.ToVec3(v, p.vector2Value); p.vector2Value = new Vector2(x.x, x.y); break; }
                case SerializedPropertyType.Vector3: p.vector3Value = Args.ToVec3(v, p.vector3Value); break;
                case SerializedPropertyType.Vector4:
                    {
                        var l = v as List<object>;
                        if (l == null || l.Count < 4) throw new ArgumentException(p.name + " is [x, y, z, w]");
                        p.vector4Value = new Vector4(F(l[0]), F(l[1]), F(l[2]), F(l[3]));
                        break;
                    }
                case SerializedPropertyType.Quaternion: p.quaternionValue = Quaternion.Euler(Args.ToVec3(v, p.quaternionValue.eulerAngles)); break;
                case SerializedPropertyType.Enum:
                    if (v is string)
                    {
                        int i = Array.FindIndex(p.enumNames, n => string.Equals(n, (string)v, StringComparison.OrdinalIgnoreCase));
                        if (i < 0) i = Array.FindIndex(p.enumDisplayNames, n => string.Equals(n, (string)v, StringComparison.OrdinalIgnoreCase));
                        if (i < 0) throw new ArgumentException(p.name + " is one of " + string.Join(", ", p.enumNames));
                        p.enumValueIndex = i;
                    }
                    else p.enumValueIndex = Convert.ToInt32(v, CultureInfo.InvariantCulture);
                    break;
                case SerializedPropertyType.ObjectReference:
                    p.objectReferenceValue = Reference(v as string);
                    break;
                default:
                    throw new ArgumentException(p.name + " is a " + p.propertyType + ", which the bridge does not set; write a script for it");
            }
        }

        /// <summary>An asset ("Assets/...") or a scene object ("scene:Root/Child") for an object field; null clears it.</summary>
        public static Object Reference(string s)
        {
            if (string.IsNullOrEmpty(s)) return null;
            if (s.StartsWith("scene:")) return Require(s.Substring(6));
            var a = AssetDatabase.LoadMainAssetAtPath(s);
            if (a == null) throw new ArgumentException("no asset at " + s);
            return a;
        }

        public static void Dirty(GameObject go)
        {
            if (!Application.isPlaying) EditorSceneManager.MarkSceneDirty(go.scene);
        }

        /// <summary>The bounds of every renderer in the open scenes (a unit box at the origin when there are none).</summary>
        public static Bounds SceneBounds()
        {
            bool any = false;
            var b = new Bounds(Vector3.zero, Vector3.one);
            foreach (var r in Object.FindObjectsByType<Renderer>(FindObjectsSortMode.None))
            {
                if (!r.enabled || !r.gameObject.activeInHierarchy) continue;
                if (!any) { b = r.bounds; any = true; } else b.Encapsulate(r.bounds);
            }
            return b;
        }
    }
}
