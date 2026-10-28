// One read-only shell script that gathers a Linux host's vital signs, and the
// parser that turns its output into numbers. Works on full distributions and
// on busybox (Alpine): every probe has a fallback, and a missing tool is "n/a".

export const HOST_STATS_SCRIPT = `
export LC_ALL=C
echo '@@UNAME'; uname -srm 2>/dev/null
echo '@@UPTIME'; cat /proc/uptime 2>/dev/null
echo '@@LOAD'; cat /proc/loadavg 2>/dev/null
echo '@@NPROC'; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null
echo '@@STAT1'; head -1 /proc/stat 2>/dev/null; sleep 1; echo '@@STAT2'; head -1 /proc/stat 2>/dev/null
echo '@@MEM'; head -25 /proc/meminfo 2>/dev/null
echo '@@DF'; df -Pk 2>/dev/null
echo '@@DFI'; df -Pi 2>/dev/null
echo '@@PS'; out=$(ps -eo pid,user,pcpu,pmem,rss,comm --sort=-pcpu 2>/dev/null); if [ -n "$out" ]; then echo "$out" | head -9; else ps -o pid,user,vsz,rss,comm 2>/dev/null | head -9; fi
echo '@@PSMEM'; ps -eo pid,user,pcpu,pmem,rss,comm --sort=-rss 2>/dev/null | head -6
echo '@@FAILED'; if command -v systemctl >/dev/null 2>&1; then systemctl --failed --no-legend --plain 2>/dev/null | head -20; else echo 'n/a (no systemd)'; fi
echo '@@KERN'; (journalctl -k -p warning --since -6h --no-pager -q 2>/dev/null || dmesg 2>/dev/null) | grep -iE 'oom|out of memory|killed process|segfault|i/o error|ext4-fs error|xfs.*error|hung task|nfs.*not responding|blocked for more' | tail -15
echo '@@END'
`;

/** du of the biggest entries under a path (read-only), for "what fills this disk". */
export function duScript(dir) {
  return `export LC_ALL=C; echo '@@DU'; du -xsk ${shQuote(dir)}/* ${shQuote(dir)}/.[!.]* 2>/dev/null | sort -rn | head -15; echo '@@BIG'; find ${shQuote(dir)} -xdev -type f -size +10240k 2>/dev/null | head -15 | while read -r f; do ls -l "$f" 2>/dev/null; done; echo '@@END'`;
}

export const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function sections(out) {
  const m = {};
  let cur;
  for (const line of String(out).split('\n')) {
    const h = /^@@([A-Z0-9]+)\s*$/.exec(line.trim());
    if (h) { cur = h[1]; m[cur] = []; continue; }
    if (cur) m[cur].push(line);
  }
  return m;
}

