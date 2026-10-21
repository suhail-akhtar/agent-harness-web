// Content from outside the user's control (web pages, search results, service
// replies) can carry text a person never sees but a model reads: Unicode "tag"
// characters that spell out ASCII, zero-width characters that hide words, bidi
// controls that reorder them, and variation selectors used to smuggle bytes.
// GitHub strips these from issues before its agent reads them; so do we, before
// any of it enters a context, and the model is told how many were removed.

// U+E0000-E007F tags, U+E0100-E01EF variation selectors supplement (byte smuggling),
// U+200B-U+200F zero-width and direction marks, U+202A-U+202E and U+2066-U+2069
// bidi embeddings and isolates, U+2060-U+2064 word joiner and invisible operators,
// U+FEFF zero-width no-break space, U+00AD soft hyphen, U+180E Mongolian vowel separator,
// U+061C Arabic letter mark, U+034F combining grapheme joiner, U+3164 and U+FFA0 Hangul
// fillers (blank "letters"), U+115F/U+1160 Hangul choseong/jungseong fillers,
// U+FE00-U+FE0D variation selectors (U+FE0E/U+FE0F choose text or emoji style, below).
const INVISIBLE = /[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}​-‏‪-‮⁠-⁤⁦-⁩﻿­᠎؜͏ㅤﾠᅟᅠ︀-︍]/gu;
// One U+FE0E/U+FE0F after a character picks its text or emoji style (the heart in
// "I ❤️ it"); a run of selectors carries bytes, one per selector, and goes whole.
const SELECTOR_RUN = /[︀-️\u{E0100}-\u{E01EF}]{2,}/gu;

export function stripInvisible(text: string): { text: string; removed: number } {
  let removed = 0;
  const out = text
    .replace(SELECTOR_RUN, (m) => { removed += [...m].length; return ''; })
    .replace(INVISIBLE, () => { removed++; return ''; });
  return { text: out, removed };
}

/** The text with invisible characters removed, and a note saying so when there were any. */
export function sanitizeUntrusted(text: string): string {
  const { text: out, removed } = stripInvisible(text);
  return removed ? `${out}\n[harness: removed ${removed} invisible character(s) from this content: hidden text is not shown to the model]` : out;
}
