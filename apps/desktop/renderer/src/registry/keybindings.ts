/**
 * Key chords: parsed from the manifest form ("Ctrl+Alt+N", "Mod+K"), matched against key events,
 * recorded from a key press (rebinding) and shown the platform's way. Pure; unit-tested.
 */

export interface Chord { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; key: string }
export type Platform = 'win32' | 'darwin' | 'linux' | string;

const KEY_ALIASES: Record<string, string> = {
  esc: 'Escape', escape: 'Escape', enter: 'Enter', return: 'Enter', space: ' ', spacebar: ' ', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', del: 'Delete',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', plus: '+', comma: ',', period: '.', slash: '/',
};

/** Parses "Mod+Shift+P". `Mod` is Ctrl, or Cmd on macOS. Returns null for something that is not a chord. */
export function parseChord(text: string, platform: Platform = 'win32'): Chord | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  const parts = text.split('+').map((p) => p.trim());
  // "Ctrl++" means Ctrl and the plus key.
  if (text.endsWith('++')) { parts.splice(parts.length - 2, 2, '+'); }
  const keyRaw = parts.pop();
  if (!keyRaw) return null;
  const c: Chord = { ctrl: false, alt: false, shift: false, meta: false, key: '' };
  for (const m of parts) {
    const l = m.toLowerCase();
    if (l === 'mod') { if (platform === 'darwin') c.meta = true; else c.ctrl = true; }
    else if (l === 'ctrl' || l === 'control') c.ctrl = true;
    else if (l === 'alt' || l === 'option' || l === 'opt') c.alt = true;
    else if (l === 'shift') c.shift = true;
    else if (l === 'cmd' || l === 'meta' || l === 'super' || l === 'win') c.meta = true;
    else return null;
  }
  const alias = KEY_ALIASES[keyRaw.toLowerCase()];
  c.key = alias ?? (keyRaw.length === 1 ? keyRaw.toLowerCase() : /^f([1-9]|1[0-2])$/i.test(keyRaw) ? keyRaw.toUpperCase() : keyRaw);
  return c;
}

export interface KeyLike { key: string; code?: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }

/** The key of an event as chords name it (letters lower-case; digits and letters from the physical key when Alt changes them). */
function eventKey(e: KeyLike): string {
  if (e.code && /^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase();
  if (e.code && /^Digit[0-9]$/.test(e.code)) return e.code.slice(5);
  return e.key.length === 1 ? e.key.toLowerCase() : e.key;
}

export function matches(chord: Chord, e: KeyLike): boolean {
  return chord.ctrl === e.ctrlKey && chord.alt === e.altKey && chord.meta === e.metaKey && (chord.shift === e.shiftKey || (chord.key.length === 1 && !/[a-z0-9]/.test(chord.key) && !chord.shift)) && eventKey(e) === chord.key;
}

/** The chord a key press makes, as text ("Ctrl+Shift+K"); null for a lone modifier. */
export function chordFromEvent(e: KeyLike): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta', 'OS'].includes(e.key)) return null;
  const k = eventKey(e);
  const name = k === ' ' ? 'Space' : k.startsWith('Arrow') ? k.slice(5) : k.length === 1 ? k.toUpperCase() : k;
  return [e.ctrlKey && 'Ctrl', e.metaKey && 'Cmd', e.altKey && 'Alt', e.shiftKey && 'Shift', name].filter(Boolean).join('+');
}

/** How a chord is shown: "Ctrl+K" on Windows and Linux, "⌘K" on macOS. */
export function formatChord(text: string, platform: Platform = 'win32'): string {
  const c = parseChord(text, platform);
  if (!c) return text;
  const key = c.key === ' ' ? 'Space' : c.key.startsWith('Arrow') ? ({ ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' } as Record<string, string>)[c.key]! : c.key.length === 1 ? c.key.toUpperCase() : c.key;
  if (platform === 'darwin') return `${c.ctrl ? '⌃' : ''}${c.alt ? '⌥' : ''}${c.shift ? '⇧' : ''}${c.meta ? '⌘' : ''}${key}`;
  return [c.ctrl && 'Ctrl', c.meta && 'Win', c.alt && 'Alt', c.shift && 'Shift', key].filter(Boolean).join('+');
}

/** Typing in a text field: plain keys belong to the field, chords with Ctrl/Cmd (or function keys, Escape) still work. */
export function allowedWhileTyping(chord: Chord): boolean { return chord.ctrl || chord.meta || /^F\d+$/.test(chord.key) || chord.key === 'Escape'; }

/** Commands whose chords collide (the same chord, normalised). */
export function conflicts(bindings: Array<{ id: string; keys?: string }>, platform: Platform = 'win32'): Array<{ chord: string; ids: string[] }> {
  const by = new Map<string, string[]>();
  for (const b of bindings) {
    if (!b.keys) continue;
    const c = parseChord(b.keys, platform);
    if (!c) continue;
    const k = `${c.ctrl ? 'C' : ''}${c.alt ? 'A' : ''}${c.shift ? 'S' : ''}${c.meta ? 'M' : ''}:${c.key}`;
    by.set(k, [...(by.get(k) ?? []), b.id]);
  }
  return [...by.entries()].filter(([, ids]) => ids.length > 1).map(([k, ids]) => ({ chord: k, ids }));
}