const kib = (n) => { const b = n * 1024; return b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(1)} GiB` : b >= 2 ** 20 ? `${(b / 2 ** 20).toFixed(0)} MiB` : `${(b / 1024).toFixed(0)} KiB`; };

/** Parses the script's output: { text, cpuPct, memUsedPct, disks: [{mount, usedPct, availKiB}], load, failed, kernel }. */
export function parseHostStats(out) {
  const s = sections(out);
  const lines = [];
  const res = { disks: [] };
  const uname = s.UNAME?.join(' ').trim();
  const up = Number(s.UPTIME?.[0]?.split(/\s+/)[0]);
  const nproc = Number(s.NPROC?.[0]) || undefined;
  lines.push(`${uname || 'unknown system'}${Number.isFinite(up) ? `, up ${Math.floor(up / 86400)}d ${Math.floor((up % 86400) / 3600)}h` : ''}${nproc ? `, ${nproc} CPU(s)` : ''}`);
  const load = s.LOAD?.[0]?.split(/\s+/).slice(0, 3).map(Number);
  if (load?.every(Number.isFinite)) {
    res.load = load;
    lines.push(`load ${load.join(' ')}${nproc ? ` (per CPU ${(load[0] / nproc).toFixed(2)}${load[0] / nproc > 1 ? ' - SATURATED' : ''})` : ''}`);
  }
  const cpu = (l) => { const f = (l ?? '').trim().split(/\s+/).slice(1).map(Number); const idle = (f[3] ?? 0) + (f[4] ?? 0); const total = f.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0); return { idle, total, iowait: f[4] ?? 0, steal: f[7] ?? 0 }; };
  const a = cpu(s.STAT1?.[0]); const b = cpu(s.STAT2?.[0]);
  if (b.total > a.total) {
    const dt = b.total - a.total;
    res.cpuPct = Math.round((1 - (b.idle - a.idle) / dt) * 1000) / 10;
    const io = Math.round(((b.iowait - a.iowait) / dt) * 1000) / 10;
    const steal = Math.round(((b.steal - a.steal) / dt) * 1000) / 10;
    lines.push(`cpu ${res.cpuPct}% busy over 1s (iowait ${io}%, steal ${steal}%)`);
  }
  const mem = Object.fromEntries((s.MEM ?? []).map((l) => { const m = /^(\w+(?:\(\w+\))?):\s+(\d+)/.exec(l); return m ? [m[1], Number(m[2])] : null; }).filter(Boolean));
  if (mem.MemTotal) {
    const avail = mem.MemAvailable ?? (mem.MemFree + (mem.Buffers ?? 0) + (mem.Cached ?? 0));
    res.memUsedPct = Math.round((1 - avail / mem.MemTotal) * 1000) / 10;
    const swapUsed = (mem.SwapTotal ?? 0) - (mem.SwapFree ?? 0);
    lines.push(`memory ${res.memUsedPct}% used (${kib(mem.MemTotal - avail)} of ${kib(mem.MemTotal)}, ${kib(avail)} available)${mem.SwapTotal ? `, swap ${kib(swapUsed)} of ${kib(mem.SwapTotal)} used` : ', no swap'}`);
  }
  const inodes = {};
  for (const l of (s.DFI ?? []).slice(1)) { const f = l.trim().split(/\s+/); if (f.length >= 6) inodes[f.slice(5).join(' ')] = f[4]; }
  for (const l of (s.DF ?? []).slice(1)) {
    const f = l.trim().split(/\s+/);
    if (f.length < 6) continue;
    const [fs, size, used, avail, pct] = f;
    const mount = f.slice(5).join(' ');
    if (/^(tmpfs|devtmpfs|overlay|shm|none|udev|cgroup.*|proc|sysfs)$/.test(fs) && !/^\/(data|var|srv|mnt)/.test(mount)) continue;
    const usedPct = Number(String(pct).replace('%', ''));
    res.disks.push({ fs, mount, usedPct, sizeKiB: Number(size), usedKiB: Number(used), availKiB: Number(avail), inodePct: inodes[mount] });
  }
  if (res.disks.length) {
    lines.push('disks:');
    for (const d of res.disks.sort((x, y) => y.usedPct - x.usedPct)) lines.push(`  ${d.mount} (${d.fs}): ${d.usedPct}% used, ${kib(d.availKiB)} free of ${kib(d.sizeKiB)}${d.inodePct && d.inodePct !== '-' ? `, inodes ${d.inodePct}` : ''}${d.usedPct >= 90 ? ' - NEARLY FULL' : ''}`);
  }
  const ps = (s.PS ?? []).filter((l) => l.trim());
  if (ps.length > 1) lines.push('top processes by CPU:', ...ps.map((l) => `  ${l.trim()}`));
  const psm = (s.PSMEM ?? []).filter((l) => l.trim());
  if (psm.length > 1) lines.push('top processes by memory:', ...psm.map((l) => `  ${l.trim()}`));
  res.failed = (s.FAILED ?? []).map((l) => l.trim()).filter(Boolean);
  lines.push(`failed systemd units: ${res.failed.length ? res.failed.join('; ') : 'none'}`);
  res.kernel = (s.KERN ?? []).map((l) => l.trim()).filter(Boolean);
  lines.push(`kernel warnings (OOM, I/O errors, hung tasks): ${res.kernel.length ? `\n  ${res.kernel.join('\n  ')}` : 'none found'}`);
  if (!('END' in s)) lines.push('(the script did not finish: the output may be partial)');
  res.text = lines.join('\n');
  return res;
}

export function parseDu(out) {
  const s = sections(out);
  const du = (s.DU ?? []).map((l) => l.trim()).filter(Boolean).map((l) => { const [k, ...p] = l.split(/\s+/); return { kib: Number(k), path: p.join(' ') }; }).filter((x) => Number.isFinite(x.kib));
  const big = (s.BIG ?? []).map((l) => l.trim()).filter(Boolean);
  return { du, big, text: [`largest entries:`, ...du.map((d) => `  ${kib(d.kib).padStart(9)}  ${d.path}`), ...(big.length ? ['files over 10 MiB:', ...big.map((b) => `  ${b}`)] : [])].join('\n') };
}
