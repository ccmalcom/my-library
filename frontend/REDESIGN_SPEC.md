# MyLibrary Frontend — Pre-Beta Redesign & Polish Spec

> **For the build agent:** this is a self-contained, agentic implementation spec. Execute it in
> the ordered phases below. Each phase names exact files, concrete tokens, acceptance criteria,
> and verification. Read the **Build conventions** section before editing any `.tsx` file.

---

## Context — why this work

MyLibrary's frontend is **structurally solid** (good loading/empty states in most places,
two-step destructive confirms, labeled inputs) but carries two "iterated-fast-with-AI" tells
that need fixing before a beta / portfolio release:

1. **The visual design is the generic AI-default dark theme.** Cool near-black slate
   (`#0f1117`) + blue/green/red/amber accents, **system fonts only** (`--font-geist-sans` is
   referenced in `tailwind.config.ts` but never declared), emoji as icons (book / star), and a
   token system that is *defined but unused* (every component hardcodes `bg-[#1a1f2e]` etc.). It
   reads as templated.
2. **Accessibility & interaction gaps** — modals don't trap focus or close on Escape,
   animations ignore `prefers-reduced-motion`, several covers have empty `alt`, focus rings are
   removed without replacement, and errors are inline-only (easy to miss).

**Decided direction (locked with the owner):** a clean, modern, **warm-dark** identity whose
**signature is personalization** — the app opens by telling you something true and specific about
*your* taste (Spotify's "it knows me" feeling), not a generic dashboard. We chase that feeling
without copying Spotify's literal palette (near-black + acid green), which is itself the most
common AI-default dark theme.

**Scope (all selected):** distinctive visual identity + accessibility fixes + state/feedback
polish + design-system refactor.

**Hard constraint:** the frontend is a pure HTTP client of the FastAPI engine (Pattern B).
**No backend changes.** Reuse existing `lib/api.ts` methods only. The taste hero is derived
client-side from data the API already returns (traits + subjects).

---

## Design system (the locked token system)

### Concept
**"MyLibrary knows you."** The hero of the app is the user's generated taste identity, rendered
as a bold typographic statement with a per-user color, surfaced on the **dashboard** (not buried
in `/profile`). Everything else is quiet and clean so the personal moment is the one memorable
thing.

### Color — warm dark (NOT cool slate)
Define as CSS variables in `globals.css` and mirror into `tailwind.config.ts` theme tokens.

```
/* base */
--bg:        #161412   /* warm charcoal — brown-tinted, deliberately NOT slate #0f1117 */
--surface:   #1F1B18   /* card */
--elevated:  #2A2420   /* raised card / modal */
--border:    #3A332D   /* warm hairline */
--hairline:  #2A2420   /* subtle dividers */

/* text */
--text:      #F5F0E8   /* warm white */
--muted:     #A89F92   /* warm gray */
--faint:     #6E665C   /* captions / disabled */

/* brand + semantics */
--accent:        #FF5C3A   /* persimmon — the single brand accent */
--accent-hover:  #FF7355
--accent-quiet:  rgba(255,92,58,0.12)   /* tints / washes / selected bg */
--success:       #5BBF7B   /* used ONLY for success states, never as brand */
--danger:        #E0524B   /* destructive / reject — distinct from persimmon by context+label */
--warning:       #F5B82E
```

Rules:
- **One accent.** Persimmon is the brand. Do not reintroduce blue as a primary action color.
- **Green is success-only**, never brand or navigation (this is what separates us from the
  Spotify/AI-default look).
- **Per-user accent** (`--user-accent`) is set at runtime from the user's data (see Signature).
  It washes the taste hero and the profile header. Fallback = persimmon.

### Type
Load via `next/font/google` in `app/layout.tsx` and expose as CSS variables.

| Role     | Family               | Usage                                                        |
|----------|----------------------|-------------------------------------------------------------|
| Display  | **Bricolage Grotesque** (700/800) | Hero statements, page titles, big numbers. Characterful, modern, NOT a default Inter-everywhere look. |
| Body     | **Inter** (400/500/600) | All body copy, labels, buttons.                          |
| Mono     | **JetBrains Mono** (400/500) | Data labels: counts, confidence (HIGH/MED/LOW), IDs, "data lines". |

Type scale (Tailwind classes, tight tracking on display):
- Hero: `text-5xl sm:text-6xl font-extrabold tracking-tight` (display font, `leading-[1.03]`)
- Page title (h1): `text-3xl font-bold tracking-tight` (display)
- Section (h2): `text-lg font-semibold` (display)
- Body: `text-sm`/`text-base` (Inter)
- Eyebrow / data label: `text-xs font-medium uppercase tracking-widest` (mono), color `--muted`

### Layout & structure
- Keep the centered `max-w-4xl` main column, but the **dashboard leads with the taste hero**,
  then demotes stats to a secondary strip, then the recommend CTA.
- Structural device = the **taste trait itself** + a small mono "data line"
  (e.g. `LITERARY FICTION · 42 books · HIGH`). Do **not** add decorative numbered markers
  (01/02/03) — the content is not a sequence.

### Signature element — the Taste Hero
A generated, per-user block (new component `components/TasteHero.tsx`):
- Pulls the user's top taste trait and renders its claim in **huge display type**, with the key
  phrase emphasized in the per-user accent.
- A row of the remaining traits as quiet chips (mono data line under each on hover/secondary).
- A per-user color wash (`--user-accent`) behind/around the statement.
- Empty state: if no profile yet, the hero becomes an inviting "Build your taste profile" CTA
  (reuse existing `BuildProfileCTA` logic from `profile/page.tsx`).
- Reused in condensed form as the `/profile` page header.

`lib/tasteAccent.ts` — deterministic seed → accessible hue:
- Input: a stable seed (the user's dominant genre/subject string from `/profile/subjects`,
  falling back to the top trait claim, falling back to a constant).
- Output: an HSL string constrained to a curated, warm, vivid, dark-bg-legible range
  (e.g. hue any, `S 70-85%`, `L 58-66%`). Set it on a wrapping element as
  `style={{ ['--user-accent' as string]: hsl }}`.
- Pure, no network, memoizable. Fallback to persimmon when no data.

### Self-critique vs. the three AI defaults (passed)
- **Not** default #1 (cream + serif + terracotta): it's dark, the display face is a grotesque
  not a serif, and persimmon is a bright modern red-orange, not earthy terracotta.
- **Not** default #2 (near-black + acid green): base is *warm* charcoal `#161412` (brown-tinted,
  not slate/black), the accent is persimmon, and green is restricted to success states.
