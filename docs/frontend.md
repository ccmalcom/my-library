# Frontend — MyLibrary

Next.js (App Router) + React + Tailwind + SWR (data fetching) + framer-motion (swipe).
Pure HTTP client of the FastAPI engine — no DB access, no migrations.

## Auth (Supabase, auth-only)

Supabase is used purely to get a session — never to query tables (the FastAPI backend owns data). `utils/supabase/client.ts` is the singleton browser client; `authEnabled` is false when the `NEXT_PUBLIC_SUPABASE_*` env vars are absent, so **local dev runs unauthenticated exactly as before**. `lib/api.ts` `authHeaders()` attaches the session's `access_token` as `Authorization: Bearer` on every request (the backend verifies it via JWKS). `middleware.ts` refreshes the session and redirects unauthenticated users to `/login` (no-op in local mode); `app/login` is the email+password sign-in (invite-only, no sign-up form). Supabase publishable key env var is `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.

**Auth boundaries do a FULL document load, not client-side nav** (`window.location.assign`): sign-in, sign-out, and destructive clear-library / delete-account actions all hard-reload. The SWR cache + component state (notably `LibraryGate`'s latch) are in-memory and global, so a client-side `router.push` after these leaks previous user's state until a manual refresh. Don't revert these to `router.push`/`replace`. `app/auth/callback` (invite-link landing page — see `docs/hosting.md` Admin console notes) follows the same rule for its post-password-set and error-state navigations.

**Invite/recovery links must land on `/auth/callback`** (the only page that consumes the hash tokens and prompts for a password). For that, Supabase must be told to redirect there — which requires **both** the Railway backend env `FRONTEND_URL` (so `supabase_admin.invite_user` sends `redirect_to=…/auth/callback`) **and** that exact URL in the Supabase dashboard's Auth → URL Configuration → **Redirect URLs** allowlist. If either is missing, GoTrue silently falls back to the project Site URL (bare app root), which `middleware.ts` bounces to `/login` with the tokens stranded in the URL hash. As a safety net, `app/login` forwards any invite/recovery hash to `/auth/callback` via `lib/authRedirect.ts` (`inviteCallbackRedirect`) so onboarding still completes even when that config is wrong.

## Key files

- `lib/api.ts` — single typed fetch client. All calls go through it; `BASE` is `NEXT_PUBLIC_API_URL` (default `http://127.0.0.1:8000`). Types here mirror the Pydantic schemas. `PROFILE_STATUS_KEY` is the shared SWR key for `/profile/status` so a mutation anywhere can revalidate the re-profile banner. `DIRECTIVE_KEY` is the shared SWR key for the custom-instructions record (`Directive` / `DirectiveConstraints` / `DirectiveDraft` types; `getDirective` / `putDirective` / `deleteDirective` / `draftDirective` calls hitting `GET/PUT/DELETE /directive` + `POST /directive/draft`).
- `app/providers.tsx` — client component wrapping `(main)` layout children with a global `SWRConfig` (`revalidateOnFocus: false`, `dedupingInterval: 30_000`). Prevents refetch thrash when switching browser tabs; per-page `useSWR` keys are unchanged.
- `lib/bookLinks.ts` — pure function `bookLinks(book)` returning `{ label, href }[]` for Amazon, Bookshop.org, and WorldCat. Uses ISBN13 when present, falls back to title+author search query.
- `lib/authRedirect.ts` — pure `inviteCallbackRedirect(hash)`: returns the `/auth/callback` URL (hash preserved) when a URL hash carries Supabase invite/recovery tokens or an auth error, else `null`. Used by `app/login` to rescue misdirected invite links (see Auth section).
- `lib/authCallback.ts` — pure `parseAuthCallbackHash(hash)`: classifies the callback hash as `error` (reused/expired link), `tokens` (implicit-grant `access_token`+`refresh_token`), or `none`. Used by `app/auth/callback` to consume the tokens itself (see Auth section for why the SSR client can't).
- `lib/tasteAccent.ts` — maps 4-letter archetype code to one of 16 curated HSL colors (warm for Immersive types, cool for Reflective); falls back to hash-derived color.

## Routes (`app/`)

- `/` — dashboard: greeting "Hey, {displayName}." with `text-user`; compact archetype callout badge+name linking to `/profile`; stats strip with numbers in `text-user`; ratings bars in `bg-user`; run-recommend CTA. `--user-accent` is set on the outer wrapper so all `text-user`/`bg-user` tokens pick up the archetype color.
- `/swipe` — rec swiping. `already_read` lands the book on the read shelf then prompts a review.
- `/discover` — natural-language discovery ("find me a book like X"). A search box posts
  `POST /discover`; renders the interpretation echo ("Looking for: …"), a ranked list of real
  catalog matches with a per-result rationale, and "Add to to-read" per result (routes through
  the existing `POST /books`). **Ephemeral** — results are not persisted and never touch the
  recommendations feed / swipe deck. Reachable from a NavBar "Discover" link and a home-page CTA
  (not in `BottomNav`, which stays at 5 items — the home CTA covers mobile).
- `/to-read` — per-book: start reading / mark finished → review / remove.
- `/library` — rated books; click a row to re-rate/review; "N books waiting on a rating" button steps through unrated read books; **+ Add book** button opens `AddBookModal`; "N books need a match check" button (shown whenever any book across all four shelves has `confidence_label === 'LOW'`) steps through `EnrichmentCorrectionModal`.
- `/profile` — `TasteHero` archetype card at top; taste traits with inline editing, `CustomInstructions` editor, rating distribution, genre breakdown.
- `/setup` — CSV import wizard plus a no-CSV "add books manually" branch (`ManualStep`). Now a thin wrapper around `components/SetupWizard.tsx`. `UploadStep` also links a downloadable blank template (`public/mylibrary-template.csv`, headers = the `canonical` import format) for testers with no Goodreads/StoryGraph export — fills through the same upload/`detect_format` path, no separate code path.
- `/settings` — API key management, **Claude usage this month** panel, + Danger Zone.
  The usage panel (`getUsage` / `USAGE_KEY` SWR call) shows month-to-date spend vs. the
  soft cap as a progress bar, a per-operation cost breakdown (`by_operation`), an
  "Approaching cap" badge when `usage.warn` is true, and a footnote clarifying it's a
  soft cap for visibility only — recommendations and profiling never stop running.
- `/admin` — admin console (invite/revoke users, view roster). Only reachable by users in the `ADMIN_EMAILS` allowlist; in local mode all users can access it.
- `/auth/callback` — public (middleware's `PUBLIC_PREFIXES` includes `/auth`) landing page for Supabase invite links. Client-only: parses the session tokens Supabase puts in the URL hash (`lib/authCallback.ts`) and establishes the session via `supabase.auth.setSession(...)`, then prompts the invited user (no password yet) to set one before hard-reloading into `/`. **It must call `setSession` itself and cannot rely on the client auto-detecting the hash:** `@supabase/ssr` hardcodes `flowType: 'pkce'`, and invite/recovery links use the implicit grant (tokens in the hash), which auth-js refuses to auto-consume under PKCE (`_getSessionFromURL` throws "Not a valid PKCE flow url"). `setSession` ignores `flowType` and persists to the same cookie storage so middleware sees the session. `/login` forwards any invite/recovery hash here as a fallback (see Auth section).

`layout.tsx` mounts `NavBar` + `ReprofileBanner` + `UsageWarningBanner` + `FeedbackLauncher` + `BottomNav` above/below all pages and wraps `children` in **`LibraryGate`**. The root `app/layout.tsx` `<body>` carries `suppressHydrationWarning` (browser extensions mutate `<body>` pre-hydration — silences benign attribute mismatches only).

## Components

- **`LibraryGate`** — gates `/`, `/swipe`, `/library` behind having a library. Renders `SetupWizard` inline when `stats.total === 0`, otherwise the page. Decision is **latched** on first stats load so ingesting books mid-wizard doesn't swap it out. `/profile`, `/to-read`, `/settings` are never gated — `/settings` must stay reachable to add the Anthropic key before profiling.
- **`SetupWizard`** — the onboarding flow. Takes optional `onComplete` so it can be used both at `/setup` and inline by the gate. First step is always `ApiKeyStep` (auto-advances if key already configured). CSV path (ingest + enrich) is required two-step — no "skip enrichment". Manual path (`ManualStep`) skips enrich: manual adds already carry catalog metadata.
- **`TasteHero`** — archetype-first profile card (profile page only, NOT on home page). Render states: (1) loading skeleton, (2) no-profile CTA, (3) no-archetype CTA, (4) full archetype display (code badge + subtitle + name + tagline + trait chips + axis bars). Axis bars: `axis-name | bar | winning-letter + winning-label [why]` — left-aligned. Trait chips expand on click (truncated at 60 chars). Footer: Re-derive (ghost) + Share buttons; stale warning when `is_stale`.
- **`ArchetypeShareModal`** — canvas share image using archetype color.
- **`ArchetypeExplainerModal`** — static inline component in `TasteHero.tsx` (not a separate file). Explains the 4 axes. Opened via "What is this?" link.
- **`BookEditModal`** — re-rate + review; diff-based save; optional `queuePosition`/`onFinishQueue` for step-through review queue; opt-in `allowRemove` shows two-step "Remove" → `DELETE /books/{id}` (passed only by Library row editor).
- **`BookDetailModal`** — read-only detail view for a To-Read book: cover, description, "find it" links via `lib/bookLinks.ts`, shelf actions, and a "Find similar reads" button opening `SimilarBooksModal`. Used by `ToReadTab`.
- **`SimilarBooksModal`** — opened from `BookDetailModal`'s "Find similar reads" button.
  Fetches `POST /books/{id}/similar` on open and renders an **ephemeral** ranked list
  (rationale per result). Results are not persisted; "Add to to-read" routes through the
  existing `POST /books` add path. Does not touch the main recommendations feed / swipe deck.
- **`AddBookModal`** — manual add: debounced `/catalog/search` → pick a real result → optional shelf + star rating + review text → `POST /books`. Used by Library page and setup wizard manual branch.
- **`EnrichmentCorrectionModal`** — Wave 3c "fix match" queue: reuses `AddBookModal`'s debounced `/catalog/search` pick pattern (title/author/cover/subjects/description only — no shelf/rating/review) to re-point a mis-resolved book's enrichment via `PATCH /books/{id}/enrichment`. Supports the same `queuePosition`/`onFinishQueue` step-through convention as `BookEditModal`'s review queue. Orchestrated at the `/library` page level (not per-tab) because a LOW-confidence book can be on any shelf.
- **`ReprofileBanner`** — app-wide; shows only when `/profile/status` reports `dirty`, runs `/profile/update`.
- **`UsageWarningBanner`** — app-wide, mounted in `(main)/layout.tsx` above the page content. Reads `GET /settings/usage` (`getUsage` / `USAGE_KEY`); renders nothing until `usage.warn` is true. Shows spend-vs-cap copy + a "Details" link to `/settings` and a **Dismiss** button (local `useState`, no persistence — reappears on next page load while `warn` stays true). Purely informational; never blocks any action.
- **`NavBar`** — on mobile shows only logo + LogOut icon; full link row is `hidden sm:flex`. Conditionally renders an "Admin" link when `me?.is_admin` is true (fetched via `adminMe` SWR call).
- **`BottomNav`** — fixed bottom nav for mobile (`sm:hidden`); 5 items (Home/Swipe/Library/Profile/Settings); accent color on active route.
- **`SwipeCard`** — `useReducedMotion()` disables rotation/spring.
- **`CustomInstructions`** (`components/CustomInstructions.tsx`) — the custom-instructions editor mounted on `/profile`. A `Textarea` bound to the directive `nl_text` (source of truth), derived constraint `Badge` chips, Save (`putDirective`) and Clear (`deleteDirective`) actions, all keyed on `DIRECTIVE_KEY`. A "Help me write this" button opens `DirectiveChat`; applying a draft seeds the local textarea + constraint state (nothing is saved until Save). The textarea works standalone with zero chat use.
- **`DirectiveChat`** (`components/DirectiveChat.tsx`) — bounded elicitation drawer (a `Modal`). One stateless turn: the reader types prose, `draftDirective` (`POST /directive/draft`) returns a `{proposed_text, constraints, conflicts, assistant_message}` proposal, conflicts render in a warning box, and "Use this" calls `onApply(proposedText, constraints)` back into `CustomInstructions`. No persisted transcript; the draft is ephemeral until the parent saves.
- **`RevealSequence`** (`components/reveal/`) — the nine-beat "Wrapped" profile reveal (`revealFrame.tsx` full-screen shell + progress dots, `TraitBeats.tsx` reward/aversion cards, `RevealSequence.tsx` orchestrator). Beats are built by the pure `lib/revealBeats.ts#buildBeats` (jest-tested) from `stats` + `traits` + `archetype` + `profile_highlights` + `books` + `directive`; thin libraries (< 8 loved / < 12 rated) compress to cold-open → numbers → up to 2 reward traits → finale → directive → handoff. A terminal `directive` beat surfaces the reader's standing custom instructions (or a CTA to add them) just before the handoff — the directive fetch (`DIRECTIVE_KEY` / `getDirective`) is intentionally NOT in the `ready` gate since a reader may have none. Trait verdicts (confirm/reject/edit) reuse the existing `PATCH /profile/traits/{id}` contract (`setTraitVerdict` / `api.updateTrait`) — no new data model. Entry points: a "Replay my reveal" link on `/profile` (once traits exist) and the `SetupWizard` "done" beat ("Show me what you found") for newly profiled users. `useReducedMotion()` drops the staggered fade.

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
