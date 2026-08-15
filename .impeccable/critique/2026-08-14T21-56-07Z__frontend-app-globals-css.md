---
target: ShelfSprite frontend theme + design system
total_score: 24
p0_count: 0
p1_count: 5
timestamp: 2026-08-14T21-56-07Z
slug: frontend-app-globals-css
---
⚠️ DEGRADED: single-context (session config prohibits spawning sub-agents unless the user asks; ran Assessment A and B sequentially in one context)

Detector: `detect.mjs` over `app/` + `components/` → **0 findings, exit 0**. Verified not a false-negative by planting `border-l-4` + `bg-clip-text` in a probe file (both caught). Browser pass: **skipped** — booting the app needs Supabase env I'm not permitted to read, and provisioning the verify container is disproportionate here. Evidence below is source + computed WCAG math, not screenshots.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Skeletons, `aria-busy`, loading buttons, optimistic rollback — genuinely good. No route-transition feedback. |
| 2 | Match System / Real World | 3 | Copy is a real strength. "R" glyph for "already read"; archetype code `IPBH` shown before its name. |
| 3 | User Control and Freedom | 2 | Backdrop click silently discards an unsaved review/rating; reject modal's "Skip" actually submits the rejection. |
| 4 | Consistency and Standards | 2 | `Field`/`Input` have **0 usages**; 30+ hand-rolled controls; `text-base` means two different things. |
| 5 | Error Prevention | 2 | Two-step destructive confirms are good; unsaved-work loss and Skip/Confirm ambiguity are not. |
| 6 | Recognition Rather Than Recall | 3 | Labeled bottom nav, tab counts, "What is this?" explainer. X/R/+ glyphs undercut it. |
| 7 | Flexibility and Efficiency | 2 | Review queues are a real accelerator; zero keyboard shortcuts on the swipe deck, no bulk actions. |
| 8 | Aesthetic and Minimalist Design | 2 | Clean, but three equal-weight stacked cards on the dashboard and one eyebrow style used 27×. |
| 9 | Error Recovery | 3 | Specific, human error copy; failed swipes roll back state. Raw Supabase strings on login. |
| 10 | Help and Documentation | 2 | Archetype explainer is excellent contextual help. Nothing comparable anywhere else. |
| **Total** | | **24/40** | **Acceptable — significant improvements needed** |

## Anti-Patterns Verdict

**Does this look AI-generated? Not in the obvious way — and that's a real achievement.** The 2024 tells are absent: no gradient text, no side-stripe cards, no glassmorphism, no hero-metric template. `REDESIGN_SPEC.md` shows someone already found and killed the cool-slate default. Warm charcoal `#161412` with persimmon `#ff5c3a` is a genuine, defensible choice.

The tells that remain are one tier deeper:

1. **The eyebrow is the app's entire labeling grammar.** `font-mono text-xs uppercase tracking-widest` appears **27 times across 17 files** — wordmark, stat labels, section headings, nav labels, progress counters, form labels, "Reader type" ×3. One deliberate kicker is voice. Twenty-seven is grammar, and it's the single most saturated AI scaffold in current generations. It also does real damage: it's the styling on every `<label>` in Settings, where mono + uppercase + widest tracking is the least legible option for a password field.

2. **Second-order category reflex.** "Reading app that isn't Goodreads-beige → warm-dark + orange + Bricolage Grotesque" is guessable from the brief alone. Bricolage is itself the 2024-25 indie-SaaS display face. The product register also argues against display/body pairing here at all: `font-display` is applied to *every* h1–h6 globally, including `text-lg` sub-headings where a display face at 18px buys nothing but a font load.

3. **Deterministic scan agrees with the good news, not the bad.** Zero findings is accurate — the detector's rules cover visual clichés, and you have none. It does not check contrast math, label association, or token discipline, which is where the actual problems are.

## Overall Impression

The bones are better than the surface. State handling, empty states, error copy, optimistic updates with rollback, two-step destructive confirms, queue-based review flows — that's the stuff most apps skip, and you did it. The copy in particular is legitimately good: *"Nothing abandoned yet. When a book isn't working, shelve it here guilt-free. Quitting is data too."* That's a voice.