- **Not** the templated dashboard (big number + label + gradient): the hero is a *typographic
  personal statement*; stats are demoted to a secondary strip.

---

## Build conventions (MUST follow — from CLAUDE.md)

These are hard rules for editing `.tsx` files in this repo. Violating them breaks the Turbopack build.

- **No non-ASCII inside JS string literals in `.tsx`.** Em dashes, curly quotes, ellipses, etc.
  are fine in JSX *text nodes* (between tags) but NOT inside `"..."`/`'...'` JS string values.
  Use ASCII (`-`, `...`) or unicode escapes (`—`) in string literals.
- **No IIFEs inside JSX** (`{(() => {...})()}`) — compute derived values as plain variables
  above the `return`, then reference them.
- **Edit tools inject curly/smart quotes into `.tsx` string literals.** After editing any `.tsx`
  with string literals in className arrays/ternaries, run the fix from CLAUDE.md
  (replace the UTF-8 bytes for curly double-quotes with `"`). Prefer **single-quoted** strings in
  className arrays.
- **Never run git state-mutating commands** (`stash`/`checkout`/`reset`/`commit`). Read history
  with read-only commands only; verify edits by re-reading files. The owner controls git.
- **Windows PowerShell**: no `&&`. Chain with `;` + `if ($?) { ... }`.
- Frontend commands run from `frontend/`: `npm run dev`, `npm run build`, `npm run lint`.
- **Manual check at end of each session:** for phases that produce new components not yet wired
  into any real route, create a temporary `app/ui-test/page.tsx` that renders every variant,
  verify visually + keyboard, then delete it. For phases that restyle existing routes, run
  `npm run dev` and navigate to each changed page. This is always the last step before calling
  a session done.

---

## Phase 0 — Verify the login "Enter does not submit" bug (do first)

The current `app/login/page.tsx` **already** uses a real `<form onSubmit={handleSubmit}>` with a
`type="submit"` button and two inputs — native Enter-to-submit *should* work. **Do not blindly
patch correct code.** Reproduce first.

