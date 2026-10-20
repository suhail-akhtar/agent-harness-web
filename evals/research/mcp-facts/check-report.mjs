// Hidden check: the facts a correct answer contains, and its sources.
import fs from 'node:fs';
const text = fs.readFileSync(process.argv[2], 'utf8');
const low = text.toLowerCase();
const fails = [];
const need = [
  ['introduced by Anthropic', /anthropic/],
  ['in November 2024', /november\s+(25,?\s+)?2024|2024-11/],
  ['the stdio transport', /stdio|standard input/],
  ['the Streamable HTTP transport', /streamable\s+http/],
  ['tools as a primitive', /\btools?\b/],
  ['resources as a primitive', /\bresources?\b/],
  ['prompts as a primitive', /\bprompts?\b/],
  ['clients and servers', /\bclients?\b[\s\S]*\bservers?\b|\bservers?\b[\s\S]*\bclients?\b/],
  ['JSON-RPC', /json-rpc/],
];
for (const [what, re] of need) if (!re.test(low)) fails.push(`missing: ${what}`);
const refs = [...text.matchAll(/^\s*\[\^?\w+\]:?\s.*?(https?:\/\/[^\s)>\]]+)/gm)].map((m) => m[1]);
const domains = new Set(refs.map((u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }).filter(Boolean));
if (refs.length < 4) fails.push(`only ${refs.length} references (need 4+)`);
if (domains.size < 2) fails.push(`references come from ${domains.size} site(s) (need 2+)`);
const words = text.split(/\s+/).length;
if (words < 350) fails.push(`only ${words} words`);
if (fails.length) { console.log(fails.join('\n')); process.exit(1); }
console.log(`ok: ${refs.length} references from ${domains.size} sites, ${words} words`);