**The single biggest problem is that you built a design system and then didn't use it.** `Field.tsx` is a well-made accessible label wrapper — `htmlFor`, `aria-describedby`, `aria-invalid`, `role="alert"`. It has **zero usages**. `Input.tsx` has **zero usages**. Meanwhile there are 30+ hand-rolled `<input>`/`<textarea>`/`<select>` across 18 files and **24 `<label>` elements with no `htmlFor`** against exactly 1 that has it (the one inside the unused `Field`). Every form control in this app is unlabeled for assistive tech.

That's not a theme problem. It's the reason the theme feels thin: the tokens are doing all the work alone, with no component layer enforcing them.

## What's Working

- **Loading and empty states.** Skeletons matched to real content shape (`StatsStripSkeleton` mirrors the grid it replaces), not centered spinners. Empty states teach rather than announce — the DNF tab explains the feature's *purpose*, which is exactly the product-register bar.
- **Optimistic mutation with correct rollback.** The favorite toggle and swipe verdicts both mutate locally, then restore precisely on failure (`swipe/page.tsx:70-75`). Most apps at this stage either block on the network or leave the UI lying.
- **The archetype explainer modal.** Four axes, plain-language definitions, and an honest escape hatch — *"Doesn't feel like you? Correct your traits and re-derive. The code follows the evidence."* This is the best-designed thing in the app.

## Priority Issues

### [P1] Every form control in the app is unlabeled for assistive tech
**Why it matters:** Settings has three password fields in a row — "Current password", "New password", "Confirm new password" — declared as sibling `<label>`s with no `htmlFor` and no `id` on the inputs (`settings/page.tsx:304,352,365,378`). A screen reader announces three identical unlabeled edit boxes. Clicking a label doesn't focus its field. Same pattern on `/login` (the front door), Add Book, Import, Feedback. Only **1** `aria-label` exists in the entire codebase as an escape hatch. This is a WCAG 1.3.1 / 4.1.2 failure on every form you ship.
**Fix:** `Field` already solves this correctly. Adopt it — start with `/login` and `/settings`, then the modals. Delete the local `labelClass` constants as you go; they're what made the drift easy.
**Suggested command:** `/impeccable harden`

### [P1] `--faint` fails AA body contrast everywhere, and carries real content
**Why it matters:** Computed against your own tokens: `--faint #6e665c` is **3.25:1** on `--bg`, **3.03:1** on `--surface`, **2.71:1** on `--elevated` — below the 4.5:1 body floor in all three, and below 3:1 for large text on elevated. It has **143 usages**, and they aren't decorative: author names in the Read tab (`library/page.tsx:226`), every "no results" message, DNF review notes, publication years, rejection rationales, "Invite-only. Ask the admin for an account." on the login screen. This is exactly the failure the design guidance calls out — light gray chosen for elegance, at the cost of readability.
**Fix:** Raise `--faint` to roughly `#8a8177` (≈4.5:1 on surface) and reserve it strictly for genuinely tertiary text. Move author names to `--muted` — note `ToReadTab:411` already styles the author `text-muted` while `ReadTab:226` uses `text-faint`, so the app disagrees with itself on the same data.
**Suggested command:** `/impeccable audit`

### [P1] White-on-accent primary buttons fail contrast, and you already have the fix in-repo
**Why it matters:** `Button.tsx:15` is `bg-accent text-white` → **3.07:1**. On hover, `--accent-hover #ff7355` drops it to **2.68:1**, which fails even the large-text threshold. This is the primary CTA on every screen, including "Find my next books". Meanwhile `library/page.tsx:196` renders the active star filter as `bg-accent text-base` — dark ink on accent — which measures **5.99:1** and passes comfortably. The correct answer is already shipping in one place and the wrong one is in the design system.
**Fix:** Switch `Button` primary to dark ink on accent (`text-base`, i.e. `--bg`), matching the star filter. Same for `danger` (white on `#e0524b` is 3.83:1).
**Suggested command:** `/impeccable audit`

