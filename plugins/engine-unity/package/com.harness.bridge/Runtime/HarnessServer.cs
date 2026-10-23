// The bridge's server: localhost only, one JSON request per line, each carrying the token
// the harness read from the bridge file. Requests wait on a background thread; their work
// runs on Unity's main thread when Pump() is called (EditorApplication.update in the editor,
// HarnessPlayback.Update in a player). A handler may return a HarnessPending to finish later.
//
//   request:  {"id": 1, "token": "...", "op": "scene.hierarchy", "args": {...}}
//   response: {"id": 1, "ok": true, "result": {...}}  or  {"id": 1, "ok": false, "error": "..."}

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;

namespace Harness.Bridge
{
    /// <summary>Work that finishes on a later frame: Poll returns null until the result is ready.</summary>
    public sealed class HarnessPending
    {
        public readonly Func<object> Poll;
        public readonly DateTime Deadline;
        public HarnessPending(Func<object> poll, double timeoutSeconds = 120)
        {
            Poll = poll;
            Deadline = DateTime.UtcNow.AddSeconds(timeoutSeconds);
        }
    }

    public sealed class HarnessServer
    {
        public delegate object Handler(Args args);

        public const int MaxRequestChars = 8 * 1024 * 1024;
        public int Port { get; private set; }
        public string Token { get { return token; } }

        readonly string token;
        readonly int wantPort;
        readonly Dictionary<string, Handler> handlers = new Dictionary<string, Handler>();
        readonly object gate = new object();
        readonly ConcurrentQueue<Job> queue = new ConcurrentQueue<Job>();
        readonly List<Job> waiting = new List<Job>();
        TcpListener listener;
        Thread acceptThread;
        volatile bool running;

        sealed class Job
        {
            public object Id;
            public string Op;
            public Args Args;
            public HarnessPending Pending;
            public string Response;
            public readonly ManualResetEventSlim Done = new ManualResetEventSlim(false);
        }

        public HarnessServer(int port, string token)
        {
            wantPort = port;
            this.token = token;
        }

        public void Register(string op, Handler handler)
        {
            lock (gate) handlers[op] = handler;
        }

        public List<string> Ops()
        {
            lock (gate) return new List<string>(handlers.Keys);
        }

        public void Start()
        {
            listener = new TcpListener(IPAddress.Loopback, wantPort);
            try { listener.Start(); }
            catch (SocketException)
            {
                // The port from before a reload may be taken: any free port, written to the bridge file again.
                listener = new TcpListener(IPAddress.Loopback, 0);
                listener.Start();
            }
            Port = ((IPEndPoint)listener.LocalEndpoint).Port;
            running = true;
            acceptThread = new Thread(Accept) { IsBackground = true, Name = "Harness bridge" };
            acceptThread.Start();
        }

        public void Stop(string why = "the bridge stopped")
        {
            running = false;
            try { if (listener != null) listener.Stop(); } catch (Exception) { }
            Job j;
            while (queue.TryDequeue(out j)) Answer(j, null, why);
            lock (waiting)
            {
                foreach (var w in waiting) Answer(w, null, why);
                waiting.Clear();
            }
        }

        void Accept()
        {
            while (running)
            {
                TcpClient client;
                try { client = listener.AcceptTcpClient(); }
                catch (Exception) { break; }
                var ep = client.Client.RemoteEndPoint as IPEndPoint;
                if (ep == null || !IPAddress.IsLoopback(ep.Address)) { client.Close(); continue; }
                var t = new Thread(() => Serve(client)) { IsBackground = true, Name = "Harness bridge client" };
                t.Start();
            }
        }

        void Serve(TcpClient client)
        {
            using (client)
            {
                try
                {
                    client.NoDelay = true;
                    var stream = client.GetStream();
                    var reader = new StreamReader(stream, new UTF8Encoding(false));
                    var writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" };
                    while (running)
                    {
                        var line = ReadLine(reader);
                        if (line == null) break;
                        if (line.Length == 0) continue;
                        writer.WriteLine(Handle(line));
                    }
                }
                catch (Exception) { }
            }
        }

        static string ReadLine(StreamReader reader)
        {
            var sb = new StringBuilder();
            while (true)
            {
                int c = reader.Read();
                if (c < 0) return sb.Length > 0 ? sb.ToString() : null;
                if (c == '\n') return sb.ToString().TrimEnd('\r');
                sb.Append((char)c);
                if (sb.Length > MaxRequestChars) throw new IOException("request too large");
            }
        }

