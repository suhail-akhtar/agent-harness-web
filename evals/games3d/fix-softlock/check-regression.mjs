// Hidden check: QA filed the softlock as a regression (.studio/regressions/*.json) that expects no softlock.
import fs from 'node:fs';
const dir = '.studio/regressions';
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
if (!files.length) { console.log('no regression in .studio/regressions'); process.exit(1); }
const ok = files.filter((f) => { try { const r = JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8')); return (r.recording?.events?.length || r.recording?.steps?.length) && (r.expect ?? []).length; } catch { return false; } });
if (!ok.length) { console.log(`no regression with a recording and expectations: ${files.join(', ')}`); process.exit(1); }
console.log(`regressions: ${ok.join(', ')}`);
