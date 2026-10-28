// The Unity Test Framework through its API (TestRunnerApi), for the live bridge (tests.run)
// and the RunTests batch entry point. Results are saved as NUnit XML, the same file
// -runTests writes. The callbacks are registered again after every script reload (PlayMode
// tests reload), and the pending run is kept in SessionState, so a run survives its reloads.

using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEditor.TestTools.TestRunner.Api;
using UnityEngine;

namespace Harness.Bridge.Editor
{
    [InitializeOnLoad]
    public static class TestRunnerBridge
    {
        const string PendingKey = "harness.tests.results";
        const string ModeKey = "harness.tests.mode";
        static TestRunnerApi api;
        static Action<Dictionary<string, object>> batchDone;

        static TestRunnerBridge()
        {
            api = ScriptableObject.CreateInstance<TestRunnerApi>();
            api.RegisterCallbacks(new Callbacks());
            Batch.TestRunner = RunBatch;
            EditorBridge.Register("tests.run", RunLive);
            EditorBridge.Register("tests.status", a => new Dictionary<string, object> { { "running", SessionState.GetString(PendingKey, "").Length > 0 } });
        }

        static void Start(Args a, string mode)
        {
            var results = a.Str("results");
            if (string.IsNullOrEmpty(results)) throw new ArgumentException("results (an XML file path) is required");
            var platform = a.Str("platform", "EditMode");
            var filter = new Filter { testMode = platform.Equals("PlayMode", StringComparison.OrdinalIgnoreCase) ? TestMode.PlayMode : TestMode.EditMode };
            if (a.Has("filter")) filter.groupNames = new[] { a.Str("filter") };
            if (a.Has("category")) filter.categoryNames = new[] { a.Str("category") };
            if (a.Has("assemblies")) filter.assemblyNames = a.Str("assemblies").Split(';');
            SessionState.SetString(PendingKey, results);
            SessionState.SetString(ModeKey, mode);
            api.Execute(new ExecutionSettings(filter));
        }

        static void RunBatch(Args a, Action<Dictionary<string, object>> done)
        {
            batchDone = done;
            Start(a, "batch");
        }

        static object RunLive(Args a)
        {
            if (EditorApplication.isPlayingOrWillChangePlaymode) throw new InvalidOperationException("the editor is in play mode: play.exit first");
            Start(a, "live");
            return new Dictionary<string, object> { { "started", true }, { "results", a.Str("results") } };
        }

        sealed class Callbacks : ICallbacks
        {
            public void RunStarted(ITestAdaptor testsToRun) { }
            public void TestStarted(ITestAdaptor test) { }
            public void TestFinished(ITestResultAdaptor result) { }

            public void RunFinished(ITestResultAdaptor result)
            {
                var file = SessionState.GetString(PendingKey, "");
                var mode = SessionState.GetString(ModeKey, "");
                if (file.Length == 0) return;
                SessionState.EraseString(PendingKey);
                SessionState.EraseString(ModeKey);
                Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(file)));
                TestRunnerApi.SaveResultToFile(result, file);
                var summary = new Dictionary<string, object>
                {
                    { "ok", result.FailCount == 0 }, { "results", file }, { "passed", result.PassCount }, { "failed", result.FailCount },
                    { "skipped", result.SkipCount + result.InconclusiveCount }, { "durationS", Math.Round(result.Duration, 2) },
                };
                if (mode == "batch")
                {
                    if (batchDone != null) batchDone(summary);
                    else BatchRunner.Finish(summary, result.FailCount == 0, null);
                }
            }
        }
    }
}
