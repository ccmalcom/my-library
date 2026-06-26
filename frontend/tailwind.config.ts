import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        base:     "var(--bg)",
        surface:  "var(--surface)",
        elevated: "var(--elevated)",
        border:   "var(--border)",
        hairline: "var(--hairline)",
        text:     "var(--text)",
        muted:    "var(--muted)",
        faint:    "var(--faint)",
        accent: {
          DEFAULT: "var(--accent)",
          hover:   "var(--accent-hover)",
          quiet:   "var(--accent-quiet)",
        },
        success: { DEFAULT: "var(--success)", quiet: "var(--success-quiet)" },
        danger:  { DEFAULT: "var(--danger)",  quiet: "var(--danger-quiet)"  },
        warning: { DEFAULT: "var(--warning)", quiet: "var(--warning-quiet)" },
        user:    "var(--user-accent)",
      },
      fontFamily: {
        display: ["var(--font-display)", "system-ui", "sans-serif"],
        sans:    ["var(--font-body)",    "system-ui", "sans-serif"],
        mono:    ["var(--font-mono)",    "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
