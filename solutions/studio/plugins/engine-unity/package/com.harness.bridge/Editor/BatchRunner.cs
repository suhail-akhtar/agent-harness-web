// How the batch entry points talk to the harness: arguments from the JSON file after
// -harnessArgs, the result as JSON in the file after -harnessResult (and one line in the
// log, HARNESS_RESULT {...}), and the exit code (0 ok, 1 failed). Entry points that wait
// for the editor (tests, play mode, packages) finish later through Finish.

using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace Harness.Bridge.Editor
{
    public static class BatchRunner
    {
        public static string Arg(string name)
        {
            var args = Environment.GetCommandLineArgs();
            for (int i = 0; i < args.Length - 1; i++) if (args[i] == name) return args[i + 1];
            return null;
        }

        public static Args ReadArgs()
        {
            var file = Arg("-harnessArgs");
            if (string.IsNullOrEmpty(file)) return new Args(null);
            return new Args(Json.ParseObject(File.ReadAllText(file)));
        }

        /// <summary>Runs an entry point: its result (or null when it finishes later) goes to the harness.</summary>
        public static void Run(string name, Func<Args, Dictionary<string, object>> work)
        {
            Debug.Log("[Harness] " + name + " started");
            Dictionary<string, object> result;
            try { result = work(ReadArgs()); }
            catch (Exception e)
            {
                Finish(new Dictionary<string, object> { { "error", e.GetType().Name + ": " + e.Message }, { "stack", e.StackTrace } }, false, null);
                return;
            }
            if (result == null) return;
            object ok;
            Finish(result, !result.TryGetValue("ok", out ok) || !(ok is bool) || (bool)ok, null);
        }

        /// <summary>Writes the result, logs it, and in batch mode exits with 0 (ok) or 1.</summary>
        public static void Finish(Dictionary<string, object> result, bool ok, string resultFile)
        {
            result["ok"] = ok;
            if (!result.ContainsKey("unity")) result["unity"] = Application.unityVersion;
            var json = Json.Write(result);
            var file = string.IsNullOrEmpty(resultFile) ? Arg("-harnessResult") : resultFile;
            if (!string.IsNullOrEmpty(file))
            {
                try
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(file)));
                    File.WriteAllText(file, json);
                }
                catch (Exception e) { Debug.LogError("[Harness] could not write the result: " + e.Message); }
            }
            // The log line is for when the file cannot be read; large results stay in the file.
            Debug.Log("HARNESS_RESULT " + (json.Length < 16000 ? json : Json.Write(new Dictionary<string, object> { { "ok", ok }, { "note", "the result is in the result file" } })));
            if (Application.isBatchMode) EditorApplication.Exit(ok ? 0 : 1);
        }
    }
}
