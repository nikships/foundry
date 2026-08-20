/**
 * Colour, shadow and font scales are taken verbatim from the Factory design
 * system in Magic Patterns (design system `Factory`), which in turn mirrors
 * apps/desktop/src/renderer/design/tokens-factory.css in this repo. Every utility resolves
 * to a CSS custom property, so the site and the app cannot drift apart.
 *
 * The radii, spacing, easing and keyframes below come from tokens-base.css.
 */

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        'bg-void': 'var(--bg-void)',
        'bg-base': 'var(--bg-base)',
        'bg-panel': 'var(--bg-panel)',
        'bg-raised': 'var(--bg-raised)',
        'bg-hover': 'var(--bg-hover)',
        'bg-active': 'var(--bg-active)',
        'bg-input': 'var(--bg-input)',
        'bg-sidebar': 'var(--bg-sidebar)',
        'bg-titlebar': 'var(--bg-titlebar)',
        'line-faint': 'var(--line-faint)',
        line: 'var(--line)',
        'line-strong': 'var(--line-strong)',
        text: 'var(--text)',
        'text-dim': 'var(--text-dim)',
        'text-faint': 'var(--text-faint)',
        'text-ghost': 'var(--text-ghost)',
        accent: 'var(--accent)',
        'accent-bright': 'var(--accent-bright)',
        'accent-deep': 'var(--accent-deep)',
        'accent-dim': 'var(--accent-dim)',
        purple: 'var(--purple)',
        'purple-dim': 'var(--purple-dim)',
        amber: 'var(--amber)',
        'amber-dim': 'var(--amber-dim)',
        green: 'var(--green)',
        'green-dim': 'var(--green-dim)',
        red: 'var(--red)',
        'red-dim': 'var(--red-dim)',
        blue: 'var(--blue)',
        'blue-dim': 'var(--blue-dim)',
        'status-queued': 'var(--status-queued)',
        'status-running': 'var(--status-running)',
        'status-success': 'var(--status-success)',
        'status-fail': 'var(--status-fail)',
        'accents-refiner': 'var(--accents-refiner)',
        'accents-planner': 'var(--accents-planner)',
        'accents-builder': 'var(--accents-builder)',
        'accents-scout': 'var(--accents-scout)',
        'accents-finisher': 'var(--accents-finisher)',
        'accents-reviewer': 'var(--accents-reviewer)',
        'accents-documenter': 'var(--accents-documenter)',
      },
      boxShadow: {
        sm: 'var(--shadow-sm)',
        DEFAULT: 'var(--shadow)',
        lg: 'var(--shadow-lg)',
      },
      fontFamily: {
        mono: ['"Geist Mono"', 'ui-monospace', '"SF Mono"', 'Menlo', 'monospace'],
        sans: ['Geist', '-apple-system', 'BlinkMacSystemFont', '"SF Pro Text"', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        sm: 'var(--r-sm)',
        DEFAULT: 'var(--r)',
        lg: 'var(--r-lg)',
        xl: 'var(--r-xl)',
      },
      letterSpacing: {
        label: 'var(--label-tracking)',
        eyebrow: 'var(--eyebrow-tracking)',
        tight: '-0.028em',
        tighter: '-0.04em',
      },
      transitionTimingFunction: {
        mech: 'var(--ease)',
      },
      transitionDuration: {
        fast: '120ms',
        normal: '150ms',
        slow: '300ms',
      },
      maxWidth: {
        wrap: '1240px',
      },
      keyframes: {
        'row-in': {
          from: { opacity: '0', transform: 'translateY(-2px)' },
          to: { opacity: '1', transform: 'none' },
        },
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.38' },
        },
      },
      animation: {
        'row-in': 'row-in 180ms var(--ease) both',
        'pulse-soft': 'pulse-soft 1100ms var(--ease) infinite',
      },
    },
  },
  plugins: [],
};
