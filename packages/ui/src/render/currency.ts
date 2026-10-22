/**
 * Money is not maths. `$x^2$` is inline TeX, but "$240.00 (subtotal $200.00)" must stay prices.
 * A dollar opens inline maths only when (Pandoc's rule) a closing dollar follows on the same line
 * with no space just inside and no digit just after, around something formula-like rather than
 * words; otherwise a dollar before a number is escaped as a price. Code and $$...$$ are untouched.
 * (From AICO's shared/ui/currency.ts.)
 */

const PRICE_AT = /^\$\d[\d,]*(?:\.\d+)?(?:[\s)\].,;:!?·—–-]|$)/;
const PROSE = /\b[A-Za-z]{3,}\s+[A-Za-z]{3,}\b/;
const FORMULA = /[-+*/=^_\\<>|()a-zA-Z]/;

export function protectCurrency(markdown: string): string {
  if (!markdown.includes('$')) return markdown;
  const parts = markdown.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`|\$\$[\s\S]*?\$\$)/);
  return parts.map((part, i) => (i % 2 === 1 ? part : part.split('\n').map(protectLine).join('\n'))).join('');
}

function protectLine(line: string): string {
  if (!line.includes('$')) return line;
  let out = '';
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === '\\') { out += line.slice(i, i + 2); i += 2; continue; }
    if (ch !== '$') { out += ch; i++; continue; }
    if (line[i + 1] === '$') { out += '$$'; i += 2; continue; }
    const close = closer(line, i + 1);
    if (close !== -1) {
      const inner = line.slice(i + 1, close);
      if (FORMULA.test(inner) && !PROSE.test(inner.replace(/\\text\{[^}]*\}/g, ''))) { out += line.slice(i, close + 1); i = close + 1; continue; }
    }
    out += PRICE_AT.test(line.slice(i)) ? '\\$' : '$';
    i++;
  }
  return out;
}

function closer(line: string, from: number): number {
  if (from >= line.length || /\s/.test(line[from]!)) return -1;
  for (let j = from; j < line.length; j++) {
    const ch = line[j]!;
    if (ch === '\\') { j++; continue; }
    if (ch !== '$') continue;
    if (j === from || line[j + 1] === '$' || /\s/.test(line[j - 1]!) || /\d/.test(line[j + 1] ?? '')) return -1;
    return j;
  }
  return -1;
}
