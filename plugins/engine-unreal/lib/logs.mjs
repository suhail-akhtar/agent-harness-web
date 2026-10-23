// Reading what Unreal printed: problems with their file and line, the results and events the
// harness's Python and Blueprints print (HARNESS_JSON, HARNESS_EVENT), build progress from
// UAT, Automation reports, and CSV profiler captures.

const LINE = /^\[(\d{4}\.\d\d\.\d\d-\d\d\.\d\d\.\d\d:\d{3})\]\[\s*(\d+)\](\w+):\s?(.*)$/;

/** Log lines that look like errors but are the engine talking to itself. */
const NOISE = [
  /UnifiedErrorTest|FError that has been|LogTemp: Error (test|with)/,
  /Failed to load '(aqProf|VtuneApi|VtuneApi32e|WinPixGpuCapturer|Wintab32)\.dll'/,
  /PIX capture plugin failed/,
  /LogEOS|LogEOSSDK|LogOnline|LogHttp(?!Server)/,
  /Error_Unknown\b.*AutomationTool exiting/,
  /LogDerivedDataCache: Warning: .*Zen/,
  /does not exist.*WinPixGpuCapturer/,
  /LogAudioCaptureCore/,
  /LogStreaming: Warning: .*Engine\/Content/,
  /LogBlueprint: Warning: No event node \w+ for in/,
];

/** One Unreal log line: { time, frame, category, verbosity, message } (verbosity: Error, Warning, Display, Log). */
export function parseLine(line) {
  const m = LINE.exec(line);
  const bare = m ? null : /^(Log\w+|MapCheck|LoadErrors):\s?(.*)$/.exec(line);
  const body = m ? { time: m[1], frame: Number(m[2]), category: m[3], rest: m[4] } : bare ? { category: bare[1], rest: bare[2] } : null;
  if (!body) return null;
  const v = /^(Error|Warning|Fatal|Display|Verbose|Log):\s?(.*)$/.exec(body.rest);
  return { time: body.time, frame: body.frame, category: body.category, verbosity: v ? v[1] : 'Log', message: v ? v[2] : body.rest };
}

/** file and line from a message: Python tracebacks, MSBuild-style paths, Blueprint asset paths. */
export function whereIn(message) {
  let m = /File "([^"]+)", line (\d+)/.exec(message);
  if (m) return { file: m[1], line: Number(m[2]) };
  m = /([A-Za-z]:[\\/][^:()\s]+?\.\w+)\((\d+)(?:,\d+)?\)/.exec(message) ?? /(\/[^:()\s]+?\.\w+)\((\d+)(?:,\d+)?\)/.exec(message);
  if (m) return { file: m[1], line: Number(m[2]) };
  m = /\[AssetLog\]\s+(\S+?\.uasset|\S+?\.umap|\/Game\/\S+?)(?::|\s)/.exec(message) ?? /\b(\/Game\/[\w/]+(?:\.\w+)?)\b/.exec(message);
  if (m) return { file: m[1].replace(/:$/, '') };
  return {};
}

/**
 * The problems in a log: every Error (and Fatal), the warnings of the categories that matter
 * (Blueprints, Python, the cook, map checks, loading), Python tracebacks as one problem each
 * with the script's file and line, and the HARNESS_PROBLEM lines harness_ue prints. Deduplicated.
 */
