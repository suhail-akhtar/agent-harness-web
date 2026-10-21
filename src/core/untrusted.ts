// Content from outside the user's control (web pages, search results, service
// replies) can carry text a person never sees but a model reads: Unicode "tag"
// characters that spell out ASCII, zero-width characters that hide words, bidi
// controls that reorder them, and variation selectors used to smuggle bytes.
// GitHub strips these from issues before its agent reads them; so do we, before
// any of it enters a context, and the model is told how many were removed.

// U+E0000-E007F tags, U+E0100-E01EF variation selectors supplement (byte smuggling),
// U+200B-U+200F zero-width and direction marks, U+202A-U+202E and U+2066-U+2069
// bidi embeddings and isolates, U+2060-U+2064 word joiner and invisible operators,
// U+FEFF zero-width no-break space, U+00AD soft hyphen, U+180E Mongolian vowel separator.
const INVISIBLE = /[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}​-‏‪-‮⁠-⁤⁦-⁩﻿­᠎]/gu;

export function stripInvisible(text: string): { text: string; removed: number } {
  let removed = 0;
  const out = text.replace(INVISIBLE, () => { removed++; return ''; });
  return { text: out, removed };
}

/**
 * HTML comments (<!-- ... -->) in content that is not a fetched page (an MCP
 * result, a Markdown file, an issue body): a renderer hides them from the person,
 * the model reads them. GitHub strips them from issue bodies before its agent
 * sees them. Only closed comments: an unclosed "<!--" in code is left alone.
 */
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

export function stripHtmlComments(text: string): { text: string; removed: number } {
  if (!text.includes('<!--')) return { text, removed: 0 };
  let removed = 0;
  const out = text.replace(HTML_COMMENT, () => { removed++; return ''; });
  return { text: out, removed };
}

/** The text with invisible characters and HTML comments removed, and a note saying so when there were any. */
export function sanitizeUntrusted(text: string): string {
  const inv = stripInvisible(text);
  const com = stripHtmlComments(inv.text);
  if (!inv.removed && !com.removed) return text;
  const what = [inv.removed ? `${inv.removed} invisible character(s)` : '', com.removed ? `${com.removed} HTML comment(s)` : ''].filter(Boolean).join(' and ');
  return `${com.text}\n[harness: removed ${what} from this content: hidden text is not shown to the model]`;
}
