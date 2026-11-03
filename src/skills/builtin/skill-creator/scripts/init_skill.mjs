#!/usr/bin/env node
// Scaffolds a skill folder: node init_skill.mjs <parent-folder> <name> "<description>" [--scripts] [--references]
// [--assets] [--tests] [--mcp]. Prints JSON {created: [...files]} on stdout; exits 1 with a message on stderr when the
// name is not valid or the folder exists.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--help') || args.length < 3) {
  console.log('usage: init_skill.mjs <parent-folder> <name> "<description>" [--scripts] [--references] [--assets] [--tests] [--mcp]');
  process.exit(args.includes('--help') ? 0 : 1);
}
const [parent, name, description] = args;
const want = (f) => args.includes(f);
if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(name)) { console.error(`"${name}" is not a skill name: lower-case letters, digits, "-", "_" or ".", at most 64`); process.exit(1); }
if (description.length < 20) { console.error('the description must say what the skill does and when to use it (at least 20 characters)'); process.exit(1); }
const dir = path.join(parent, name);
if (fs.existsSync(dir)) { console.error(`${dir} exists already`); process.exit(1); }
const created = [];
const write = (rel, text) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); created.push(rel); };

const front = ['---', `name: ${name}`, `description: ${description.replace(/\n/g, ' ')}`];
if (want('--mcp')) front.push('mcp-servers: example-server');
front.push('---');
const body = [`# ${name}`, '', 'When to use it, and what a good result looks like.', '', '## Steps', '', '1. ...'];
if (want('--scripts')) body.push('', '## Scripts', '', '- `scripts/run.py <input>`: what it does, and the JSON it prints.');
if (want('--references')) body.push('', 'Details: [references/guide.md](references/guide.md).');
write('SKILL.md', `${[...front, ...body].join('\n')}\n`);
if (want('--scripts')) {
  write('scripts/run.py', [
    '#!/usr/bin/env python3', '"""What this script does. Prints JSON on stdout; errors on stderr with exit 1."""',
    'import argparse, json, sys', '', '', 'def main() -> int:',
    '    p = argparse.ArgumentParser(description=__doc__)', '    p.add_argument("input", help="the input file")', '    a = p.parse_args()',
    '    try:', '        with open(a.input, encoding="utf-8") as f:', '            text = f.read()',
    '    except OSError as e:', '        print(f"cannot read {a.input}: {e}", file=sys.stderr)', '        return 1',
    '    print(json.dumps({"lines": len(text.splitlines())}))', '    return 0', '', '',
    'if __name__ == "__main__":', '    sys.exit(main())', '',
  ].join('\n'));
}
if (want('--tests')) {
  write('tests/test_run.py', [
    '#!/usr/bin/env python3', '"""Runs scripts/run.py on a sample and checks its output (exit 0 only when right)."""',
    'import json, os, subprocess, sys, tempfile', '',
    'here = os.path.dirname(os.path.abspath(__file__))', 'script = os.path.join(here, "..", "scripts", "run.py")',
    'with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:', '    f.write("a\\nb\\n")',
    'out = subprocess.run([sys.executable, script, f.name], capture_output=True, text=True)', 'os.unlink(f.name)',
    'if out.returncode != 0 or json.loads(out.stdout) != {"lines": 2}:', '    print("FAIL", out.stdout, out.stderr, file=sys.stderr)', '    sys.exit(1)', 'print("ok")', '',
  ].join('\n'));
}
if (want('--references')) write('references/guide.md', `# ${name}: details\n\nWhat the agent reads only when it needs it.\n`);
if (want('--assets')) write('assets/README.md', 'Templates and data the scripts use ($SKILL_DIR/assets/...).\n');
if (want('--mcp')) write('mcp.json', `${JSON.stringify({ mcpServers: { 'example-server': { command: 'npx', args: ['-y', '@example/mcp-server'] } } }, null, 2)}\n`);
console.log(JSON.stringify({ created, dir }));
