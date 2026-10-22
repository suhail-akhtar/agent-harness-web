/** A theme colour that still honours Tailwind opacity modifiers (bg-hx-danger/10). */
const mix = (name) => ({ opacityValue }) => (opacityValue === undefined || opacityValue === '1'
  ? `var(${name})`
  : `color-mix(in srgb, var(${name}) calc(${opacityValue} * 100%), transparent)`);

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
          accent: mix('--hx-accent'), 'accent-hover': mix('--hx-accent-hover'), 'accent-soft': 'var(--hx-accent-soft)', 'accent-text': mix('--hx-accent-text'), 'on-accent': mix('--hx-on-accent'),
          code: mix('--hx-code-bg'), success: mix('--hx-success'), warning: mix('--hx-warning'), danger: mix('--hx-danger'), info: mix('--hx-info'),
          sidebar: mix('--hx-sidebar'), pill: mix('--hx-pill'), focus: 'var(--hx-focus)',
        },
      },
      ringColor: { 'hx-focus': 'var(--hx-focus)' },
      opacity: { 8: '0.08', 12: '0.12', 16: '0.16', 35: '0.35' },
      fontFamily: { sans: ['var(--hx-font)'], mono: ['var(--hx-font-mono)'] },
      maxWidth: { column: 'var(--hx-column)' },
    },
  },
  plugins: [],
};
