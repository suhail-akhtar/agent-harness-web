// The project's lint: no `var` declarations in src/.
import fs from 'node:fs';
import path from 'node:path';

let bad = 0;
for (const f of fs.readdirSync('src')) {
  const lines = fs.readFileSync(path.join('src', f), 'utf8').split('\n');
  lines.forEach((l, i) => {
    if (/(^|[\s;(])var\s/.test(l)) { console.log(`src/${f}:${i + 1}: use let or const, not var`); bad++; }
  });
}
if (bad) process.exit(1);
console.log('lint: ok');
