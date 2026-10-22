/**
 * The theme in force: light, dark or the OS's, the built-in themes and every theme a plugin
 * contributes (three colours each, the builder derives the rest), plus contrast, font size, fonts,
 * density, transcript width and motion. Applied to the document; frames get the same variables.
 */

import { applyTheme, BUILTIN_THEMES, DEFAULT_DARK, DEFAULT_LIGHT, resolveTheme, type ThemeDef } from '@harness/ui';
import type { DesktopPrefs } from '@desk/prefs';
import type { Registry } from '../registry/registry';
import { desktop } from '../bridge';

let vars: Record<string, string> = {};
const listeners = new Set<(v: Record<string, string>) => void>();
export function themeVars(): Record<string, string> { return vars; }
export function onThemeChange(f: (v: Record<string, string>) => void): () => void { listeners.add(f); return () => listeners.delete(f); }

export function allThemes(registry: Registry, accent?: string): ThemeDef[] {
  const base: ThemeDef[] = BUILTIN_THEMES.map((t) => ({ ...t, colors: { ...(t.id === 'dark' ? DEFAULT_DARK : DEFAULT_LIGHT), accent: accent || t.colors.accent } }));
  return [...base, ...registry.themes.map((t) => ({ id: t.qid, label: t.label, mode: t.mode, colors: { background: t.background, foreground: t.foreground, accent: t.accent }, source: t.plugin }))];
}

const osDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

export function apply(prefs: DesktopPrefs, registry: Registry, productAccent?: string): ThemeDef {
  const themes = allThemes(registry, prefs.accent || productAccent);
  const t = resolveTheme({ theme: prefs.theme }, osDark(), themes);
  const root = document.documentElement;
  vars = applyTheme(root, t, { contrast: prefs.contrast });
  const extra: Record<string, string> = {
    '--hx-font': prefs.uiFont, '--hx-font-mono': prefs.codeFont, '--hx-font-size': `${prefs.fontSize}px`,
    '--hx-column': prefs.transcriptWidth === 'full' ? '100%' : prefs.transcriptWidth === 'wide' ? '980px' : '768px',
    '--hx-density': prefs.density === 'compact' ? '0.8' : '1',
  };
  for (const [k, v] of Object.entries(extra)) root.style.setProperty(k, v);
  vars = { ...vars, ...extra };
  root.style.fontSize = `${prefs.fontSize}px`;
  root.dataset.density = prefs.density;
  root.dataset.motion = prefs.motion === 'reduced' ? 'reduced' : 'system';
  void desktop.overlay(vars['--hx-bg'] ?? '#ffffff', vars['--hx-text-secondary'] ?? '#333333');
  for (const f of listeners) f(vars);
  return t;
}

/** Follow the OS while the theme is "system". */
export function watchSystem(reapply: () => void): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', reapply);
  return () => mq.removeEventListener('change', reapply);
}