1. `cd frontend; npm run dev`. Open `/login`. Type into a field, press Enter.
2. If it submits -> the bug is already fixed; note it and move on.
3. If it does NOT submit, diagnose the real cause (in priority order):
   - **Hydration failure** — check the browser console for hydration errors; if the page isn't
     hydrating, neither Enter nor a real submit handler fires. Look for non-deterministic render
     or a throwing import.
   - **Local-dev auth branch** — with no Supabase env, `getSupabaseClient()` returns null and
     `handleSubmit` sets "Auth is not configured"; confirm whether the tester is actually in this
     branch (it *does* submit, just errors). If so, this is expected, not a bug.
   - Only if a genuine wiring issue is found, fix minimally.

**Acceptance:** Enter submits the login form (or a written note explaining it was already correct
/ environmental, with the console evidence). No test page needed — this is investigation only.

---

## Phase 1 — Design foundation (fonts, tokens, base colors)

Files: `app/layout.tsx`, `app/globals.css`, `tailwind.config.ts`.

1. **Fonts** — in `app/layout.tsx`, import from `next/font/google`:
   `Bricolage_Grotesque` -> `--font-display`, `Inter` -> `--font-body`, `JetBrains_Mono` ->
   `--font-mono`. Apply the three variable classes to `<html>` (keep `className="dark"`).
   Set body to use the body font.
2. **globals.css** — replace the `:root` block with the full warm-dark variable set above. Set
   `body { background: var(--bg); color: var(--text); font-family: var(--font-body)... }`.
   Add a `@layer base` rule giving display headings `font-family: var(--font-display)` where
   appropriate (or apply per-component via a `font-display` utility — see step 3).
3. **tailwind.config.ts** — rewrite `theme.extend`:
   - `colors`: `base`, `surface`, `elevated`, `border`, `hairline`, `text`, `muted`, `faint`,
     `accent` (+`accent-hover`), `success`, `danger`, `warning`, and `user` ->
     `var(--user-accent)` so `text-user`/`bg-user`/`border-user` work for the per-user accent.
   - `fontFamily`: `display: ['var(--font-display)', ...]`, `sans: ['var(--font-body)', ...]`,
     `mono: ['var(--font-mono)', ...]`. **Remove the dead `--font-geist-sans` reference.**
   - Keep `darkMode: 'class'`.
4. **app/layout.tsx body** — replace `bg-[#0f1117] text-slate-200` with token classes
   (`bg-base text-text`). Keep `suppressHydrationWarning`.

**Acceptance:** app boots with Bricolage/Inter/JetBrains loaded (verify in devtools -> no system
fallback), warm-dark background, no references to `--font-geist-sans` remain, `npm run build`
passes. **Manual check:** `npm run dev` -> open any page -> confirm warm charcoal background
(not cool slate), check devtools computed font-family on a heading (should show Bricolage
Grotesque) and on body text (Inter). No test page needed — the real app is the surface.

---

## Phase 2 — Reusable UI primitives (with a11y baked in)

Create `frontend/components/ui/`. These replace the duplicated inline styles and are where the
accessibility baseline lives, so later phases inherit it for free.

1. **`Button.tsx`** — variants `primary` (bg-accent), `secondary` (surface + border),
   `ghost`, `danger`. Sizes `sm`/`md`/`lg`. Built on `<button>`. Includes:
   `disabled:opacity-50 disabled:cursor-not-allowed`, `active:scale-95`, and a shared
   **focus-visible ring** (`focus-visible:outline-none focus-visible:ring-2
   focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-base`).
   Optional `loading` prop -> shows `<Spinner/>` and sets `disabled` + `aria-busy`.
2. **`Input.tsx` / `Textarea.tsx`** — token styles (`bg-base border-border`), focus-visible ring
   (replace the current `focus:outline-none` + border-only pattern). Forward refs. Accept
   `aria-invalid` / `aria-describedby`.
3. **`Field.tsx`** — label + control + error wrapper. Generates ids, wires `htmlFor`,
   `aria-describedby`, `aria-invalid`, and renders the error with `role="alert"`. Use everywhere
   a labeled input exists.
4. **`Card.tsx`** — `rounded-xl border border-border bg-surface p-5` (and an `elevated` variant
   for modals). Replaces the repeated card string.
5. **`Badge.tsx`** — small pill for shelves/confidence/status; mono variant for data.
6. **`Spinner.tsx`** — single canonical spinner (replaces the 3+ duplicates). Includes
   `role="status"` + `aria-label="Loading"` (overridable).
