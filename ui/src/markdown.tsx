import type { ComponentChildren, VNode } from 'preact';

// A small Markdown renderer that builds elements, never HTML strings: model
// output (which can echo fetched pages) cannot inject markup or script.

type Inline = ComponentChildren;

function inline(text: string, keyBase: string): Inline[] {
  const out: Inline[] = [];
  // code | link | bold | italic
  const re = /(`+)([\s\S]*?)\1|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|(?<![\w*])\*([^*\n]+)\*(?![\w*])|(?<![\w_])_([^_\n]+)_(?![\w_])/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${keyBase}-${i++}`;
    if (m[1]) out.push(<code key={k}>{m[2]}</code>);
    else if (m[3]) {
      const href = m[4]!;
      if (/^https?:\/\//i.test(href)) out.push(<a key={k} href={href} target="_blank" rel="noopener noreferrer">{m[3]}</a>);
      else out.push(m[3]);
    } else if (m[5] || m[6]) out.push(<strong key={k}>{inline(m[5] ?? m[6]!, k)}</strong>);
    else if (m[7] || m[8]) out.push(<em key={k}>{m[7] ?? m[8]}</em>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }): VNode {
  const lines = text.replace(/\r/g, '').split('\n');
  const blocks: VNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(fence[1]!)) body.push(lines[i++]!);
      i++;
      blocks.push(<pre key={k++} class="md-code" data-lang={fence[2] || undefined}><code>{body.join('\n')}</code></pre>);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = Math.min(6, h[1]!.length + 1);
      const Tag = `h${level}` as 'h2';
      blocks.push(<Tag key={k++}>{inline(h[2]!, `h${k}`)}</Tag>);
      i++;
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const start = ordered ? Number(/^\s*(\d+)/.exec(line)![1]) : 1;
      const indent = /^\s*/.exec(line)![0].length;
      const isItem = (l: string) => /^\s*([-*+]|\d+[.)])\s+/.test(l) && /^\s*/.exec(l)![0].length === indent;
      const items: Inline[][] = [];
      while (i < lines.length && isItem(lines[i]!)) {
        let item = lines[i]!.replace(/^\s*([-*+]|\d+[.)])\s+/, '');
        i++;
        // Lines indented past the bullet belong to this item: continuation text, or a nested list.
        const nested: string[] = [];
        while (i < lines.length && (lines[i]!.trim() === '' ? i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!) && /^\s*/.exec(lines[i + 1]!)![0].length > indent : /^\s*/.exec(lines[i]!)![0].length > indent)) {
          const l = lines[i++]!;
          if (nested.length || /^\s*([-*+]|\d+[.)])\s+/.test(l)) nested.push(l.slice(Math.min(l.length, indent + 2)));
          else if (l.trim()) item += ' ' + l.trim();
        }
        const task = /^\[( |x|X)\]\s+/.exec(item);
        const head = task ? [<input type="checkbox" checked={task[1] !== ' '} disabled />, ' ', ...inline(item.slice(task[0].length), `li${k}-${items.length}`)] : inline(item, `li${k}-${items.length}`);
        items.push(nested.length ? [...head, <Markdown text={nested.join('\n')} />] : head);
      }
      const children = items.map((c, j) => <li key={j}>{c}</li>);
      blocks.push(ordered ? <ol key={k++} start={start}>{children}</ol> : <ul key={k++}>{children}</ul>);
      continue;
    }
    if (/^\s*>/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) q.push(lines[i++]!.replace(/^\s*>\s?/, ''));
      blocks.push(<blockquote key={k++}>{inline(q.join(' '), `q${k}`)}</blockquote>);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1]!)) {
      const row = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = row(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) rows.push(row(lines[i++]!));
      blocks.push(
        <div key={k++} class="md-table"><table>
          <thead><tr>{head.map((c, j) => <th key={j}>{inline(c, `th${j}`)}</th>)}</tr></thead>
          <tbody>{rows.map((r, j) => <tr key={j}>{r.map((c, x) => <td key={x}>{inline(c, `td${j}-${x}`)}</td>)}</tr>)}</tbody>
        </table></div>,
      );
      continue;
    }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { blocks.push(<hr key={k++} />); i++; continue; }
    if (!line.trim()) { i++; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^\s*(```|~~~|#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\|)/.test(lines[i]!)) para.push(lines[i++]!);
    if (!para.length) para.push(lines[i++]!);
    blocks.push(<p key={k++}>{inline(para.join('\n'), `p${k}`)}</p>);
  }
  return <div class="md">{blocks}</div>;
}
