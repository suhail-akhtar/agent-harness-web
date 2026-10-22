/**
 * Turns three colours into a whole theme.
 *
 * Background, foreground and accent per mode (plus a contrast switch) are all a theme states; every
 * other token the shell, the renderers and plugin frames use - surfaces, borders, muted text, code,
 * diffs, the sidebar - is derived from them by mixing. One source of truth per mode, so a plugin's
 * theme (three colours in its manifest) can never end up with unreadable muted text or a border
 * that vanishes against its background: the builder nudges what it derives until it reads.
 *
 * Pure (no DOM): `applyTheme` is the only function that touches a document.
 */

export interface ThemeColors { background: string; foreground: string; accent: string }
export type ThemeMode = 'light' | 'dark';
export interface ThemeOptions { contrast?: 'normal' | 'strong' }

type RGB = [number, number, number];

export function parseHex(hex: string): RGB {
  let h = hex.trim().replace('#', '');
  if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  if (!/^[0-9a-f]{6}/i.test(h) || Number.isNaN(n)) return [128, 128, 128];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHex([r, g, b]: RGB): string {
  return '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}

/** `a` moved toward `b` by `t` (0..1). */
export function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function rgba([r, g, b]: RGB, alpha: number): string {
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Math.round(alpha * 1000) / 1000})`;
}

/** WCAG relative luminance. */
export function luminance([r, g, b]: RGB): number {
  const f = (v: number): number => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG contrast ratio of two colours (1..21). */
export function contrast(a: string | RGB, b: string | RGB): number {
  const la = luminance(typeof a === 'string' ? parseHex(a) : a);
  const lb = luminance(typeof b === 'string' ? parseHex(b) : b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function modeOf(c: Pick<ThemeColors, 'background'>): ThemeMode {
  return luminance(parseHex(c.background)) < 0.3 ? 'dark' : 'light';
}

/** Moves `fg` toward the far end (black or white) until it reaches `ratio` against `bg`. */
function ensure(fg: RGB, bg: RGB, ratio: number): RGB {
  if (contrast(fg, bg) >= ratio) return fg;
  const target: RGB = luminance(bg) < 0.3 ? [255, 255, 255] : [0, 0, 0];
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const c = mix(fg, target, t);
    if (contrast(c, bg) >= ratio) return c;
  }
  return target;
}

export const DEFAULT_ACCENT = '#d97757';
export const DEFAULT_LIGHT: ThemeColors = { background: '#faf9f6', foreground: '#1f1e1c', accent: DEFAULT_ACCENT };
export const DEFAULT_DARK: ThemeColors = { background: '#1d1c1a', foreground: '#ecebe6', accent: DEFAULT_ACCENT };

/** The names of every token the builder produces (CSS custom properties). */
export const TOKEN_NAMES = [
  '--hx-bg', '--hx-surface', '--hx-elevated', '--hx-hover', '--hx-active', '--hx-text-primary', '--hx-text-secondary', '--hx-text-muted',
  '--hx-border', '--hx-border-subtle', '--hx-accent', '--hx-accent-hover', '--hx-accent-soft', '--hx-accent-text', '--hx-on-accent',
  '--hx-success', '--hx-warning', '--hx-danger', '--hx-info', '--hx-code-bg', '--hx-focus',
  '--hx-diff-add-bg', '--hx-diff-add-gutter', '--hx-diff-remove-bg', '--hx-diff-remove-gutter', '--hx-diff-context',
  '--hx-sidebar', '--hx-pill', '--hx-shadow', '--hx-scrim',
] as const;

/** Every CSS variable for one mode, from three colours. */
export function buildTheme(colors: ThemeColors, opts: ThemeOptions = {}): Record<string, string> {
  const bg = parseHex(colors.background);
  const fg0 = parseHex(colors.foreground);
  const accent0 = parseHex(colors.accent);
  const dark = luminance(bg) < 0.3;
  const strong = opts.contrast === 'strong';
  const k = strong ? 1.6 : 1;
  const white: RGB = [255, 255, 255];
  const black: RGB = [0, 0, 0];

  // Text must read: primary at least 7:1 (4.5 for a theme that insists), secondary 4.5, muted 3.
  const fg = ensure(fg0, bg, strong ? 7 : 4.5);
  const secondary = ensure(mix(fg, bg, strong ? 0.2 : 0.3), bg, 4.5);
  const muted = ensure(mix(fg, bg, strong ? 0.38 : 0.5), bg, 3);
  // Accent as a colour stays the theme's; accent used as text is nudged to read.
  const accentText = ensure(accent0, bg, 4.5);
  const onAccent = contrast(white, accent0) >= contrast([12, 12, 12], accent0) ? '#ffffff' : '#0c0c0c';
  const success: RGB = dark ? [78, 201, 126] : [24, 140, 76];
  const warning: RGB = dark ? [240, 176, 64] : [168, 108, 20];
  const danger: RGB = dark ? [242, 102, 96] : [196, 48, 48];
  const info: RGB = dark ? [96, 178, 220] : [40, 118, 160];

  return {
    '--hx-bg': toHex(bg),
    '--hx-surface': toHex(mix(bg, fg, dark ? 0.04 : 0.028)),
    '--hx-elevated': toHex(mix(bg, dark ? fg : white, dark ? 0.075 : 0.7)),
    '--hx-hover': rgba(fg, (dark ? 0.07 : 0.05) * k),
    '--hx-active': rgba(fg, (dark ? 0.11 : 0.08) * k),
    '--hx-text-primary': toHex(fg),
    '--hx-text-secondary': toHex(secondary),
    '--hx-text-muted': toHex(muted),
    '--hx-border': rgba(fg, (dark ? 0.14 : 0.12) * k),
    '--hx-border-subtle': rgba(fg, (dark ? 0.085 : 0.07) * k),
    '--hx-accent': toHex(accent0),
    '--hx-accent-hover': toHex(mix(accent0, dark ? white : black, 0.12)),
    '--hx-accent-soft': rgba(accent0, dark ? 0.18 : 0.12),
    '--hx-accent-text': toHex(accentText),
    '--hx-on-accent': onAccent,
    '--hx-success': toHex(ensure(success, bg, 3)),
    '--hx-warning': toHex(ensure(warning, bg, 3)),
    '--hx-danger': toHex(ensure(danger, bg, 3)),
    '--hx-info': toHex(ensure(info, bg, 3)),
    '--hx-code-bg': toHex(mix(bg, fg, dark ? 0.055 : 0.04)),
    '--hx-focus': rgba(accent0, 0.55),
    '--hx-diff-add-bg': dark ? 'rgba(63, 185, 80, 0.16)' : 'rgba(46, 160, 67, 0.12)',
    '--hx-diff-add-gutter': dark ? '#3fb950' : '#1a7f37',
    '--hx-diff-remove-bg': dark ? 'rgba(248, 81, 73, 0.16)' : 'rgba(207, 34, 46, 0.1)',
    '--hx-diff-remove-gutter': dark ? '#f85149' : '#cf222e',
    '--hx-diff-context': toHex(mix(fg, bg, 0.45)),
    '--hx-sidebar': toHex(mix(bg, fg, dark ? 0.03 : 0.025)),
    '--hx-pill': toHex(mix(bg, fg, dark ? 0.09 : 0.06)),
    '--hx-shadow': dark ? '0 10px 32px rgba(0,0,0,0.5)' : '0 10px 32px rgba(0,0,0,0.12)',
    '--hx-scrim': dark ? 'rgba(0,0,0,0.55)' : 'rgba(20,18,16,0.32)',
  };
}

/** A theme a plugin contributes, or one of the built-ins. */
export interface ThemeDef { id: string; label: string; mode: ThemeMode; colors: ThemeColors; source?: string }

export const BUILTIN_THEMES: ThemeDef[] = [
  { id: 'light', label: 'Light', mode: 'light', colors: DEFAULT_LIGHT, source: 'core' },
  { id: 'dark', label: 'Dark', mode: 'dark', colors: DEFAULT_DARK, source: 'core' },
];

/** The theme to use: an explicit theme id, or light/dark (following the OS when `system`). */
export function resolveTheme(choice: { theme: 'system' | 'light' | 'dark' | string; accent?: string }, osDark: boolean, themes: ThemeDef[]): ThemeDef {
  const builtin = (mode: ThemeMode) => themes.find((t) => t.id === mode) ?? BUILTIN_THEMES.find((t) => t.id === mode)!;
  let t: ThemeDef;
  if (choice.theme === 'system') t = builtin(osDark ? 'dark' : 'light');
  else t = themes.find((x) => x.id === choice.theme) ?? builtin(choice.theme === 'dark' ? 'dark' : 'light');
  return choice.accent && /^#[0-9a-f]{3,8}$/i.test(choice.accent) && (t.id === 'light' || t.id === 'dark') ? { ...t, colors: { ...t.colors, accent: choice.accent } } : t;
}

/** Applies a theme's variables to a document root (the only DOM function here). */
export function applyTheme(root: { style: { setProperty(k: string, v: string): void }; dataset: Record<string, string | undefined>; classList: { toggle(c: string, on: boolean): void } }, t: ThemeDef, opts: ThemeOptions = {}): Record<string, string> {
  const vars = buildTheme(t.colors, opts);
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.classList.toggle('dark', t.mode === 'dark');
  root.dataset.theme = t.mode;
  root.style.setProperty('color-scheme', t.mode);
  return vars;
}
