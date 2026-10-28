// The live bridge in the open editor. It starts with the editor (and after every script
// reload), listens on 127.0.0.1 only, and writes Library/HarnessBridge/bridge.json with
// its port and a random token; the harness reads that file from the project folder and
// sends the token with every request. Nothing else can reach it, and it stops with the
// editor. In batch mode it starts only when the command line has -harnessBridge.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using UnityEditor;
using UnityEditor.Compilation;
using UnityEngine;
using Debug = UnityEngine.Debug;

namespace Harness.Bridge.Editor
{
    [InitializeOnLoad]
    public static class EditorBridge
    {
        public const string Version = "1.0.0";
        static HarnessServer server;
        static readonly List<Dictionary<string, object>> console = new List<Dictionary<string, object>>();
        static readonly object consoleGate = new object();
        static readonly Dictionary<string, HarnessServer.Handler> extra = new Dictionary<string, HarnessServer.Handler>();
        const int ConsoleMax = 1000;
        const string ConsoleKey = "harness.console";
        const string CompileKey = "harness.compile";

        public static string ProjectRoot { get { return Directory.GetParent(Application.dataPath).FullName; } }
        public static string BridgeDir { get { return Path.Combine(ProjectRoot, "Library", "HarnessBridge"); } }
        public static string BridgeFile { get { return Path.Combine(BridgeDir, "bridge.json"); } }
        public static bool Running { get { return server != null; } }

        static EditorBridge()
        {
            RestoreConsole();
            Application.logMessageReceivedThreaded += OnLog;
            CompilationPipeline.compilationStarted += _ => SessionState.SetString(CompileKey, "[]");
            CompilationPipeline.assemblyCompilationFinished += OnCompiled;
            AssemblyReloadEvents.beforeAssemblyReload += () => { SaveConsole(); Stop("Unity is reloading scripts: ask again in a moment"); };
            EditorApplication.quitting += () => { Stop("the editor is closing"); TryDelete(BridgeFile); };
            if (Application.isBatchMode && Array.IndexOf(Environment.GetCommandLineArgs(), "-harnessBridge") < 0) return;
            EditorApplication.delayCall += Start;
        }

        /// <summary>Adds an op from another part of the package (tests, the Recorder).</summary>
        public static void Register(string op, HarnessServer.Handler handler)
        {
            extra[op] = handler;
            if (server != null) server.Register(op, handler);
        }

        public static void Start()
        {
            if (server != null) return;
            int port = 0;
            string token = null;
            try
            {
                if (File.Exists(BridgeFile))
                {
                    var old = new Args(Json.ParseObject(File.ReadAllText(BridgeFile)));
                    // The same editor after a script reload keeps its port and token, so the harness reconnects.
                    if (old.Int("pid") == Process.GetCurrentProcess().Id) { port = old.Int("port"); token = old.Str("token"); }
                }
            }
            catch (Exception) { }
            if (string.IsNullOrEmpty(token)) token = HarnessServer.NewToken();
            var env = Environment.GetEnvironmentVariable("HARNESS_UNITY_BRIDGE_PORT");
            int envPort;
            if (port == 0 && int.TryParse(env, out envPort)) port = envPort;
            try
            {
                server = new HarnessServer(port, token);
                BridgeOps.RegisterAll(server);
                foreach (var kv in extra) server.Register(kv.Key, kv.Value);
                server.Start();
                Directory.CreateDirectory(BridgeDir);
                File.WriteAllText(BridgeFile, Json.Write(new Dictionary<string, object>
                {
                    { "port", server.Port }, { "token", token }, { "pid", Process.GetCurrentProcess().Id }, { "unity", Application.unityVersion },
                    { "project", ProjectRoot.Replace('\\', '/') }, { "version", Version }, { "started", DateTime.UtcNow.ToString("o") },
                }));
                EditorApplication.update -= Pump;
                EditorApplication.update += Pump;
                Debug.Log("[Harness] bridge listening on 127.0.0.1:" + server.Port + " (token in Library/HarnessBridge/bridge.json)");
            }
            catch (Exception e)
            {
                server = null;
                Debug.LogWarning("[Harness] the bridge did not start: " + e.Message);
            }
        }