export function problemsIn(text, { warnings = true, max = 60 } = {}) {
  const lines = String(text ?? '').replace(/\r/g, '').split('\n');
  const out = [];
  const seen = new Set();
  const add = (p) => {
    const key = `${p.severity}|${p.message}`;
    if (seen.has(key) || out.length >= max) return;
    seen.add(key);
    out.push(p);
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (NOISE.some((r) => r.test(raw))) continue;
    if (/Traceback \(most recent call last\)/.test(raw)) {
      // The traceback's frames follow, prefixed or not; the last line is the exception.
      const frames = [];
      let j = i + 1;
      let exc = '';
      for (; j < lines.length && j < i + 60; j++) {
        const t = lines[j].replace(/^\[[^\]]+\]\[\s*\d+\]LogPython: (Error: )?/, '');
        if (/^\s*File "/.test(t)) { frames.push(t.trim()); continue; }
        if (/^\s{2,}\S/.test(t) || /^\s*\^+\s*$/.test(t)) continue;
        if (/^\w[\w.]*(Error|Exception|Exit|Interrupt)\b/.test(t.trim()) || /^\w+: /.test(t.trim())) { exc = t.trim(); j++; break; }
        if (!t.trim()) continue;
        break;
      }
      const userFrame = [...frames].reverse().find((f) => !/harness_ue\.py|unreal\.py|<string>/.test(f)) ?? frames.at(-1) ?? '';
      const where = whereIn(userFrame);
      add({ severity: 'error', message: `Python: ${exc || 'an exception'}${frames.length ? ` (${frames.at(-1).replace(/^File /, '')})` : ''}`, ...where });
      i = j - 1;
      continue;
    }
    const harness = /HARNESS_PROBLEM (.*)$/.exec(raw);
    if (harness) { add({ severity: 'error', message: harness[1].trim(), ...whereIn(harness[1]) }); continue; }
    const p = parseLine(raw);
    if (p && (p.verbosity === 'Error' || p.verbosity === 'Fatal')) {
      if (/^Traceback|^\s*File "|^\s+\^/.test(p.message) || /^LogPython$/.test(p.category) && /^\s/.test(p.message)) continue;
      if (/Python script executed with errors/.test(p.message)) continue;
      add({ severity: 'error', message: `${p.category}: ${p.message}`.slice(0, 600), ...whereIn(p.message) });
      continue;
    }
    if (warnings && p?.verbosity === 'Warning' && /^(LogBlueprint|LogPython|LogCook|MapCheck|LoadErrors|LogLinker|LogUObjectGlobals|LogScript|LogAutomationController|LogInterchange\w*|LogFbx|LogStaticMesh|LogPlayLevel)$/.test(p.category)) {
      if (/DeprecationWarning/.test(p.message)) continue;
      add({ severity: 'warning', message: `${p.category}: ${p.message}`.slice(0, 400), ...whereIn(p.message) });
      continue;
    }
    // UAT and the tools it runs: "ERROR: ..." and MSBuild-style "file(12): error C1234: ...".
    const uat = /^\s*(?:ERROR|Error): (.*)$/.exec(raw) ?? /^(.*\(\d+(?:,\d+)?\)\s*:\s*(?:fatal )?error \w*:.*)$/.exec(raw);
    if (uat && !p) add({ severity: 'error', message: uat[1].trim().slice(0, 600), ...whereIn(uat[1]) });
  }
  return out;
}

/** The HARNESS_JSON results a script printed: { tag: data } (a repeated tag keeps the last, and all are in .all). */
export function resultsIn(text) {
  const out = { all: [] };
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const i = line.indexOf('HARNESS_JSON ');
    if (i < 0) continue;
    try {
      const r = JSON.parse(line.slice(i + 13));
      out[r.tag] = r.data;
      out.all.push(r);
    } catch { /* a line cut by the log */ }
  }
  return out;
}

/** The HARNESS_EVENT lines (the kit's score and win, the driver's ready) with the time since the first log line. */
export function eventsIn(text) {
  const out = [];
  let t0 = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const p = parseLine(line);
    const ms = p?.time ? toMs(p.time) : null;
    if (t0 === null && ms !== null) t0 = ms;
    const i = line.indexOf('HARNESS_EVENT ');
    if (i < 0) continue;
    const [type, ...rest] = line.slice(i + 14).trim().split(/\s+/);
    out.push({ t: ms !== null && t0 !== null ? Math.round((ms - t0) / 100) / 10 : null, type, detail: rest.join(' ') });
  }
  return out;
}

/** "2026.10.23-12.45.21:046" as ms (the day ignored but for ordering across midnight). */
export function toMs(stamp) {
  const m = /^(\d{4})\.(\d\d)\.(\d\d)-(\d\d)\.(\d\d)\.(\d\d):(\d{3})$/.exec(stamp);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]);
}

/** UAT's stages, in order, with a weight each for an overall percentage. */
export const UAT_STAGES = [['BUILD', 5], ['COOK', 70], ['STAGE', 15], ['PACKAGE', 5], ['ARCHIVE', 5]];

/**
 * Progress from one UAT line, updating state { stage, pct, cooked, total, done: [] }.
 * Returns true when something changed.
 */
