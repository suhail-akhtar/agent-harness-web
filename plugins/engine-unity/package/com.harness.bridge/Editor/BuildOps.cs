// A player build with BuildPipeline.BuildPlayer, its BuildReport turned into JSON: the
// result, size, time, errors and warnings per step. Missing build support (a module not
// installed in Unity Hub) is said as such before anything is built.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;

namespace Harness.Bridge.Editor
{
    public static class BuildOps
    {
        /// <summary>
        /// target (StandaloneWindows64 | WebGL | StandaloneLinux64 | StandaloneOSX), output (the .exe, or a folder for WebGL),
        /// development, scenes?, scriptingBackend? (Mono | IL2CPP), options? (BuildOptions names), webglCompression? (disabled | gzip | brotli).
        /// </summary>
        public static Dictionary<string, object> Build(Args a)
        {
            BuildTarget target;
            if (!Enum.TryParse(a.Str("target", "StandaloneWindows64"), true, out target)) throw new ArgumentException("target is a BuildTarget name: StandaloneWindows64, WebGL, StandaloneLinux64, StandaloneOSX");
            var group = BuildPipeline.GetBuildTargetGroup(target);
            if (!BuildPipeline.IsBuildTargetSupported(group, target))
                return Fail("module", "build support for " + target + " is not installed in this editor: add it in Unity Hub (Installs > " + UnityEngine.Application.unityVersion + " > Add modules: " + ModuleName(target) + ")");
            var output = a.Str("output");
            if (string.IsNullOrEmpty(output)) throw new ArgumentException("output is required (the .exe, or a folder for WebGL)");
            var scenes = a.Strings("scenes");
            if (scenes.Count == 0) scenes = EditorBuildSettings.scenes.Where(s => s.enabled).Select(s => s.path).ToList();
            if (scenes.Count == 0) return Fail("scenes", "no scenes to build: add one to the build settings (layout.build and project.create do), or pass scenes");
            var named = NamedBuildTarget.FromBuildTargetGroup(group);
            if (a.Has("scriptingBackend"))
            {
                var backend = a.Str("scriptingBackend").ToLowerInvariant() == "il2cpp" ? ScriptingImplementation.IL2CPP : ScriptingImplementation.Mono2x;
                PlayerSettings.SetScriptingBackend(named, backend);
            }
            if (target == BuildTarget.WebGL && a.Has("webglCompression"))
            {
                var c = a.Str("webglCompression").ToLowerInvariant();
                PlayerSettings.WebGL.compressionFormat = c == "brotli" ? WebGLCompressionFormat.Brotli : c == "gzip" ? WebGLCompressionFormat.Gzip : WebGLCompressionFormat.Disabled;
                PlayerSettings.WebGL.decompressionFallback = c != "disabled";
            }
            var options = a.Bool("development") ? BuildOptions.Development : BuildOptions.None;
            foreach (var o in a.Strings("options"))
            {
                BuildOptions flag;
                if (!Enum.TryParse(o, true, out flag)) throw new ArgumentException("unknown build option " + o);
                options |= flag;
            }
            Directory.CreateDirectory(target == BuildTarget.WebGL ? output : Path.GetDirectoryName(Path.GetFullPath(output)));
            var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions { scenes = scenes.ToArray(), locationPathName = output, target = target, targetGroup = group, options = options });
            return Report(report, target, scenes);
        }

        static string ModuleName(BuildTarget t)
        {
            switch (t)
            {
                case BuildTarget.WebGL: return "WebGL Build Support";
                case BuildTarget.StandaloneWindows64: case BuildTarget.StandaloneWindows: return "Windows Build Support (Mono or IL2CPP)";
                case BuildTarget.StandaloneLinux64: return "Linux Build Support";
                case BuildTarget.StandaloneOSX: return "Mac Build Support";
                default: return t + " Build Support";
            }
        }

        static Dictionary<string, object> Fail(string kind, string error)
        {
            return new Dictionary<string, object> { { "ok", false }, { "result", "Failed" }, { "kind", kind }, { "error", error } };
        }

        static Dictionary<string, object> Report(BuildReport report, BuildTarget target, List<string> scenes)
        {
            var s = report.summary;
            var steps = new List<object>();
            foreach (var step in report.steps)
            {
                var messages = step.messages.Where(m => m.type != UnityEngine.LogType.Log).Take(50)
                    .Select(m => (object)new Dictionary<string, object> { { "type", m.type.ToString() }, { "content", m.content.Length > 2000 ? m.content.Substring(0, 2000) : m.content } }).ToList();
                steps.Add(new Dictionary<string, object> { { "name", step.name }, { "durationS", Math.Round(step.duration.TotalSeconds, 2) }, { "messages", messages } });
            }
            return new Dictionary<string, object>
            {
                { "ok", s.result == BuildResult.Succeeded }, { "result", s.result.ToString() }, { "target", target.ToString() },
                { "outputPath", s.outputPath }, { "totalSize", (double)s.totalSize }, { "totalTimeS", Math.Round(s.totalTime.TotalSeconds, 1) },
                { "totalErrors", s.totalErrors }, { "totalWarnings", s.totalWarnings }, { "scenes", scenes }, { "steps", steps },
                { "unity", UnityEngine.Application.unityVersion },
            };
        }
    }
}
