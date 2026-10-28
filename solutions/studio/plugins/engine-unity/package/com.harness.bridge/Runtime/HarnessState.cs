// What the game tells the harness: named values (score, lives, the player's position,
// won) and events (a pickup, a hit, the exit opening). The AI player reads both with each
// frame; playtests keep the events. Games call HarnessState.Set and HarnessState.Emit;
// both are cheap and do nothing visible.

using System.Collections.Generic;
using UnityEngine;

namespace Harness.Bridge
{
    public static class HarnessState
    {
        static readonly object gate = new object();
        static readonly Dictionary<string, object> values = new Dictionary<string, object>();
        static readonly List<Dictionary<string, object>> events = new List<Dictionary<string, object>>();
        static int seq;
        const int MaxEvents = 5000;

        /// <summary>Sets a value the harness sees (numbers, strings, bools, vectors, lists).</summary>
        public static void Set(string key, object value)
        {
            lock (gate) values[key] = value;
        }

        public static object Get(string key)
        {
            lock (gate) { object v; return values.TryGetValue(key, out v) ? v : null; }
        }

        /// <summary>Records an event at the current game time: Emit("pickup", "coin 3/10").</summary>
        public static void Emit(string type, string detail = null)
        {
            float t = Application.isPlaying ? Time.timeSinceLevelLoad : 0f;
            lock (gate)
            {
                seq++;
                events.Add(new Dictionary<string, object> { { "seq", seq }, { "t", System.Math.Round(t, 3) }, { "type", type }, { "detail", detail } });
                if (events.Count > MaxEvents) events.RemoveRange(0, events.Count - MaxEvents);
            }
        }

        public static Dictionary<string, object> Snapshot()
        {
            lock (gate) return new Dictionary<string, object>(values);
        }

        /// <summary>The events after sequence number `after` (0: all kept).</summary>
        public static List<Dictionary<string, object>> EventsSince(int after)
        {
            var o = new List<Dictionary<string, object>>();
            lock (gate)
            {
                foreach (var e in events) if ((int)e["seq"] > after) o.Add(e);
            }
            return o;
        }

        public static int LastSeq { get { lock (gate) return seq; } }

        public static void Clear()
        {
            lock (gate) { values.Clear(); events.Clear(); seq = 0; }
        }
    }
}