### [P1] `tasteAccent` promises legibility it doesn't deliver
**Why it matters:** The file comment says *"curated for legibility on the dark theme."* Measured on `--surface`: **IPDH 4.50, IPDM 4.49, RCDM 3.93** — three of sixteen archetypes fail body contrast. Worse, the hash fallback for any non-archetype seed constrains lightness to 58–66% with no per-hue compensation, so blue/violet seeds land at **2.69–3.09:1** (`hsl(240,70%,58%)` → 2.69). That color drives `text-user` on trait chips, axis letters, and — at `opacity-60` — the archetype link on the dashboard (`page.tsx:178`), which compounds a marginal color with 40% transparency.
**Fix:** Clamp generated accents by measured luminance rather than HSL lightness (bump L until contrast ≥ 4.5:1 on surface), fix the three failing archetypes, and drop the `opacity-60` on the dashboard link — use `--muted` for the resting state instead.
**Suggested command:** `/impeccable colorize`

### [P1] Two flows silently destroy or misrepresent user intent
**Why it matters:** Two distinct problems, same root:
- `Modal.tsx:61` closes on any backdrop click. `BookEditModal` holds unsaved `rating`, `review`, and `dateRead` in local state. One stray click outside the dialog discards a written review with no confirmation and no undo — and the review is *the* highest-value data this app collects (product decision #5 says in-app reviews outweigh metadata inference).
- In the swipe reject modal (`swipe/page.tsx:348-353`), **"Skip" and "Confirm" both call `submitReject`.** They are byte-identical in behavior. "Skip" reads as "cancel this dialog" but actually files the rejection. Escape and backdrop-click *do* cancel — so the two visible buttons behave the opposite way from the two invisible ones.
**Fix:** Guard backdrop-close when the modal is dirty (confirm, or ignore backdrop entirely for editors and keep Escape + explicit Cancel). Relabel the reject modal to "Skip without a reason" / "Submit reason", or drop the second button.
**Suggested command:** `/impeccable clarify`

### [P2] Mobile users can't reach Discover
**Why it matters:** `NavBar` (desktop) lists Home, Swipe, Discover, My library, My profile, Settings. `BottomNav` (mobile) lists Home, Swipe, Library, Profile, Settings — **Discover is absent**. On a phone the only route to it is a small tertiary link on the dashboard (`page.tsx:222`). Labels also diverge across the two ("My library" vs "Library"), so the same destination is named two ways depending on viewport. Desktop nav also runs to 8 items with Admin + Sign out, past the ≤5 top-level guideline.
**Fix:** Reconcile the two nav sources into one list with one label per route. Decide whether Discover is primary; if it is, it belongs in the bottom nav.
**Suggested command:** `/impeccable adapt`

### [P2] `text-base` is both a color and a font size
**Why it matters:** `colors.base` in `tailwind.config.ts` collides with Tailwind's built-in `fontSize.base`. I compiled the real config to check: **both rules are emitted** — `.text-base { font-size: 1rem; line-height: 1.5rem }` and, later, `.text-base { color: var(--bg) }`. It's used as a *color* in 13 places (`bg-accent text-base`, `bg-success text-base`, `bg-user text-base`) and as a *size* in 13 others. **To be precise: nothing renders wrong today** — emission order happens to favor the intended result in every current combination. But the correctness of `SwipeCard.tsx:77`'s `text-lg font-bold text-base` rests entirely on Tailwind emitting `.text-lg` after `.text-base`, and it silently injects a font size into every element that only wanted the color.
**Fix:** Rename the token to `ink`/`canvas`/`bg` so `text-base` unambiguously means font size.
**Suggested command:** `/impeccable extract`

### [P2] The dashboard buries its own signature
**Why it matters:** `REDESIGN_SPEC.md` locks the concept as *"the hero of the app is the user's generated taste identity, surfaced on the dashboard (not buried in /profile)."* Today `TasteHero` renders **only** on `/profile`, in `compact` mode. The dashboard gets a 14px badge link at 60% opacity. What's left is h1 + three visually identical `Card`s at uniform `space-y-6` — stats, ratings, CTA — with no dominant element and no rhythm. The most distinctive thing the product does is the thing you can't see on the page users land on.
**Fix:** Put the full `TasteHero` on the dashboard as the first element and demote the stats strip. Vary the vertical rhythm so the hero owns more space than the utility cards.
**Suggested command:** `/impeccable layout`

## Persona Red Flags

**Sam (Accessibility-Dependent):** Blocked at the front door. `/login` announces two unlabeled edit boxes — no `htmlFor`, no `aria-label`, placeholder only. Settings' three password fields are indistinguishable by ear. `--faint` body text at 3.03:1 is unreadable at low vision, and it's what author names are set in. `Modal` sets `role="dialog"` + `aria-modal` but never marks background content `inert`/`aria-hidden` and never locks body scroll, so the virtual cursor still wanders the page behind the dialog. Borders at **1.38:1** against surface mean input boundaries are effectively invisible (WCAG 1.4.11 wants 3:1 for control boundaries).

**Alex (Power User):** The swipe deck is the app's core repetitive loop and has **no keyboard shortcuts at all** — no arrow keys, no J/K, no Y/N. Ten cards means thirty mouse trips to buttons. No bulk actions in the library: rating 40 imported books means opening and closing 40 modals one at a time. The "N books waiting on a rating" queue is a genuinely good accelerator and proves you know how to build one — it just stops at the modal boundary. The X/R/+ buttons are also unreachable by Tab in a sensible order relative to the card.

**Casey (Distracted Mobile):** The swipe stack is `h-[440px]` on small screens with the action buttons *below* it — plausibly below the fold on a short phone, and above the fixed bottom nav that eats another ~72px. Primary actions on the dashboard sit at the bottom of a scroll, which is fine, but "+ Add book" in the library header is top-right, out of thumb reach. Library filter state (search, sort, star filter) is component-local `useState`, so backgrounding the app and returning resets it — only the tab survives, because that one lives in the URL.

## Minor Observations

- `--hairline` and `--elevated` are both `#2a2420`. Two tokens, one value — the distinction is documentation, not design.
- `.fade-in` is applied to the root of `/`, `/library`, and `/swipe` identically. That's the uniform-entrance reflex, and the product register explicitly rejects page-load choreography: users are entering a task, not watching a reveal. (The reduced-motion handling is correct, though — defining `@keyframes fadeIn` only inside `prefers-reduced-motion: no-preference` is a nice touch.)
- `RatingsBreakdown` animates bar `width` via `transition-all` — animating a layout property. Use `transform: scaleX()`.
- Focus rings use `ring-offset-base` everywhere, including on elements sitting on `--surface` and `--elevated`, so the offset paints a dark halo that reads as a gap in the card.
- `StatsStrip` uses `sm:divide-x sm:divide-border` at **1.38:1** — the dividers are essentially invisible at the size they're drawn.
- Swipe controls render literal `X`, `R`, `+` text while `lucide-react` is already a dependency and used in both navs. "R" for "already read" is unguessable.
- Six `useSWR` calls fire on `/profile` mount and four on `/` — each with its own loading boundary, so the page assembles in visible stages.

## Questions to Consider

- If someone opened this app for the first time and closed it after ten seconds, what would they remember? Right now the answer is "a dark page with three cards" — but you built an archetype engine that names them The Cerebral Architect. Why is that on page two?
- You wrote a `Field` component that does accessibility correctly, then hand-rolled 30 inputs around it. What made reaching for the raw element easier than the component — and what would have to change for the system to be the path of least resistance?
- The eyebrow style appears 27 times. If you could only keep it in three places, which three earn it?
- Bricolage Grotesque only ever renders at 700/800 in headings. If you deleted it and set headings in Inter at 700 with tighter tracking, would anyone notice — and would the page load faster?
