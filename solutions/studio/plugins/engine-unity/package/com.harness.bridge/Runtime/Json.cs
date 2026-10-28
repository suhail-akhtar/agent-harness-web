// A small JSON reader and writer for the bridge (JsonUtility cannot read dictionaries).
// Objects read as Dictionary<string, object>, arrays as List<object>, numbers as double.

using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using UnityEngine;

namespace Harness.Bridge
{
    public static class Json
    {
        public static object Parse(string text)
        {
            var p = new Reader(text ?? "");
            var v = p.Value();
            p.Space();
            if (!p.End) throw new FormatException("unexpected text after the JSON value at " + p.Pos);
            return v;
        }

        public static Dictionary<string, object> ParseObject(string text)
        {
            var d = Parse(text) as Dictionary<string, object>;
            if (d == null) throw new FormatException("a JSON object was expected");
            return d;
        }

        public static string Write(object value)
        {
            var sb = new StringBuilder();
            Emit(sb, value, 0);
            return sb.ToString();
        }

        static void Emit(StringBuilder sb, object v, int depth)
        {
            if (depth > 64) { sb.Append("null"); return; }
            if (v == null) { sb.Append("null"); return; }
            if (v is string s) { Quote(sb, s); return; }
            if (v is bool b) { sb.Append(b ? "true" : "false"); return; }
            if (v is double d) { Number(sb, d); return; }
            if (v is float f) { Number(sb, f); return; }
            if (v is int || v is long || v is short || v is byte || v is uint || v is ulong || v is ushort || v is sbyte)
            {
                sb.Append(Convert.ToString(v, CultureInfo.InvariantCulture));
                return;
            }
            if (v is decimal m) { sb.Append(m.ToString(CultureInfo.InvariantCulture)); return; }
            if (v is Enum) { Quote(sb, v.ToString()); return; }
            if (v is Vector2 v2) { Emit(sb, new object[] { v2.x, v2.y }, depth + 1); return; }
            if (v is Vector3 v3) { Emit(sb, new object[] { v3.x, v3.y, v3.z }, depth + 1); return; }
            if (v is Vector4 v4) { Emit(sb, new object[] { v4.x, v4.y, v4.z, v4.w }, depth + 1); return; }
            if (v is Quaternion q) { Emit(sb, new object[] { q.eulerAngles.x, q.eulerAngles.y, q.eulerAngles.z }, depth + 1); return; }
            if (v is Color c) { Emit(sb, new object[] { c.r, c.g, c.b, c.a }, depth + 1); return; }
            if (v is IDictionary dict)
            {
                sb.Append('{');
                bool first = true;
                foreach (DictionaryEntry e in dict)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    Quote(sb, Convert.ToString(e.Key, CultureInfo.InvariantCulture));
                    sb.Append(':');
                    Emit(sb, e.Value, depth + 1);
                }
                sb.Append('}');
                return;
            }
            if (v is IEnumerable list)
            {
                sb.Append('[');
                bool first = true;
                foreach (var item in list)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    Emit(sb, item, depth + 1);
                }
                sb.Append(']');
                return;
            }
            Quote(sb, v.ToString());
        }

        static void Number(StringBuilder sb, double d)
        {
            if (double.IsNaN(d) || double.IsInfinity(d)) { sb.Append("null"); return; }
            sb.Append(d.ToString("R", CultureInfo.InvariantCulture));
        }

        static void Quote(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (var ch in s)
            {
                switch (ch)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    default:
                        if (ch < 0x20) sb.Append("\\u").Append(((int)ch).ToString("x4"));
                        else sb.Append(ch);
                        break;
                }
            }
            sb.Append('"');
        }

        sealed class Reader
        {
            readonly string s;
            public int Pos;
            public Reader(string text) { s = text; }
            public bool End { get { return Pos >= s.Length; } }

            public void Space()
            {
                while (Pos < s.Length && char.IsWhiteSpace(s[Pos])) Pos++;
            }

            public object Value()
            {
                Space();
                if (End) throw new FormatException("unexpected end of JSON");
                char c = s[Pos];
                if (c == '{') return Obj();
                if (c == '[') return Arr();
                if (c == '"') return Str();
                if (c == 't') { Word("true"); return true; }
                if (c == 'f') { Word("false"); return false; }
                if (c == 'n') { Word("null"); return null; }
                return Num();
            }

            void Word(string w)
            {
                if (string.CompareOrdinal(s, Pos, w, 0, w.Length) != 0) throw new FormatException("unexpected text at " + Pos);
                Pos += w.Length;
            }

            Dictionary<string, object> Obj()
            {
                var d = new Dictionary<string, object>();
                Pos++;
                Space();
                if (!End && s[Pos] == '}') { Pos++; return d; }
                while (true)
                {
                    Space();
                    if (End || s[Pos] != '"') throw new FormatException("a key was expected at " + Pos);
                    var key = Str();
                    Space();
                    if (End || s[Pos] != ':') throw new FormatException("':' was expected at " + Pos);
                    Pos++;
                    d[key] = Value();
                    Space();
                    if (End) throw new FormatException("unexpected end of JSON");
                    if (s[Pos] == ',') { Pos++; continue; }
                    if (s[Pos] == '}') { Pos++; return d; }
                    throw new FormatException("',' or '}' was expected at " + Pos);
                }
            }

            List<object> Arr()
            {
                var l = new List<object>();
                Pos++;
                Space();
                if (!End && s[Pos] == ']') { Pos++; return l; }
                while (true)
                {
                    l.Add(Value());
                    Space();
                    if (End) throw new FormatException("unexpected end of JSON");
                    if (s[Pos] == ',') { Pos++; continue; }
                    if (s[Pos] == ']') { Pos++; return l; }
                    throw new FormatException("',' or ']' was expected at " + Pos);
                }
            }

            string Str()
            {
                var sb = new StringBuilder();
                Pos++;
                while (true)
                {
                    if (End) throw new FormatException("unterminated string");
                    char c = s[Pos++];
                    if (c == '"') return sb.ToString();
                    if (c != '\\') { sb.Append(c); continue; }
                    if (End) throw new FormatException("unterminated string");
                    char e = s[Pos++];
                    switch (e)
                    {
                        case 'n': sb.Append('\n'); break;
                        case 'r': sb.Append('\r'); break;
                        case 't': sb.Append('\t'); break;
                        case 'b': sb.Append('\b'); break;
                        case 'f': sb.Append('\f'); break;
                        case 'u':
                            if (Pos + 4 > s.Length) throw new FormatException("bad \\u escape");
                            sb.Append((char)int.Parse(s.Substring(Pos, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                            Pos += 4;
                            break;
                        default: sb.Append(e); break;
                    }
                }
            }

            object Num()
            {
                int start = Pos;
                while (Pos < s.Length && "+-0123456789.eE".IndexOf(s[Pos]) >= 0) Pos++;
                if (start == Pos) throw new FormatException("unexpected character '" + s[Pos] + "' at " + Pos);
                return double.Parse(s.Substring(start, Pos - start), NumberStyles.Float, CultureInfo.InvariantCulture);
            }
        }
    }

    /// <summary>Typed reads of a request's arguments, with defaults.</summary>
    public sealed class Args
    {
        public readonly Dictionary<string, object> Values;
        public Args(Dictionary<string, object> values) { Values = values ?? new Dictionary<string, object>(); }

        public bool Has(string key) { return Values.ContainsKey(key) && Values[key] != null; }
        public object Raw(string key) { object v; return Values.TryGetValue(key, out v) ? v : null; }

        public string Str(string key, string fallback = null)
        {
            var v = Raw(key);
            return v == null ? fallback : Convert.ToString(v, CultureInfo.InvariantCulture);
        }

        public double Num(string key, double fallback = 0)
        {
            var v = Raw(key);
            if (v == null) return fallback;
            if (v is double d) return d;
            if (v is bool b) return b ? 1 : 0;
            double r;
            return double.TryParse(Convert.ToString(v, CultureInfo.InvariantCulture), NumberStyles.Float, CultureInfo.InvariantCulture, out r) ? r : fallback;
        }

        public int Int(string key, int fallback = 0) { return (int)Math.Round(Num(key, fallback)); }
        public float Float(string key, float fallback = 0) { return (float)Num(key, fallback); }

        public bool Bool(string key, bool fallback = false)
        {
            var v = Raw(key);
            if (v == null) return fallback;
            if (v is bool b) return b;
            if (v is double d) return d != 0;
            return string.Equals(Convert.ToString(v, CultureInfo.InvariantCulture), "true", StringComparison.OrdinalIgnoreCase);
        }

        public List<object> List(string key) { return Raw(key) as List<object> ?? new List<object>(); }

        public List<string> Strings(string key)
        {
            var o = new List<string>();
            foreach (var x in List(key)) if (x != null) o.Add(Convert.ToString(x, CultureInfo.InvariantCulture));
            return o;
        }

        public Args Obj(string key) { return new Args(Raw(key) as Dictionary<string, object>); }

        public Vector3 Vec3(string key, Vector3 fallback) { return ToVec3(Raw(key), fallback); }

        public static Vector3 ToVec3(object v, Vector3 fallback)
        {
            var l = v as List<object>;
            if (l == null || l.Count < 2) return fallback;
            float x = Convert.ToSingle(l[0], CultureInfo.InvariantCulture);
            float y = Convert.ToSingle(l[1], CultureInfo.InvariantCulture);
            float z = l.Count > 2 ? Convert.ToSingle(l[2], CultureInfo.InvariantCulture) : 0f;
            return new Vector3(x, y, z);
        }

        public static Color ToColor(object v, Color fallback)
        {
            var s = v as string;
            Color c;
            if (s != null && ColorUtility.TryParseHtmlString(s, out c)) return c;
            var l = v as List<object>;
            if (l != null && l.Count >= 3)
            {
                float a = l.Count > 3 ? Convert.ToSingle(l[3], CultureInfo.InvariantCulture) : 1f;
                return new Color(Convert.ToSingle(l[0], CultureInfo.InvariantCulture), Convert.ToSingle(l[1], CultureInfo.InvariantCulture), Convert.ToSingle(l[2], CultureInfo.InvariantCulture), a);
            }
            return fallback;
        }
    }
}