7. **`StarRating.tsx`** — accessible rating control replacing emoji-hover logic in AddBookModal
   and BookEditModal:
   - `role="radiogroup"` with `aria-label`; each star is a `<button role="radio" aria-checked>`.
   - Keyboard: Left/Right arrows change value, Home/End to min/max, number keys 1-5 set directly.
   - Visual hover preview retained for mouse; **also** works on touch/keyboard (don't rely on
     hover alone). Renders a typographic mark (not the emoji star glyph) — e.g. filled/empty
     star shapes via SVG, sized in the display font.
8. **`Toast.tsx` + `ToastProvider`** — see Phase 6.

**Acceptance:** primitives compile and are visually consistent; every interactive primitive shows
a visible focus-visible ring on keyboard focus; StarRating is fully operable by keyboard.
**Manual check:** create `app/ui-test/page.tsx` rendering all variants (see Build conventions
pattern); verify colors, focus rings, loading state, Field error wiring, StarRating keyboard
nav; delete `app/ui-test/` when done.

---

## Phase 3 — Signature: Taste Hero + per-user accent + dashboard restructure

Files: new `components/TasteHero.tsx`, new `lib/tasteAccent.ts`, rewrite
`app/(main)/page.tsx`.

1. **`lib/tasteAccent.ts`** — implement the deterministic seed->HSL util described in the design
   section. Pure + memoized.
2. **`components/TasteHero.tsx`** — reuse existing `lib/api.ts` calls (the same ones
   `profile/page.tsx` uses for traits + subjects; confirm exact method names in `lib/api.ts`).
   - Loading: skeleton block (respect reduced motion — see Phase 5).
   - No profile yet: inviting CTA (reuse `BuildProfileCTA` logic).
   - Has profile: top trait claim in hero display type with the key phrase in `text-user`;
     remaining traits as `Badge` chips; wrap in an element that sets `--user-accent` from
     `tasteAccent(seed)`.
   - Copy is **second-person and specific** ("You reward satire over realism."). Derive the
     statement from the trait claim text; keep a clean fallback if the claim is long.
3. **Rewrite `app/(main)/page.tsx`** dashboard order:
   1) `<TasteHero/>` (the signature, top of page)
   2) secondary stats strip (reuse current stat values, demoted to a single quiet row using
      `Card`/`Badge`, not four big cards leading the page)
   3) ratings breakdown (restyled with tokens; bars use `bg-accent`)
   4) "Run recommendations" CTA (use `Button`; keep the dirty/no-profile block logic + message,
      reworded to be actionable; surface errors via toast — Phase 6).
   - Add the missing **SWR error state** (currently `stats`/`profileStatus` errors are ignored).

**Acceptance:** the dashboard opens with a bold, personal, per-user statement; two different
users (or two trait sets) produce visibly different accent washes; stats are present but
secondary. **Manual check:** `npm run dev` -> navigate to `/` -> confirm TasteHero renders
above stats; inspect the per-user accent color in devtools (`--user-accent` on the wrapper
element); verify the empty-state CTA when no profile exists. The real dashboard is the
surface — no separate test page needed.

---

## Phase 4 — Restyle every surface with the new system

Apply tokens + primitives across all routes/components. Replace hardcoded hex
(`bg-[#1a1f2e]`, `text-slate-*`, `bg-blue-600`, emoji icons) with tokens/primitives. Introduce a
small icon set (e.g. `lucide-react`) to replace emoji (book / star / x / open-book / heart); add
it to `package.json`.

Per file:
- `components/NavBar.tsx` — token styles; add `aria-current="page"` on the active link; keep the
  hard-reload sign-out.
- `components/ReprofileBanner.tsx` — restyle with `Card`/`Button`; keep dirty-state logic.
- `app/(main)/swipe/page.tsx` + `components/SwipeCard.tsx` — token styles; replace emoji action
  buttons with labeled icon `Button`s (accept = accent, reject = danger/neutral outline, skip =
  ghost) — keep `aria-label`s and add visible labels/tooltips; cover `alt={`Cover of ${title}`}`.
  **Also land book-description display here (requires backend + frontend work — see below).**
- `app/(main)/library/page.tsx` — token styles; convert action buttons to `Button`; ensure all
  cover `<img>` use `alt={`Cover of ${book.title}`}` (the Read tab currently has `alt=""`);
  align loading-skeleton column count with the real list layout.
- `app/(main)/profile/page.tsx` — token styles; mount a condensed `TasteHero` as the header;
  restyle trait cards; keep inline edit + keyboard hints (also expose hint via `aria-label`).
