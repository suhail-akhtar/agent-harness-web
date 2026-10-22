/**
 * Realistic agent replies, one per rendering type, plus a kitchen sink that mixes them all, and
 * hostile inputs. Used by the renderer unit tests, the scripted engine of the desktop e2e test, and
 * the screenshots.
 */

export const PNG_SMALL = 'iVBORw0KGgoAAAANSUhEUgAAADAAAAAgCAYAAABU1PscAAAAV0lEQVR4nO3PsQ0AIAwDwWzJKMzKEjSIGjZASoFMwhfuXPzZHH1FnqkDAKgD0gFaLccBAAAAwGcAbxAAAAAAJAfcDgIAAACAYIDXggCogwCogwCog7z/DRY/aF2A8TPVAAAAAElFTkSuQmCC';

export const RICH: Record<string, string> = {
  markdown: `## Release checklist

Here is where things stand. Items marked done were verified ~~yesterday~~ today.

| Step | Owner | Est. hours |
|:-----|:-----:|-----------:|
| Build | CI | 0.5 |
| Sign | Ops | 1.25 |
| Publish | Ops | 2 |

- [x] Tests pass on Windows and Linux
- [ ] Notes reviewed
  - first by Dana
  - then by the team

> The installer must not touch user data.

See https://example.com/releases for the full log, and the footnote on timing.[^1]

[^1]: Timings are from the last three releases.`,

  code: `The bug is in the retry loop: it never resets the delay.

\`\`\`python
import time

def fetch_with_retry(fetch, attempts=5):
    delay = 0.5
    for i in range(attempts):
        try:
            return fetch()
        except TimeoutError:
            time.sleep(delay)
            delay = min(delay * 2, 8)
    raise RuntimeError("gave up")
\`\`\`

Call it as \`fetch_with_retry(lambda: client.get(url))\`. The same in TypeScript:

\`\`\`ts
export async function withRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  let delay = 500;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch { await new Promise((r) => setTimeout(r, delay)); delay = Math.min(delay * 2, 8000); }
  }
  throw new Error('gave up');
}
\`\`\`

The full log, for reference:

\`\`\`text
${Array.from({ length: 40 }, (_, i) => `line ${i + 1}: retrying request ${i % 5}`).join('\n')}
\`\`\``,

  math: `The kinetic energy is $E_k = \\frac{1}{2}mv^2$, so doubling the speed quadruples it.

$$
\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}
$$

\`\`\`math
\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}
\`\`\`

It costs $240.00 (subtotal $200.00): those dollars are prices, not maths.`,

  mermaid: `The request flow:

\`\`\`mermaid
flowchart LR
  A[Browser] --> B{Gateway}
  B -->|auth ok| C[API]
  B -->|denied| D[Error page]
  C --> E[(Database)]
\`\`\`

And the sequence:

\`\`\`mermaid
sequenceDiagram
  participant U as User
  participant S as Server
  U->>S: POST /login
  S-->>U: 200 token
\`\`\``,

  chart: `Monthly signups:

\`\`\`chart
{"xAxis":{"type":"category","data":["Jan","Feb","Mar","Apr"]},"yAxis":{"type":"value"},"series":[{"name":"Signups","type":"bar","data":[120,200,150,320]}]}
\`\`\`

The same as a Vega-Lite figure with a trend:

\`\`\`vega-lite
{"data":{"values":[{"m":1,"v":120},{"m":2,"v":200},{"m":3,"v":150},{"m":4,"v":320}]},"layer":[{"mark":"point","encoding":{"x":{"field":"m","type":"quantitative"},"y":{"field":"v","type":"quantitative"}}},{"mark":"line","transform":[{"regression":"v","on":"m"}],"encoding":{"x":{"field":"m","type":"quantitative"},"y":{"field":"v","type":"quantitative"}}}]}
\`\`\``,

  artifact: `Here is a small page:

\`\`\`html
<!doctype html>
<html><head><title>Counter</title></head>
<body><h1>Counter</h1><button id="b">Clicked 0 times</button>
<script>let n=0;document.getElementById('b').onclick=()=>{n++;document.getElementById('b').textContent='Clicked '+n+' times'}</script>
</body></html>
\`\`\`

A logo:

\`\`\`svg
<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120"><circle cx="60" cy="60" r="50" fill="#d97757"/><text x="60" y="72" font-size="40" text-anchor="middle" fill="#fff">H</text></svg>
\`\`\`

And a React component:

\`\`\`jsx
import { useState } from 'react';
export default function Counter() {
  const [n, setN] = useState(0);
  return <button onClick={() => setN(n + 1)}>React clicks: {n}</button>;
}
\`\`\``,

  image: `The screenshot after the fix:

![A small chart](data:image/png;base64,${PNG_SMALL})`,

  data: `The results as CSV:

\`\`\`csv
city,population,area_km2
Lisbon,545000,100
Porto,231000,41
Braga,193000,183
\`\`\`

The raw API answer:

\`\`\`json
${JSON.stringify({ items: [{ id: 1, name: 'alpha', tags: ['a', 'b'], meta: { created: '2026-10-01', score: 0.92 } }, { id: 2, name: 'beta', tags: [], meta: { created: '2026-10-02', score: 0.4 } }], total: 2, page: { size: 50, next: null } }, null, 2)}
\`\`\`

And as a table spec:

\`\`\`table
{"columns":["Region","Q1","Q2"],"rows":[["North",120,140],["South",90,"1,050"]]}
\`\`\``,

  diff: `The change I made:

\`\`\`diff
diff --git a/src/retry.ts b/src/retry.ts
--- a/src/retry.ts
+++ b/src/retry.ts
@@ -1,5 +1,6 @@
 export async function withRetry(fn) {
-  let delay = 500;
+  let delay = 250;
+  const max = 8000;
   for (let i = 0; i < 5; i++) {
     try { return await fn(); } catch {}
   }
\`\`\``,

  citations: `Recent studies put the effect at 5-30 points [1](https://example.com/study-a), with the larger gains on long tasks [2](https://example.org/study-b).`,
};

