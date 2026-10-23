// Running C# the agent wrote: a public static method (Harness.Scripts.Name.Run by default)
// in a script under Assets/ that Unity compiled. What it returns is reported as JSON; an
// exception is reported with its stack (file and line).

using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using UnityEditor;

namespace Harness.Bridge.Editor
{
    public static class ScriptOps
    {
        public static Dictionary<string, object> Invoke(Args a)
        {
            var name = a.Str("method");
            if (string.IsNullOrEmpty(name) || name.LastIndexOf('.') < 1) throw new ArgumentException("method is Namespace.Class.Method, e.g. Harness.Scripts.MakeLevel.Run");
            if (EditorApplication.isCompiling) throw new InvalidOperationException("Unity is compiling scripts: ask again when compile.status says it is done");
            var typeName = name.Substring(0, name.LastIndexOf('.'));
            var methodName = name.Substring(name.LastIndexOf('.') + 1);
            Type type = null;
            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                type = asm.GetType(typeName);
                if (type != null) break;
            }
            if (type == null) throw new ArgumentException("no class " + typeName + " in the compiled scripts: check compile.status for errors, or the namespace and class name");
            var method = type.GetMethods(BindingFlags.Public | BindingFlags.Static).Where(m => m.Name == methodName).OrderBy(m => m.GetParameters().Length).FirstOrDefault();
            if (method == null) throw new ArgumentException(typeName + " has no public static method " + methodName);
            var ps = method.GetParameters();
            object[] call;
            if (ps.Length == 0) call = new object[0];
            else if (ps.Length == 1 && ps[0].ParameterType == typeof(string)) call = new object[] { a.Str("arg", Json.Write(a.Raw("args"))) };
            else if (ps.Length == 1 && ps[0].ParameterType.IsAssignableFrom(typeof(Dictionary<string, object>))) call = new object[] { a.Raw("args") as Dictionary<string, object> ?? new Dictionary<string, object>() };
            else throw new ArgumentException(name + " must take no parameters, one string, or one Dictionary<string, object>");
            var started = DateTime.UtcNow;
            object value;
            try { value = method.Invoke(null, call); }
            catch (TargetInvocationException e)
            {
                // The script's own exception, with its stack (file and line) kept.
                if (e.InnerException != null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(e.InnerException).Throw();
                throw;
            }
            return new Dictionary<string, object> { { "method", name }, { "value", Simple(value) }, { "tookMs", Math.Round((DateTime.UtcNow - started).TotalMilliseconds) } };
        }

        /// <summary>A value as JSON can carry it (Unity objects by name and path).</summary>
        static object Simple(object v)
        {
            var o = v as UnityEngine.Object;
            if (o != null)
            {
                var path = AssetDatabase.GetAssetPath(o);
                var go = o as UnityEngine.GameObject;
                return new Dictionary<string, object> { { "type", o.GetType().Name }, { "name", o.name }, { "path", string.IsNullOrEmpty(path) ? (go != null ? SceneTools.PathOf(go.transform) : null) : path } };
            }
            return v;
        }
    }
}