- `app/(main)/settings/page.tsx` — wrap each input group in a real `<form onSubmit>` (replace the
  manual `onKeyDown` Enter handlers); use `Field`/`Input`/`Button`; keep `DangerAction` two-step
  pattern; add an API-key-status loading state; unify post-action behavior.
- `app/login/page.tsx` — restyle with primitives (keep the already-correct form); warmer,
  on-brand copy for the title and invite line.
- `components/SetupWizard.tsx` — token styles + primitives across steps; replace the clickable
  drop-zone `div` with a `<label>` + visually-hidden `<input type="file">` (keyboard accessible);
  remove the CLI-command leak in the manual/profile step copy (DoneStep) — phrase it as a UI
  action, not `python -m mylibrary.cli ...`.
- `components/AddBookModal.tsx`, `components/BookEditModal.tsx` — token styles; use
  `StarRating`, `Field`, `Button`; cover `alt`; (a11y wiring in Phase 5).

**Acceptance:** grep shows no remaining `bg-[#0f1117]`/`bg-[#1a1f2e]`/`#242938` literals or
`text-slate-`/`bg-blue-`/`bg-green-`-as-primary in components; no emoji used as UI icons;
`npm run build` passes. **Manual check:** `npm run dev` -> walk each restyled route
(`/`, `/swipe`, `/library`, `/profile`, `/settings`, `/login`, `/setup`) and confirm warm
tokens, icon buttons, and no hardcoded legacy colors are visible. Each restyled surface IS
the test — no separate test page needed.

---

## Phase 5 — Accessibility pass

Some of this is already handled by Phase 2 primitives; this phase closes the rest.

1. **Modals** (`AddBookModal`, `BookEditModal`, and SetupWizard if modal-like):
   - Escape closes (`onKeyDown` on the container, or a shared `useModal` hook).
   - **Focus trap** + **autofocus** first field on open + **restore focus** to the trigger on
     close. Implement a small `components/ui/Modal.tsx` (or `lib/useFocusTrap.ts`) and adopt it
     in both modals so the behavior is shared. `role="dialog"` + `aria-modal="true"` +
     `aria-labelledby`.
   - `BookEditModal` currently has no autofocus — fix.
2. **Reduced motion:**
   - `globals.css`: wrap `@keyframes fadeIn`/`.fade-in` in
     `@media (prefers-reduced-motion: no-preference)`, and add a global
     `@media (prefers-reduced-motion: reduce) { *,*::before,*::after { animation-duration:.01ms
     !important; transition-duration:.01ms !important; } }` safety net.
   - `SwipeCard.tsx`: use framer-motion's `useReducedMotion()` to disable the fly-off/spring
     animations (keep drag, drop the decorative spring).
   - Skeletons: use `motion-safe:animate-pulse` and spinners `motion-safe:animate-spin`.
3. **Alt text:** every cover `<img>` -> `alt={`Cover of ${title}`}` (fix Read tab line ~186,
   AddBookModal ~154/188, SetupWizard ~460). Decorative-only images keep `alt=""`.
4. **Focus rings:** ensure no remaining `focus:outline-none` without a `focus-visible` ring
   (primitives cover most; sweep for stragglers).
5. **aria / labels:** `aria-current` on NavBar (Phase 4); `aria-live="polite"` regions for async
   status text ("Saving...", "Saved", enrich progress); spinner `role="status"` (primitive).
6. **Drop zone** (SetupWizard) — keyboard-accessible `<label>`+hidden input (Phase 4).

**Acceptance:** keyboard-only walkthrough of login -> setup -> dashboard -> a modal works end to
end (Tab/Shift-Tab/Enter/Escape/Arrows); macOS/Windows reduced-motion setting visibly calms the
UI; an automated check (axe DevTools or Lighthouse a11y) shows no critical violations.
**Manual check:** `npm run dev` -> full keyboard walkthrough as described; toggle OS
reduced-motion and reload to confirm animations calm; run axe DevTools or Lighthouse a11y audit
on at least the dashboard and one modal. The real UI is the test surface.

---

## Phase 6 — State / feedback polish

1. **Toast system** — `components/ui/Toast.tsx` + `ToastProvider` mounted in
   `app/(main)/layout.tsx`. A `useToast()` hook with `toast.success/error/info`. Toasts are
   `aria-live="polite"` (errors `assertive`), auto-dismiss, dismissible.
