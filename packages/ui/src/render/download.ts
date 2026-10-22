/** Saves text as a file through the browser's download (the desktop asks where to put it). */
export function downloadText(name: string, contents: string, type = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name.replace(/[\\/:*?"<>|]+/g, '_');
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Copies text; resolves false when the clipboard is refused. */
export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

/** Copies rich text (HTML) with a plain-text alternative, falling back to plain text. */
export async function copyRich(html: string, text: string): Promise<boolean> {
  try {
    if (typeof ClipboardItem !== 'undefined') {
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]);
      return true;
    }
  } catch { /* fall through */ }
  return copyText(text);
}