        public static void Stop(string why)
        {
            EditorApplication.update -= Pump;
            if (server == null) return;
            server.Stop(why);
            server = null;
        }

        static void Pump()
        {
            if (server != null) server.Pump();
        }

        static void TryDelete(string f) { try { if (File.Exists(f)) File.Delete(f); } catch (Exception) { } }

        // ---------- the console ----------

        static void OnLog(string message, string stack, LogType type)
        {
            lock (consoleGate)
            {
                console.Add(new Dictionary<string, object>
                {
                    { "type", type.ToString() }, { "message", message.Length > 4000 ? message.Substring(0, 4000) : message },
                    { "stack", string.IsNullOrEmpty(stack) ? null : string.Join("\n", FirstLines(stack, 6)) }, { "time", DateTime.UtcNow.ToString("o") },
                });
                if (console.Count > ConsoleMax) console.RemoveRange(0, console.Count - ConsoleMax);
            }
        }

        static IEnumerable<string> FirstLines(string s, int n)
        {
            var lines = s.Split('\n');
            for (int i = 0; i < lines.Length && i < n; i++) yield return lines[i];
        }

        /// <summary>The console since the last clear: errors, warnings and logs (newest last).</summary>
        public static List<Dictionary<string, object>> ConsoleEntries(string minType, int max)
        {
            var o = new List<Dictionary<string, object>>();
            lock (consoleGate)
            {
                for (int i = Math.Max(0, console.Count - Math.Max(1, max)); i < console.Count; i++)
                {
                    var t = (string)console[i]["type"];
                    if (minType == "error" && t != "Error" && t != "Exception" && t != "Assert") continue;
                    if (minType == "warning" && t == "Log") continue;
                    o.Add(console[i]);
                }
            }
            return o;
        }

        public static void ClearConsole() { lock (consoleGate) console.Clear(); }

        static void SaveConsole()
        {
            lock (consoleGate)
            {
                var keep = console.GetRange(Math.Max(0, console.Count - 200), Math.Min(200, console.Count));
                SessionState.SetString(ConsoleKey, Json.Write(keep));
            }
        }

        static void RestoreConsole()
        {
            try
            {
                var l = Json.Parse(SessionState.GetString(ConsoleKey, "[]")) as List<object>;
                if (l == null) return;
                lock (consoleGate) foreach (var x in l) { var d = x as Dictionary<string, object>; if (d != null) console.Add(d); }
            }
            catch (Exception) { }
        }

        // ---------- compiling ----------

        static void OnCompiled(string assembly, CompilerMessage[] messages)
        {
            List<object> all;
            try { all = Json.Parse(SessionState.GetString(CompileKey, "[]")) as List<object> ?? new List<object>(); }
            catch (Exception) { all = new List<object>(); }
            foreach (var m in messages)
            {
                if (all.Count >= 200) break;
                all.Add(new Dictionary<string, object>
                {
                    { "severity", m.type == CompilerMessageType.Error ? "error" : "warning" }, { "message", m.message },
                    { "file", string.IsNullOrEmpty(m.file) ? null : m.file.Replace('\\', '/') }, { "line", m.line }, { "column", m.column },
                    { "assembly", Path.GetFileNameWithoutExtension(assembly) },
                });
            }
            SessionState.SetString(CompileKey, Json.Write(all));
        }

        /// <summary>Messages of the last compile (survive the script reload that follows it).</summary>
        public static List<object> CompileMessages()
        {
            try { return Json.Parse(SessionState.GetString(CompileKey, "[]")) as List<object> ?? new List<object>(); }
            catch (Exception) { return new List<object>(); }
        }
    }
}