2. **Replace easy-to-miss inline errors / silent failures with toasts** where appropriate:
   - Swipe page currently `console.error`s swallowed failures -> toast on failure.
   - Dashboard recommend error, AddBook/BookEdit save errors, trait save, settings save ->
     success/error toasts (keep inline field errors for validation via `Field`).
   - Add SWR error states where missing (dashboard, swipe, `LibraryGate`).
3. **Replace `window.confirm`** (Library ToReadTab remove) with an inline two-step confirm —
   reuse the existing `DangerAction` pattern (settings) or `BookEditModal`'s `allowRemove`
   two-step. No native dialogs anywhere.
4. **Consistency:** every create/edit/rate/remove gives explicit confirmation (toast or optimistic
   update); every empty state is an inviting CTA (audit Library Read-tab empty-shelf vs.
   no-filter-match messaging).

**Acceptance:** no `window.confirm`/`alert` remain; every async action surfaces success and
failure; errors are visible regardless of scroll position. **Manual check:** `npm run dev` ->
trigger a save success (re-rate a book), a forced failure (submit with bad API key), and
the remove-book flow; confirm toasts appear and the old `window.confirm` is gone. The real
UI is the test surface.

---

## Verification (end to end)

Run from `frontend/`:
1. `npm run lint` — clean.
2. `npm run build` — passes (Turbopack; watch for the non-ASCII-in-string-literal and
   curly-quote errors called out in conventions — fix per the CLAUDE.md snippet if they appear).
3. `npm run dev` and manually verify:
   - **Login:** Enter submits (Phase 0).
   - **Dashboard:** opens with the Taste Hero; per-user accent renders; stats secondary.
   - **Fonts:** Bricolage/Inter/JetBrains active (devtools computed styles), no system fallback.
   - **Modals:** Escape closes, focus trapped, focus restored, first field autofocused.
   - **Keyboard:** full keyboard pass incl. StarRating arrows and swipe actions.
   - **Reduced motion:** OS setting calms animations.
   - **Toasts:** trigger a save success and a forced failure; both announce.
   - **A11y check:** axe DevTools / Lighthouse a11y — no critical issues; covers have alt text.
4. Optional: take before/after screenshots of dashboard, profile, swipe, login for the PR.

---

## Addendum — Book description on SwipeCard (land in Phase 4)

**Problem:** The swipe page currently shows only Claude's `rationale` ("why this fits your taste")
with no real book description. Users have no way to read what the book is actually about.

**Root cause:** The `Recommendation` table has no `description` column. At recommendation time the
catalog candidate data (which includes `description` from Google Books / Open Library) is in memory
but is not persisted. `Enrichment.description` exists but recommendations are for books outside the
library so there is no `Enrichment` row to JOIN back to.

**Fix — two parts:**

Backend (`mylibrary/`):
1. Add `description: Mapped[str | None] = mapped_column(Text)` to `Recommendation` in `db.py`.
2. Add a guarded Alembic migration (idempotent `add_column`, same pattern as 0002/0003).
3. In `recommend.py`, carry `description` from the catalog candidate dict into the `Recommendation`
   row when it is written (the field is already present on candidates returned by `catalog.py`).
4. Add `description: str | None` to `RecommendationOut` in `schemas.py`.

Frontend (`frontend/`):
1. Add `description?: string` to the `Recommendation` interface in `lib/api.ts`.
2. In `components/SwipeCard.tsx` (Phase 4 restyle), render `description` below the cover/title in a
   collapsible or truncated block (e.g. 3-line clamp, "Show more" to expand). Keep `rationale`
   visible — it answers a different question ("why for you") than the description ("what is it").
   Order: cover + meta → description (what) → rationale (why for you).

**Notes:**
- The migration must be idempotent (inspect-and-skip if column already exists) because the 0001
  baseline creates tables from `Base.metadata` and a fresh `upgrade head` must not double-add.
- Candidates without a description (rare — Open Library sometimes omits it) render gracefully with
  the description block absent.
- This is the only item in the redesign that requires a backend change.

---

## Out of scope
- Any backend / FastAPI / DB / migration change (the frontend stays a pure HTTP client).
- New product features. This is identity + polish + a11y only.
- Auth flow changes beyond restyling the existing login page.

## Suggested order for the build agent
Phase 0 -> 1 -> 2 -> 3 -> (4, 5, 6 interleaved per surface, since they touch the same files) ->
final Verification. Commit per phase only when the owner asks (the owner controls git).
