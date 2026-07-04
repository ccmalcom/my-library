# design-sync notes — MyLibrary

## Scope
- Syncing the **`components/ui/` primitives only** (Button, Input, Textarea, Field, Card,
  Badge, Spinner, StarRating, Modal, ToastProvider). These are pure React + Tailwind, no app
  coupling.
- **Deliberately excluded:** all feature components (`TasteHero`, `SwipeCard`, modals, nav,
  wizard, banners). They fetch from the FastAPI backend via SWR / `@/lib/api`, use
  `next/navigation` / `next/image`, and are finished features, not reusable design-system
  blocks. Handed to Claude Design as screenshot reference instead.

## Repo shape gotchas (this is a Next.js app, not a component package)
- **No `dist/` and no shipped `.d.ts`** → synth-entry mode (`deriveComponentsFromSrc`). `.d.ts`
  contracts are extracted from the `.tsx` sources by ts-morph, so they're weaker than a real
  build would give. Acceptable for primitives.
- **Package resolution needs a junction.** `PKG_DIR = join(node_modules, pkg)`, but npm never
  self-installs the app into its own `node_modules`. Fix: a directory junction
  `frontend/node_modules/mylibrary-frontend -> frontend` (created with PowerShell
  `New-Item -ItemType Junction`; gitignored, **recreate per clone**). `--node-modules` points
  at `frontend/node_modules`; `pkg` = `mylibrary-frontend`; `srcDir` = `components/ui` scopes
  discovery to just the primitives.
- **Reused existing `frontend/node_modules`** instead of `npm ci` (lockfile-consistent, active
  dev tree) to save time. Re-run `npm ci` in `frontend/` if anything looks stale.

## Styling (Tailwind + CSS-variable tokens)
- Styling is Tailwind utility classes + `:root` CSS vars from `app/globals.css`. There is no
  compiled component stylesheet, so `cssEntry` points at a **generated** file:
  `frontend/.design-sync-build/ds.css`, compiled by `buildCmd` (Tailwind CLI over
  `ds-input.css` + `tailwind.ds.cjs`).
- `ds-input.css` bakes in the full `:root` token block AND the `--font-*` family definitions
  (which normally come from `next/font` at runtime and would be undefined in a standalone
  bundle). Content scan covers `components/ui/**` + `../.design-sync/previews/**`, so **re-run
  `buildCmd` after adding/editing previews** or new utility classes won't be in `ds.css`.
- **Fonts load remotely** (Google Fonts `@import` in `ds-input.css`: Bricolage Grotesque /
  Inter / JetBrains Mono) → validate will report `[FONT_REMOTE]` (informational). Brand fonts
  are NOT shipped as woff2; they load at runtime, which is fine for design previews.

## Known render warns (triaged benign — re-syncs should ignore these)
- `[RENDER_THIN] StarRating` — StarRating renders SVG stars with no text, so the
  "no text / paints nothing" heuristic misfires. Screenshots confirm stars render
  correctly (Ratings/Interactive/Larger cells). Benign.
- `[FONT_REMOTE]` Inter / JetBrains Mono / Bricolage Grotesque — fonts load via a remote
  Google Fonts `@import` (see Styling section). Expected, informational.

## Styling toolkit (safelist)
- `tailwind.ds.cjs` safelists the full brand token vocabulary (bg/text/border for every
  token color + `font-display/sans/mono`) AND a composition toolkit (flex/grid/gap/
  spacing/sizing/rounded/text-size/font-weight). This is deliberate: designs built in
  Claude Design receive ONLY the shipped `styles.css`, so any class the design agent uses
  must be compiled into `ds.css` — not just the classes the primitives happen to use.
  If the agent needs a utility that renders unstyled, widen the safelist and re-run
  `buildCmd`.

## Re-sync risks
- The junction and `frontend/.design-sync-build/` are gitignored — a fresh clone must recreate
  the junction and re-run `buildCmd` before the converter.
- `ds.css` is only as complete as its content scan — a preview using a utility not present in
  `components/ui` needs a `buildCmd` re-run before that class renders.
