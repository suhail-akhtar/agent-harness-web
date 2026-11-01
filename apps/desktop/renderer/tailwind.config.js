/** A theme colour that still honours Tailwind opacity modifiers (bg-hx-danger/10). */
const mix = (name) => ({ opacityValue }) => (opacityValue === undefined || opacityValue === '1'
  ? `var(${name})`
  : `color-mix(in srgb, var(${name}) calc(${opacityValue} * 100%), transparent)`);

/** A type size as a share of the person's Text size (px at the default 14). */
const fs = (px) => `calc(var(--hx-font-size, 14px) * ${+(px / 14).toFixed(4)})`;

/** @type {import('tailwindcss').Config} */
export default {
  content: { relative: true, files: ['./index.html', './src/**/*.{ts,tsx}', '../../../packages/ui/src/**/*.{ts,tsx}'] },
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        hx: {
          bg: mix('--hx-bg'), surface: mix('--hx-surface'), elevated: mix('--hx-elevated'), hover: 'var(--hx-hover)', active: 'var(--hx-active)',
          border: 'var(--hx-border)', 'border-subtle': 'var(--hx-border-subtle)',
          primary: mix('--hx-text-primary'), secondary: mix('--hx-text-secondary'), muted: mix('--hx-text-muted'),
          accent: mix('--hx-accent'), 'accent-hover': mix('--hx-accent-hover'), 'accent-soft': mix('--hx-accent-soft'), 'accent-text': mix('--hx-accent-text'), 'on-accent': mix('--hx-on-accent'),
          code: mix('--hx-code-bg'), success: mix('--hx-success'), warning: mix('--hx-warning'), danger: mix('--hx-danger'), info: mix('--hx-info'),
          // Status tints (one fill, one border per tone): use these, not an opacity on the colour.
          'success-soft': 'var(--hx-success-soft)', 'success-border': 'var(--hx-success-border)',
          'warning-soft': 'var(--hx-warning-soft)', 'warning-border': 'var(--hx-warning-border)',
          'danger-soft': 'var(--hx-danger-soft)', 'danger-border': 'var(--hx-danger-border)',
          'info-soft': 'var(--hx-info-soft)', 'info-border': 'var(--hx-info-border)',
          'accent-border': 'var(--hx-accent-border)',
          sidebar: mix('--hx-sidebar'), pill: mix('--hx-pill'), focus: 'var(--hx-focus)',
        },
      },
      ringColor: { 'hx-focus': 'var(--hx-focus)' },
      opacity: { 8: '0.08', 12: '0.12', 16: '0.16', 35: '0.35' },
      fontFamily: { sans: ['var(--hx-font)'], mono: ['var(--hx-font-mono)'] },
      // The type scale: nine roles, each a share of the person's Text size (14px by default), so that setting
      // scales all text. Pages use these, never a pixel size (test/ui-standards.test.ts).
      fontSize: {
        micro: [fs(10.5), { lineHeight: '1.35' }],
        tiny: [fs(11), { lineHeight: '1.4' }],
        caption: [fs(11.5), { lineHeight: '1.4' }],
        small: [fs(12.5), { lineHeight: '1.45' }],
        body: [fs(13), { lineHeight: '1.55' }],
        'body-lg': [fs(14), { lineHeight: '1.55' }],
        title: [fs(16), { lineHeight: '1.45' }],
        heading: [fs(20), { lineHeight: '1.35' }],
        display: [fs(26), { lineHeight: '1.25', letterSpacing: '-0.01em' }],
      },
      boxShadow: { pop: 'var(--hx-shadow-pop)', modal: 'var(--hx-shadow)' },
      maxWidth: { column: 'var(--hx-column)' },
    },
  },
  plugins: [],
};
