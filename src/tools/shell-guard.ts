// Shell commands that write file CONTENT the file tools should write instead. Those go through write/edit so they
// get a checkpoint (undo), a diff, the stale-file check and edit permissions: a sandboxed shell would otherwise be a
// way around "ask before edits". Build steps, installers, logs and redirects to /tmp or /dev are not affected.
// The command is read as shell words, not matched as text: quoted text and heredoc bodies are never taken for a
// command, every operand of tee is looked at, and a file's extension is the END of its name.

interface SimpleCommand { words: string[]; out: string[]; heredoc: boolean; herestring: boolean; body: string }

const SOURCE = '(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|cs|cpp|cc|c|h|hpp|php|swift|scala|sh|md|html?|css|scss|json|ya?ml|toml|sql|vue|svelte)';
/** A source file or document by its name: a listed extension at the end, or a well-known name without one. */
const SOURCE_FILE = new RegExp(String.raw`(?:\.${SOURCE}|(?:^|/)(?:Dockerfile|Makefile|\.env[\w.]*|\.gitignore|\.dockerignore))$`);
const isSource = (t: string) => SOURCE_FILE.test(t);
const target = (t: string | undefined) => !!t && !/^\/(tmp|dev)\//.test(t);

/** The command as simple commands: each one's words (quotes removed), the files its output is redirected to, and what it reads from a heredoc. */
export function shellCommands(cmd: string): SimpleCommand[] {
  const cmds: SimpleCommand[] = [];
  const fresh = (): SimpleCommand => ({ words: [], out: [], heredoc: false, herestring: false, body: '' });
  let cur = fresh();
  const push = () => { if (cur.words.length || cur.out.length) cmds.push(cur); cur = fresh(); };
  const waiting: { tag: string; of: SimpleCommand }[] = []; // heredocs whose bodies start after the next newline
  const n = cmd.length;
  let i = 0;
  const blanks = () => { while (cmd[i] === ' ' || cmd[i] === '\t') i++; };
  const word = () => {
    let w = '';
    while (i < n) {
      const c = cmd[i]!;
      if (c === "'") { const j = cmd.indexOf("'", i + 1); w += cmd.slice(i + 1, j < 0 ? n : j); i = j < 0 ? n : j + 1; }
      else if (c === '"') { i++; while (i < n && cmd[i] !== '"') { if (cmd[i] === '\\' && i + 1 < n) i++; w += cmd[i++]!; } i++; }
      else if (c === '\\' && i + 1 < n) { w += cmd[i + 1]!; i += 2; }
      else if (/[\s|&;<>()]/.test(c)) break;
      else { w += c; i++; }
    }
    return w;
  };
  while (i < n) {
    const c = cmd[i]!;
    if (c === '\n') {
      i++;
      for (const h of waiting.splice(0)) {
        for (;;) {
          const e = cmd.indexOf('\n', i);
          const line = cmd.slice(i, e < 0 ? n : e);
          i = e < 0 ? n : e + 1;
          if (line.trim() === h.tag) break;
          h.of.body += line + '\n';
          if (e < 0) break;
        }
      }
      push();
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    const fd = /\d/.test(c) && cmd[i + 1] === '>' && (i === 0 || /[\s;|&(]/.test(cmd[i - 1]!));
    if (c === '>' || (c === '&' && cmd[i + 1] === '>') || fd) {
      if (c !== '>') i++;
      i++;
      if (cmd[i] === '>') i++;
      if (cmd[i] === '|') i++;
      if (cmd[i] === '&') { i++; word(); continue; } // >&2: a file descriptor
      blanks();
      const t = word();
      if (t) cur.out.push(t);
      continue;
    }
    if (c === '<') {
      if (cmd.startsWith('<<<', i)) { i += 3; blanks(); word(); cur.herestring = true; continue; }
      if (cmd[i + 1] === '<') { i += 2; if (cmd[i] === '-') i++; blanks(); const tag = word(); if (tag) { waiting.push({ tag, of: cur }); cur.heredoc = true; } continue; }
      i++; blanks(); word();
      continue;
    }
    if (c === '|' || c === ';' || c === '&' || c === '(' || c === ')') { i++; push(); continue; }
    const at = i;
    const w = word();
    if (i === at) i++; else cur.words.push(w);
  }
  push();
  return cmds;
}

/** A path a one-line program opens for writing: open('x','w'), Path('x').write_text(, writeFileSync('x', ... */
const SCRIPT_WRITE = /\bopen\(\s*['"]([^'"]+)['"]\s*,\s*['"][wax]|\bPath\(\s*['"]([^'"]+)['"]\s*\)\s*\.write_(?:text|bytes)\(|\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?)\(\s*['"]([^'"]+)['"]/g;

export function shellFileWrite(cmd: string): string | undefined {
  if (process.env.HARNESS_SHELL_WRITE_GUARD === 'off') return undefined;
  for (const c of shellCommands(cmd)) {
    let w = c.words;
    while (w.length && (/^[A-Za-z_]\w*=/.test(w[0]!) || ['sudo', 'command', 'exec', 'nohup', 'time', 'env', 'builtin'].includes(w[0]!))) w = w.slice(1);
    const prog = (w[0] ?? '').replace(/^.*[\\/]/, '').replace(/\.exe$/i, '');
    const args = w.slice(1);
    const files = args.filter((a, k) => a !== '-' && (!a.startsWith('-') || args.slice(0, k).includes('--')) && a !== '--');
    const out = c.out.filter(target);
    const src = out.find(isSource);
    // cat copying its input (the terminal, a heredoc) into a file: any file, as before.
    if (prog === 'cat' && out.length && (c.heredoc || c.herestring || !files.length)) return `cat > ${out[0]}`;
    // Another program fed a heredoc or here-string, its output a source file (envsubst <<EOF > config.yaml).
    if ((c.heredoc || c.herestring) && src) return `heredoc > ${src}`;
    const last = files[files.length - 1];
    const inTmp = !!last && !target(last);
    if (/^g?sed$/.test(prog) && !inTmp && args.some((a) => /^--in-place/.test(a) || /^-[nErsuzb]*i/.test(a))) return 'in-place sed/perl edit';
    if (prog === 'perl' && !inTmp) {
      for (let k = 0; k < args.length && args[k]!.startsWith('-') && args[k] !== '--'; k++) {
        if (/^-[0-9acnplsStTuUwWX]*i/.test(args[k]!)) return 'in-place sed/perl edit';
        if (/^-[0-9acnplsStTuUwWX]*[eE]$/.test(args[k]!)) k++; // its program follows
      }
    }
    if (/^g?awk$/.test(prog) && !inTmp && args.some((a, k) => (a === '-i' && args[k + 1] === 'inplace') || a === '-iinplace')) return 'in-place awk edit';
    // tee, echo and printf count only when they write source or documents: `cmd | tee run.log` keeps a log, as `> run.log` does.
    if (prog === 'tee') { const hit = files.find((f) => isSource(f) && target(f)); if (hit) return `tee ${hit}`; }
    if ((prog === 'echo' || prog === 'printf') && src) return `echo/printf > ${src}`;
    // Nothing but a redirect into a source file (": > a.py", "{ echo a; echo b; } > a.py").
    if (/^(|\}|done|fi|:|true)$/.test(prog) && src) return `> ${src}`;
    // A one-line program (python -c, node -e, or fed from a heredoc) that opens a source file for writing.
    if (/^(python[\d.]*|py|node|bun|deno|ruby)$/.test(prog)) {
      const code = `${args.join('\n')}\n${c.body}`;
      for (const m of code.matchAll(SCRIPT_WRITE)) { const p = m[1] ?? m[2] ?? m[3]; if (p && isSource(p) && target(p)) return `${prog} writing ${p}`; }
    }
  }
  return undefined;
}
