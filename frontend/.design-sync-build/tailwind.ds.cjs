/**
 * Standalone Tailwind config for the design-sync bundle's stylesheet.
 * Mirrors frontend/tailwind.config.ts's theme, but scans BOTH the ui primitives
 * and the authored preview cards so every utility they use lands in ds.css.
 * Run from the frontend/ directory (paths are relative to cwd).
 */
module.exports = {
  content: ['./components/ui/**/*.{ts,tsx}', '../.design-sync/previews/**/*.{ts,tsx}'],
  // Ship the FULL token vocabulary so a design agent can compose new screens with
  // any token class and still get styled output (not just the classes the primitives
  // happen to use). Covers the brand colors + fonts as bg/text/border utilities.
  safelist: [
    // Brand token colors (bg/text/border)
    { pattern: /(bg|text|border)-(base|surface|elevated|border|hairline|text|muted|faint|user)/ },
    {
      pattern: /(bg|text|border)-(accent|success|danger|warning)(-hover|-quiet)?/,
      variants: ['hover'],
    },
    { pattern: /font-(display|sans|mono)/ },
    // A composition toolkit so the agent can lay out new screens (designs receive only
    // the shipped stylesheet, so these must be present, not just the classes the
    // primitives happen to use).
    {
      pattern:
        /^(flex|grid|inline-flex|block|inline-block|hidden|items-center|items-start|items-end|justify-center|justify-between|justify-start|justify-end|flex-col|flex-row|flex-wrap|flex-1|shrink-0|grow|relative|absolute|fixed|w-full|h-full|min-w-0)$/,
    },
    {
      pattern:
        /^(gap|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr)-(0|0\.5|1|1\.5|2|2\.5|3|4|5|6|8|10|12)$/,
    },
    { pattern: /^(w|h)-(4|5|6|8|10|12|16)$/ },
    { pattern: /^max-w-(xs|sm|md|lg|xl|2xl)$/ },
    { pattern: /^rounded(-sm|-md|-lg|-xl|-2xl|-full)?$/ },
    { pattern: /^text-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl)$/ },
    { pattern: /^font-(normal|medium|semibold|bold|extrabold)$/ },
    {
      pattern:
        /^(italic|truncate|text-center|text-left|text-right|uppercase|tracking-tight|tracking-wide|tracking-widest|leading-tight|leading-snug|leading-none)$/,
    },
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        base: 'var(--bg)',
        surface: 'var(--surface)',
        elevated: 'var(--elevated)',
        border: 'var(--border)',
        hairline: 'var(--hairline)',
        text: 'var(--text)',
        muted: 'var(--muted)',
        faint: 'var(--faint)',
        accent: {
          DEFAULT: 'var(--accent)',
          hover: 'var(--accent-hover)',
          quiet: 'var(--accent-quiet)',
        },
        success: { DEFAULT: 'var(--success)', quiet: 'var(--success-quiet)' },
        danger: { DEFAULT: 'var(--danger)', quiet: 'var(--danger-quiet)' },
        warning: { DEFAULT: 'var(--warning)', quiet: 'var(--warning-quiet)' },
        user: 'var(--user-accent)',
      },
      fontFamily: {
        display: ['var(--font-display)', 'system-ui', 'sans-serif'],
        sans: ['var(--font-body)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'monospace'],
      },
    },
  },
  plugins: [],
};
