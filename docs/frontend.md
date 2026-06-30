# Frontend — MyLibrary

Next.js (App Router) + React + Tailwind + SWR (data fetching) + framer-motion (swipe).
Pure HTTP client of the FastAPI engine — no DB access, no migrations.

## Auth (Supabase, auth-only)

Supabase is used purely to get a session — never to query tables (the FastAPI backend owns data). `utils/supabase/client.ts` is the singleton browser client; `authEnabled` is false when the `NEXT_PUBLIC_SUPABASE_*` env vars are absent, so **local dev runs unauthenticated exactly as before**. `lib/api.ts` `authHeaders()` attaches the session's `access_token` as `Authorization: Bearer` on every request (the backend verifies it via JWKS). `middleware.ts` refreshes the session and redirects unauthenticated users to `/login` (no-op in local mode); `app/login` is the email+password sign-in (invite-only, no sign-up form). Supabase publishable key env var is `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.

**Auth boundaries do a FULL document load, not client-side nav** (`window.location.assign`): sign-in, sign-out, and destructive clear-library / delete-account actions all hard-reload. The SWR cache + component state (notably `LibraryGate`'s latch) are in-memory and global, so a client-side `router.push` after these leaks previous user's state until a manual refresh. Don't revert these to `router.push`/`replace`.

## Key files

- `lib/api.ts` — single typed fetch client. All calls go through it; `BASE` is `NEXT_PUBLIC_API_URL` (default `http://127.0.0.1:8000`). Types here mirror the Pydantic schemas. `PROFILE_STATUS_KEY` is the shared SWR key for `/profile/status` so a mutation anywhere can revalidate the re-profile banner.
- `app/providers.tsx` — client component wrapping `(main)` layout children with a global `SWRConfig` (`revalidateOnFocus: false`, `dedupingInterval: 30_000`). Prevents refetch thrash when switching browser tabs; per-page `useSWR` keys are unchanged.
- `lib/bookLinks.ts` — pure function `bookLinks(book)` returning `{ label, href }[]` for Amazon, Bookshop.org, and WorldCat. Uses ISBN13 when present, falls back to title+author search query.
- `lib/tasteAccent.ts` — maps 4-letter archetype code to one of 16 curated HSL colors (warm for Immersive types, cool for Reflective); falls back to hash-derived color.

## Routes (`app/`)

- `/` — dashboard: greeting "Hey, {displayName}." with `text-user`; compact archetype callout badge+name linking to `/profile`; stats strip with numbers in `text-user`; ratings bars in `bg-user`; run-recommend CTA. `--user-accent` is set on the outer wrapper so all `text-user`/`bg-user` tokens pick up the archetype color.
- `/swipe` — rec swiping. `already_read` lands the book on the read shelf then prompts a review.
- `/to-read` — per-book: start reading / mark finished → review / remove.
- `/library` — rated books; click a row to re-rate/review; "N books missing reviews" button steps through unrated read books; **+ Add book** button opens `AddBookModal`.
- `/profile` — `TasteHero` archetype card at top; taste traits with inline editing, rating distribution, genre breakdown.
- `/setup` — CSV import wizard plus a no-CSV "add books manually" branch (`ManualStep`). Now a thin wrapper around `components/SetupWizard.tsx`.
- `/settings` — API key management + Danger Zone.

`layout.tsx` mounts `NavBar` + `ReprofileBanner` + `BottomNav` above/below all pages and wraps `children` in **`LibraryGate`**. The root `app/layout.tsx` `<body>` carries `suppressHydrationWarning` (browser extensions mutate `<body>` pre-hydration — silences benign attribute mismatches only).

## Components

- **`LibraryGate`** — gates `/`, `/swipe`, `/library` behind having a library. Renders `SetupWizard` inline when `stats.total === 0`, otherwise the page. Decision is **latched** on first stats load so ingesting books mid-wizard doesn't swap it out. `/profile`, `/to-read`, `/settings` are never gated — `/settings` must stay reachable to add the Anthropic key before profiling.
- **`SetupWizard`** — the onboarding flow. Takes optional `onComplete` so it can be used both at `/setup` and inline by the gate. First step is always `ApiKeyStep` (auto-advances if key already configured). CSV path (ingest + enrich) is required two-step — no "skip enrichment". Manual path (`ManualStep`) skips enrich: manual adds already carry catalog metadata.
- **`TasteHero`** — archetype-first profile card (profile page only, NOT on home page). Render states: (1) loading skeleton, (2) no-profile CTA, (3) no-archetype CTA, (4) full archetype display (code badge + subtitle + name + tagline + trait chips + axis bars). Axis bars: `axis-name | bar | winning-letter + winning-label [why]` — left-aligned. Trait chips expand on click (truncated at 60 chars). Footer: Re-derive (ghost) + Share buttons; stale warning when `is_stale`.
- **`ArchetypeShareModal`** — canvas share image using archetype color.
- **`ArchetypeExplainerModal`** — static inline component in `TasteHero.tsx` (not a separate file). Explains the 4 axes. Opened via "What is this?" link.
- **`BookEditModal`** — re-rate + review; diff-based save; optional `queuePosition`/`onFinishQueue` for step-through review queue; opt-in `allowRemove` shows two-step "Remove" → `DELETE /books/{id}` (passed only by Library row editor).
- **`BookDetailModal`** — read-only detail view for a To-Read book: cover, description, "find it" links via `lib/bookLinks.ts`, shelf actions. Used by `ToReadTab`.
- **`AddBookModal`** — manual add: debounced `/catalog/search` → pick a real result → optional shelf + star rating + review text → `POST /books`. Used by Library page and setup wizard manual branch.
- **`ReprofileBanner`** — app-wide; shows only when `/profile/status` reports `dirty`, runs `/profile/update`.
- **`NavBar`** — on mobile shows only logo + LogOut icon; full link row is `hidden sm:flex`.
- **`BottomNav`** — fixed bottom nav for mobile (`sm:hidden`); 5 items (Home/Swipe/Library/Profile/Settings); accent color on active route.
- **`SwipeCard`** — `useReducedMotion()` disables rotation/spring.

**Both `BookEditModal` and `AddBookModal`** enforce the review-requires-rating invariant client-side (save/add disabled + amber hint when review text entered with 0 rating). Both use `components/ui/Modal` (focus trap + Escape + `role="dialog"`) and call `useToast()` for feedback.

Re-profiling is **never automatic** in the UI: editing a book marks the profile dirty, the banner appears, and the user chooses when to spend the Claude call.

## UI primitives (`components/ui/`)

`Button` (variants + loading), `Card`, `Badge`, `Input`, `Textarea`, `Field` (render-prop: wires `htmlFor`/`aria-describedby`/`aria-invalid` automatically), `Spinner`, `StarRating` (keyboard-accessible radiogroup), `Modal` (focus trap + Escape-to-close + `role="dialog"` + focus restore on unmount), `ToastProvider` + `useToast()` hook (success/error/info; `role="alert"` for errors; auto-dismiss 4.5s; mounted in `(main)/layout.tsx`).

## Design system

CSS variables in `globals.css`: `--bg #161412`, `--accent #FF5C3A` (persimmon), `--user-accent` per-user at runtime. Mirrored into `tailwind.config.ts` as token classes (`bg-base`, `text-accent`, etc.). Fonts: Bricolage Grotesque (display), Inter (body), JetBrains Mono (data labels) loaded via `next/font/google`.

## Mobile / tablet

- **`BottomNav`** (`components/BottomNav.tsx`) — fixed bottom nav (`sm:hidden`). `(main)/layout.tsx` bumps bottom padding to `pb-24 sm:pb-16`.
- Stats strip: `grid-cols-2 sm:grid-cols-4`; `divide-x`/`-mx-1` confined to `sm:`.
- Swipe card stack: `h-[440px] sm:h-[560px]`.
- Library search input: `min-w-0` (was `min-w-40`) so it shrinks on narrow screens.
- Genre breakdown labels: `w-24 sm:w-40`; genre filter row: `flex-wrap`.
- SetupWizard: drop zone padding `p-6 sm:p-10`; outer wrapper `py-6 sm:py-12`.

## Accessibility

Modals trap focus + Escape + restore. `useReducedMotion()` in SwipeCard. `motion-safe:animate-pulse/spin` on skeletons/spinners. `aria-live` regions via toast roles. All cover `<img>` have `alt`. Focus-visible rings on all interactive elements. No `window.confirm` anywhere (ToReadTab uses inline two-step confirm).