export const KITCHEN_SINK = [
  '# Kitchen sink',
  'Everything the transcript can draw, in one reply.',
  RICH.markdown, RICH.code, RICH.math, RICH.mermaid, RICH.chart, RICH.artifact, RICH.image, RICH.data, RICH.diff, RICH.citations,
  '**That is all.**',
].join('\n\n');

/** Inputs that must come out inert. */
export const HOSTILE = `Plain <script>alert('xss-script')</script> in prose, and <img src=x onerror="alert('xss-img')">.

[click me](javascript:alert('xss-link')) and [also](  JaVaScRiPt:alert(1)) and ![pic](javascript:alert('xss-pic'))

<a href="javascript:alert(1)" onclick="alert(2)">raw anchor</a>

$\\href{javascript:alert('xss-katex')}{maths link}$

\`\`\`svg
<svg xmlns="http://www.w3.org/2000/svg" onload="alert('xss-svg')"><script>alert('xss-svg-script')</script><circle r="5"/></svg>
\`\`\``;

export const HOSTILE_MERMAID = `flowchart LR
  A["<img src=x onerror=alert('xss-mermaid')>"] --> B
  click A href "javascript:alert('xss-mermaid-click')"`;

/** An HTML artifact that tries to reach the app; it reports what it could do via postMessage. */
export const ESCAPE_ARTIFACT = `\`\`\`html
<html><body><p id="r">probing</p><script>
var out = {};
try { out.parent = !!window.parent.document.body; } catch (e) { out.parent = 'blocked'; }
try { out.cookie = document.cookie; } catch (e) { out.cookie = 'blocked'; }
try { out.storage = !!window.localStorage; } catch (e) { out.storage = 'blocked'; }
try { out.top = String(window.top.location.href); } catch (e) { out.top = 'blocked'; }
fetch('harness://app/api/sessions').then(function () { out.fetch = 'reached'; }, function () { out.fetch = 'blocked'; }).then(function () { parent.postMessage({ escapeProbe: out }, '*'); document.getElementById('r').textContent = JSON.stringify(out); });
</script></body></html>
\`\`\``;

/** A long reply without heavy widgets: prose, tables, code and maths, for the streaming measurement. */
export const STREAM_TEXT = [RICH.markdown, RICH.code, RICH.math, RICH.citations, RICH.markdown, RICH.code].join('\n\n');
