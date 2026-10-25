// Hidden check: the facts a correct answer contains, a dated deployment figure, a recommendation, and its sources.
import fs from 'node:fs';
const text = fs.readFileSync(process.argv[2], 'utf8');
const low = text.toLowerCase();
const fails = [];
const need = [
  ['RFC 9000 (QUIC transport)', /rfc\s*9000/],
  ['RFC 9001 (QUIC with TLS)', /rfc\s*9001/],
  ['RFC 9114 (HTTP/3)', /rfc\s*9114/],
  ['RFC 9204 (QPACK)', /rfc\s*9204|qpack/],
  ['QUIC published in May 2021', /may\s+(\d{1,2},?\s+)?2021|2021-05/],
  ['HTTP/3 published in June 2022', /june\s+(\d{1,2},?\s+)?2022|2022-06/],
  ['runs over UDP', /\budp\b/],
  ['0-RTT', /0-rtt|zero[- ]rtt/],
  ['the replay risk of 0-RTT', /replay/],
  ['connection IDs or migration', /connection[- ]id|connection migration/],
  ['head-of-line blocking', /head[- ]of[- ]line/],
  ['a deployment percentage', /\d+(\.\d+)?\s?%/],
  ['a recommendation', /recommend/],
  ['what a pilot measures', /pilot/],
];
for (const [what, re] of need) if (!re.test(low)) fails.push(`missing: ${what}`);
const refs = [...text.matchAll(/^\s*\[\^?\w+\]:?\s.*?(https?:\/\/[^\s)>\]]+)/gm)].map((m) => m[1]);
const domains = new Set(refs.map((u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }).filter(Boolean));
if (refs.length < 6) fails.push(`only ${refs.length} references (need 6+)`);
if (domains.size < 3) fails.push(`references come from ${domains.size} site(s) (need 3+)`);
const words = text.split(/\s+/).length;
if (words < 700) fails.push(`only ${words} words`);
if (fails.length) { console.log(fails.join('\n')); process.exit(1); }
console.log(`ok: ${refs.length} references from ${domains.size} sites, ${words} words`);