export function uatProgress(state, line) {
  const st = /\*{5,} (BUILD|COOK|STAGE|PACKAGE|ARCHIVE|DEPLOY|RUN) COMMAND (STARTED|COMPLETED) \*{5,}/.exec(line);
  if (st) {
    if (st[2] === 'STARTED') state.stage = st[1].toLowerCase();
    else state.done = [...new Set([...(state.done ?? []), st[1].toLowerCase()])];
    state.pct = overall(state);
    return true;
  }
  const cook = /Cooked packages (\d+) Packages Remain (\d+) Total (\d+)/.exec(line);
  if (cook) {
    state.stage = 'cook';
    state.cooked = Number(cook[1]);
    state.total = Number(cook[3]);
    state.pct = overall(state);
    return true;
  }
  return false;
}

function overall(state) {
  let pct = 0;
  for (const [name, w] of UAT_STAGES) {
    const n = name.toLowerCase();
    if (state.done?.includes(n)) pct += w;
    else if (state.stage === n) pct += n === 'cook' && state.total ? (w * state.cooked) / state.total : 0;
  }
  return Math.min(100, Math.round(pct));
}

/**
 * An Automation report (index.json from -ReportExportPath) as results:
 * { passed, failed, warnings, notRun, durationS, tests: [{ name, path, state, durationS, errors: [{ message, file, line }] }] }.
 */
export function parseAutomationReport(json) {
  const r = typeof json === 'string' ? JSON.parse(json.replace(/^\uFEFF/, '')) : json;
  const tests = (r.tests ?? []).map((t) => {
    const errors = [];
    const warnings = [];
    for (const e of t.entries ?? []) {
      const ev = e.event ?? e;
      const item = { message: String(ev.message ?? '').slice(0, 500), ...(e.filename ? { file: e.filename } : {}), ...(e.lineNumber > 0 ? { line: e.lineNumber } : {}) };
      if (/error/i.test(ev.type)) errors.push(item);
      else if (/warning/i.test(ev.type)) warnings.push(item);
    }
    return { name: t.testDisplayName, path: t.fullTestPath, state: t.state, durationS: Math.round((t.duration ?? 0) * 100) / 100, errors, warnings };
  });
  const by = (s) => tests.filter((t) => t.state === s).length;
  return {
    passed: r.succeeded ?? by('Success'),
    warnings: r.succeededWithWarnings ?? 0,
    failed: r.failed ?? by('Fail'),
    notRun: r.notRun ?? by('NotRun'),
    durationS: Math.round((r.totalDuration ?? 0) * 10) / 10,
    tests,
  };
}

/**
 * A CSV profiler capture (Saved/Profiling/CSV/*.csv) as metrics: frames, fpsAvg, fpsMin (of
 * the worst 1%), frameMs avg and p95, game/render/GPU thread ms, memory. The first frames
 * (loading) are skipped.
 */
export function parseCsvProfile(text, { skip = 30 } = {}) {
  const rows = String(text ?? '').replace(/\r/g, '').split('\n').filter((l) => l.trim());
  if (rows.length < 2) return null;
  const head = rows[0].split(',').map((h) => h.trim());
  const col = (name) => head.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  // The first column is EVENTS (often empty); metadata rows start with '['; a capture cut off at
  // exit ends in a partial row. A row of numbers about as wide as the header counts.
  const data = rows.slice(1).filter((r) => !/^\[/.test(r) && !/^EVENTS,/.test(r)).map((r) => r.split(',')).filter((r) => r.length >= head.length - 1);
  const series = (name) => { const i = col(name); return i < 0 ? [] : data.slice(Math.min(skip, Math.floor(data.length / 3))).map((r) => Number(r[i])).filter((n) => Number.isFinite(n) && n > 0); };
  const frame = series('FrameTime');
  if (!frame.length) return null;
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
  const r1 = (n) => (n == null ? undefined : Math.round(n * 10) / 10);
  const mem = series('PhysicalUsedMB');
  const out = {
    frames: frame.length,
    fpsAvg: r1(1000 / avg(frame)),
    fpsMin: r1(1000 / pct(frame, 99)),
    frameMsAvg: r1(avg(frame)),
    frameMsP95: r1(pct(frame, 95)),
    gameThreadMs: r1(avg(series('GameThreadTime'))),
    renderThreadMs: r1(avg(series('RenderThreadTime'))),
    rhiThreadMs: r1(avg(series('RHIThreadTime'))),
    gpuMs: r1(avg(series('GPUTime'))),
    memoryMb: mem.length ? Math.round(Math.max(...mem)) : undefined,
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined && v !== null && !Number.isNaN(v)));
}