        string Handle(string line)
        {
            object id = null;
            try
            {
                var req = Json.Parse(line) as Dictionary<string, object>;
                if (req == null) return Reply(null, false, null, "a request is a JSON object");
                req.TryGetValue("id", out id);
                object tok;
                req.TryGetValue("token", out tok);
                if (!SameToken(tok as string, token)) return Reply(id, false, null, "unauthorized: the token does not match the bridge file");
                object opValue;
                req.TryGetValue("op", out opValue);
                var op = opValue as string;
                if (string.IsNullOrEmpty(op)) return Reply(id, false, null, "op is missing");
                if (op == "ping") return Reply(id, true, new Dictionary<string, object> { { "pong", true }, { "ops", Ops() } }, null);
                bool known;
                lock (gate) known = handlers.ContainsKey(op);
                if (!known) return Reply(id, false, null, "unknown op \"" + op + "\"; the ops are: " + string.Join(", ", Ops()));
                object a;
                req.TryGetValue("args", out a);
                var job = new Job { Id = id, Op = op, Args = new Args(a as Dictionary<string, object>) };
                queue.Enqueue(job);
                var wait = job.Args.Num("timeoutMs", 120000);
                if (!job.Done.Wait(TimeSpan.FromMilliseconds(Math.Max(1000, wait)))) return Reply(id, false, null, "timed out waiting for Unity's main thread (is the editor busy, compiling, or in a modal dialog?)");
                return job.Response;
            }
            catch (Exception e)
            {
                return Reply(id, false, null, e.Message);
            }
        }

        /// <summary>Runs queued requests and finishes pending ones. Call on the main thread every frame.</summary>
        public void Pump()
        {
            Job job;
            int budget = 16;
            while (budget-- > 0 && queue.TryDequeue(out job))
            {
                Handler h;
                lock (gate) handlers.TryGetValue(job.Op, out h);
                try
                {
                    var r = h(job.Args);
                    var p = r as HarnessPending;
                    if (p != null) { job.Pending = p; lock (waiting) waiting.Add(job); }
                    else Answer(job, r, null);
                }
                catch (Exception e) { Answer(job, null, Describe(e)); }
            }
            lock (waiting)
            {
                for (int i = waiting.Count - 1; i >= 0; i--)
                {
                    var w = waiting[i];
                    try
                    {
                        var r = w.Pending.Poll();
                        if (r != null) { waiting.RemoveAt(i); Answer(w, r, null); }
                        else if (DateTime.UtcNow > w.Pending.Deadline) { waiting.RemoveAt(i); Answer(w, null, w.Op + " did not finish in time"); }
                    }
                    catch (Exception e) { waiting.RemoveAt(i); Answer(w, null, Describe(e)); }
                }
            }
        }

        static string Describe(Exception e)
        {
            var inner = e is System.Reflection.TargetInvocationException && e.InnerException != null ? e.InnerException : e;
            return inner.GetType().Name + ": " + inner.Message + "\n" + inner.StackTrace;
        }

        static void Answer(Job job, object result, string error)
        {
            job.Response = Reply(job.Id, error == null, result, error);
            job.Done.Set();
        }

        static string Reply(object id, bool ok, object result, string error)
        {
            var d = new Dictionary<string, object> { { "id", id }, { "ok", ok } };
            if (ok) d["result"] = result is HarnessVoid ? null : result;
            else d["error"] = error;
            return Json.Write(d);
        }

        static bool SameToken(string a, string b)
        {
            if (a == null || b == null || a.Length != b.Length) return false;
            int diff = 0;
            for (int i = 0; i < a.Length; i++) diff |= a[i] ^ b[i];
            return diff == 0;
        }

        /// <summary>A random token: 32 hex characters.</summary>
        public static string NewToken()
        {
            var bytes = new byte[16];
            using (var rng = System.Security.Cryptography.RandomNumberGenerator.Create()) rng.GetBytes(bytes);
            var sb = new StringBuilder();
            foreach (var b in bytes) sb.Append(b.ToString("x2"));
            return sb.ToString();
        }
    }

    /// <summary>A handler's "done, nothing to report".</summary>
    public sealed class HarnessVoid
    {
        public static readonly HarnessVoid Value = new HarnessVoid();
    }
}
