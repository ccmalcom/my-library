# Reader Archetype Feature — Implementation Plan

## Overview

A Myers-Briggs-style reader personality system. Claude scores the user's taste traits across 4 axes, producing a 4-letter code (e.g. `IPBH`) that maps to a named archetype ("The Wandering Escapist"). Derives entirely from existing taste traits — no new pipeline step, no extra enrichment.

**Relationship to TasteHero:** The redesign added `components/TasteHero.tsx` (Phase 3), which surfaces the top trait claim as a bold personal statement on the dashboard. ArchetypeCard is complementary, not competing — TasteHero is trait-level ("what Claude inferred about you, in your words") and lives on `/`; ArchetypeCard is archetype-level ("your reader type classification") and lives on `/profile`. They answer different questions and sit on different pages.

**Implementation timing:** Build this after the frontend redesign is complete (all 6 phases). Phase 4 of the redesign restyls `/profile` — the archetype section slots in there once the backend is ready. Do not mix backend feature work into the redesign sessions.

---

## The Axis System

4 binary axes. Claude scores each on a float from -1.0 (left pole) to +1.0 (right pole). The letter assigned is whichever pole is stronger (ties broken by the left/first letter).

| Axis | Left pole (negative) | Right pole (positive) | Letter pair |
|------|---------------------|----------------------|-------------|
| **1. Lens** | **I**mmersive — reads to be transported; prizes absorption and escape over craft | **R**eflective — reads to think; prizes literary craft, ideas, challenging material | I / R |
| **2. Engine** | **P**lot-first — story momentum, events, twists drive ratings | **C**haracter-first — interiority, relationships, and development drive ratings | P / C |
| **3. Range** | **B**road — genre eclectic; jumps across categories; eclecticism is a value | **D**eep — genre loyal; digs into specific niches; often a series reader | B / D |
| **4. Resonance** | **H**eart — emotional resonance and mood are the primary rating driver | **M**ind — intellectual or structural craft is the primary rating driver | H / M |

2^4 = **16 archetypes**, one per code combination.

---

## The 16 Archetypes

| Code | Name | Tagline |
|------|------|---------|
| IPBH | The Wandering Escapist | "Give me a new world every week." |
| IPBM | The Plot Mechanic | "A perfect engine of a story." |
| IPDH | The Serial Thrill-Seeker | "One more chapter. Always one more." |
| IPDM | The Genre Architect | "The rules of the genre exist to be mastered." |
| ICBH | The Empathic Rover | "Show me how different people feel." |
| ICBM | The Character Analyst | "Tell me who they are, not what happens." |
| ICDH | The Devoted Fan | "I live in this world now." |
| ICDM | The Deep Empath | "I only finish books that feel true." |
| RPBH | The Conscious Adventurer | "Beautiful prose AND a great story." |
| RPBM | The Eclectic Critic | "I'll read anything once, and have opinions." |
| RPDH | The Committed Purist | "I know exactly what I like, and why." |
| RPDM | The Structural Connoisseur | "Architecture and execution, above all." |
| RCBH | The Literary Wanderer | "Voice and feeling, across every genre." |
| RCBM | The Cerebral Explorer | "Minds first -- give me complex characters and ideas." |
| RCDH | The Canon Keeper | "A few authors, read completely and deeply." |
| RCDM | The Cerebral Architect | "A well-constructed mind on the page -- that's everything." |

**Descriptions (full paragraphs) still need writing.** Tone: warm and specific, not generic horoscope copy. Write them before the frontend build so the card has real content to display.

---

## Backend

### New module: `mylibrary/archetype.py`

**Responsibilities:**
- Define axis metadata (names, poles, descriptions) as constants.
- Define the 16 archetypes as a lookup dict (`code -> {name, tagline, description}`).
- `derive_archetype(user_id, anthropic_key) -> ArchetypeResult` -- the main entry point:
  1. Fetch `TasteTrait` rows for `user_id` from DB.
  2. If no traits exist, raise `RuntimeError` (-> HTTP 400) mirroring the recommend guard.
  3. Call Claude (Haiku -- low-stakes classification) with tool-use, passing the trait claims and polarities. Ask it to score each of the 4 axes as a float -1.0...+1.0 with a brief rationale.
  4. Convert scores -> 4-letter code -> look up archetype name/tagline.
  5. Upsert a `ReaderArchetype` row and return `ArchetypeResult`.

**Claude tool schema for axis scoring:**
```json
{
  "name": "record_archetype_scores",
  "input_schema": {
    "properties": {
      "lens":      { "type": "number", "description": "-1=Immersive, +1=Reflective" },
      "engine":    { "type": "number", "description": "-1=Plot-first, +1=Character-first" },
      "range":     { "type": "number", "description": "-1=Broad, +1=Deep" },
      "resonance": { "type": "number", "description": "-1=Heart, +1=Mind" },
      "lens_rationale":      { "type": "string" },
      "engine_rationale":    { "type": "string" },
      "range_rationale":     { "type": "string" },
      "resonance_rationale": { "type": "string" }
    },
    "required": ["lens", "engine", "range", "resonance",
                 "lens_rationale", "engine_rationale",
                 "range_rationale", "resonance_rationale"]
  }
}
```

**Cost:** Single Haiku call over the taste traits (compact -- ~10-20 short trait claims). Negligible.

**`ArchetypeResult` dataclass:**
```python
@dataclass
class ArchetypeResult:
    code: str              # e.g. "IPBH"
    name: str              # e.g. "The Wandering Escapist"
    tagline: str
    description: str
    axis_lens: float       # -1..+1
    axis_engine: float
    axis_range: float
    axis_resonance: float
    lens_rationale: str
    engine_rationale: str
    range_rationale: str
    resonance_rationale: str
    derived_at: datetime
```

---

### DB: new table `reader_archetypes` (`mylibrary/db.py`)

```python
class ReaderArchetype(Base):
    __tablename__ = "reader_archetypes"

    id: Mapped[int]           # PK
    user_id: Mapped[str]      # unique -- one archetype per user
    code: Mapped[str]         # "IPBH"
    archetype_name: Mapped[str]
    archetype_tagline: Mapped[str]
    archetype_description: Mapped[str | None]  # full paragraph
    axis_lens: Mapped[float]       # -1..+1
    axis_engine: Mapped[float]
    axis_range: Mapped[float]
    axis_resonance: Mapped[float]
    lens_rationale: Mapped[str | None]
    engine_rationale: Mapped[str | None]
    range_rationale: Mapped[str | None]
    resonance_rationale: Mapped[str | None]
    derived_at: Mapped[datetime]
```

`user_id` has a `UniqueConstraint` -- upsert pattern (same as `ProfileMeta`).

**Alembic migration:** `0004_reader_archetypes` (migrations 0001-0003 are the initial schema, display_name, and enrich_jobs). Must be idempotent -- inspect-and-skip if the table already exists, following the same pattern as 0002/0003.

**`init_db` (local SQLite mode):** `Base.metadata.create_all` handles it automatically since the model is registered on `Base`.

---

### Purge integration (`mylibrary/purge.py`)

`clear_profile` must also delete the `ReaderArchetype` row for the user -- the archetype derives from the profile, so a profile reset invalidates it. This keeps the staleness logic simple: no archetype row = not yet derived.

---

### Schemas (`mylibrary/schemas.py`)

```python
class ArchetypeAxisOut(BaseModel):
    score: float        # -1..+1
    letter: str         # the winning pole letter, e.g. "I"
    rationale: str | None

class ArchetypeOut(BaseModel):
    code: str
    name: str
    tagline: str
    description: str | None
    lens: ArchetypeAxisOut
    engine: ArchetypeAxisOut
    range: ArchetypeAxisOut
    resonance: ArchetypeAxisOut
    derived_at: datetime
    is_stale: bool      # derived_at < last_profiled_at
```

`is_stale` is computed at read time by comparing `derived_at` against `ProfileMeta.last_profiled_at`. This mirrors how the taste profile dirty-state is reported and lets the frontend show a re-derive nudge after re-profiling.

---

### API endpoints (`mylibrary/api.py`)

```
POST /profile/archetype          # derive (or re-derive) -- Claude call
GET  /profile/archetype          # read stored archetype (404 if none)
```

**POST:** same guard as recommend -- raises 400 if no taste profile exists. Returns `ArchetypeOut`.

**GET:** returns `ArchetypeOut` with `is_stale` computed inline. Returns 404 if no archetype has been derived yet.

---

## Frontend

### Design system context (locked by the redesign)

The frontend now has a warm-dark token system and shared UI primitives. All archetype UI must use them -- do not introduce new hardcoded hex values or one-off styles.

**Token classes to use:**
- Backgrounds: `bg-base`, `bg-surface`, `bg-elevated`
- Text: `text-text`, `text-muted`, `text-faint`
- Border: `border-border`
- Accent: `bg-accent`, `text-accent`, `bg-accent-quiet`
- Semantic: `text-success`, `text-danger`, `text-warning`
- Per-user: `text-user`, `bg-user` (resolves to `--user-accent`)

**Fonts:**
- Display/headings: `font-display` (Bricolage Grotesque, bold/extrabold)
- Body: default (`font-sans`, Inter)
- Data labels and codes: `font-mono` (JetBrains Mono)

**Primitives from `components/ui/`:** `Button`, `Card`, `Badge`, `Spinner`, `Field`. Use them directly -- do not reimplement.

**Icons:** Phase 4 of the redesign adds `lucide-react`. Use it for any icon needs (no emoji as UI icons).

**Per-archetype accent color (RESOLVED):** Reuse `tasteAccent(archetype.code)` from `lib/tasteAccent.ts`. The same deterministic hash that colors the TasteHero will produce a stable, distinct accent for each of the 16 codes. Set it as `--user-accent` on the ArchetypeCard wrapper so `text-user`/`bg-user` resolve correctly within the card -- exactly the same pattern TasteHero uses. No separate per-archetype palette needed.

---

### `lib/api.ts` additions

Add to the `api` object:

```typescript
deriveArchetype: () => post<ArchetypeOut>('/profile/archetype'),

getArchetype: async (): Promise<ArchetypeOut | null> => {
  try {
    return await get<ArchetypeOut>('/profile/archetype');
  } catch (e) {
    if (e instanceof Error && e.message.includes('404')) return null;
    throw e;
  }
},
```

Add the types:

```typescript
export interface ArchetypeAxisOut {
  score: number;      // -1..+1
  letter: string;     // "I", "R", "P", "C", "B", "D", "H", "M"
  rationale: string | null;
}

export interface ArchetypeOut {
  code: string;
  name: string;
  tagline: string;
  description: string | null;
  lens: ArchetypeAxisOut;
  engine: ArchetypeAxisOut;
  range: ArchetypeAxisOut;
  resonance: ArchetypeAxisOut;
  derived_at: string;
  is_stale: boolean;
}
```

SWR key: `"archetype"` (string constant, export from `api.ts` as `ARCHETYPE_KEY`).

---

### `ArchetypeCard` component (`components/ArchetypeCard.tsx`)

Rendered as a section on `/profile`, below the taste traits. `'use client'` -- uses SWR.

**States:**
1. **Loading** -- skeleton block matching the Card shape (`motion-safe:animate-pulse`).
2. **No archetype yet** -- a `Card` with an eyebrow label, a short invitation line, and a `Button` (primary, size `md`) labeled "Discover your reader type". On click: POST `/profile/archetype`, show `Spinner` inline in the button (`loading` prop), update SWR cache with the response via `mutate(ARCHETYPE_KEY, result, { revalidate: false })`.
3. **Has archetype, fresh** -- full card (see below).
4. **Has archetype, stale** (`is_stale: true`) -- full card with a stale nudge. Match the visual language of `ReprofileBanner`: a quiet amber hint line and a small "Re-derive" `Button` (secondary, size `sm`). Do NOT use `window.confirm` or `alert` -- the re-derive action is cheap and reversible.

**Card display structure:**
```
[Card with --user-accent set to tasteAccent(code)]
  [eyebrow: font-mono text-xs uppercase tracking-widest text-muted]  "Reader Type"
  [code badge: Badge variant="mono", large]  "IPBH"
  [name: font-display text-2xl font-bold text-text]  "The Wandering Escapist"
  [tagline: text-sm text-muted italic]  "Give me a new world every week."
  [description paragraph: text-sm text-muted, mt-3]  (full paragraph if present)

  [axis bars section, mt-5]
    [4x axis row]
      left-pole label (text-xs text-faint, w-28 text-right)
      track (flex-1 h-2 rounded-full bg-elevated)
        fill (h-2 rounded-full bg-user, positioned from center)
      right-pole label (text-xs text-faint, w-28 text-left)
    [expandable rationale -- collapsed by default, toggle via useState]

  [footer row: justify-between mt-5]
    [stale nudge if is_stale]
    [Share button: Button variant="secondary" size="sm"]
```

**Axis bar implementation (RESOLVED -- use bars, not radar):** Each bar represents a -1..+1 score. Center the track at 50%, fill left from center for negative scores, right from center for positive. Use `--user-accent` (via `bg-user`) for the fill so the bar color matches the card's accent. Example:
```tsx
const pct = Math.abs(score) * 50; // 0-50%
const left = score < 0 ? `${50 - pct}%` : '50%';
<div style={{ left, width: `${pct}%` }} className="absolute h-2 rounded-full bg-user" />
```

The track wrapper needs `position: relative` and `overflow: hidden`.

---

### `ArchetypeShareModal` component (`components/ArchetypeShareModal.tsx`)

**Must follow the modal a11y pattern established in Phase 5 of the redesign:**
- `role="dialog"` + `aria-modal="true"` + `aria-labelledby` pointing to the modal title
- Focus trap on open; autofocus the first interactive element (Copy text button)
- Escape key closes; focus restores to the Share trigger button on close
- Use the shared `Modal` wrapper or `useFocusTrap` hook from Phase 5

**Modal contents:**
1. A styled **share card** rendered as a fixed-size `<div>` (e.g. 400x300px). Contains: "MyLibrary" wordmark (font-display, small), the 4-letter code (font-mono, very large, text-user), archetype name (font-display, bold), tagline (text-muted), a thin row of 4 axis labels. Background: `bg-elevated`, accent wash from `--user-accent`. This is the visual to be exported.
2. **"Copy as image"** button (`Button` secondary) -- uses Canvas 2D API to rasterize the card div. Draw the content programmatically (no `html2canvas` dep -- the card is simple enough). `canvas.toBlob()` -> `navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])`. Show success/error via the Phase 6 toast system (`useToast()`).
3. **"Copy text"** button (`Button` ghost) -- copies `"I'm [Name] ([CODE]) on MyLibrary"` to clipboard. Show success toast.

**Canvas drawing note:** Font-display (Bricolage Grotesque) and font-mono (JetBrains Mono) may not be available in Canvas `ctx.font`. Use web-safe fallbacks (`system-ui` / `monospace`) or pre-load the fonts via `FontFace` API before drawing. The share card should look great, not perfectly pixel-matched to the DOM version.

---

### Profile page integration (`app/(main)/profile/page.tsx`)

Phase 4 of the redesign restyls this page and adds a condensed `TasteHero` as the page header. When the archetype backend is ready, add `<ArchetypeCard />` as a new section after the taste traits and before or after the genre breakdown -- whichever flows better visually. The profile page already uses SWR; add `useSWR(ARCHETYPE_KEY, api.getArchetype)` alongside the existing hooks.

---

## Staleness logic

| Event | Effect |
|-------|--------|
| User re-profiles (full or incremental) | `ProfileMeta.last_profiled_at` bumps -> archetype `is_stale: true` on next GET |
| User re-derives archetype | `ReaderArchetype.derived_at` bumps -> `is_stale: false` |
| User clears profile | `ReaderArchetype` row deleted (via `purge.clear_profile`) |
| User clears library | `ReaderArchetype` row deleted (cascades via `clear_profile`) |

---

## Implementation order

1. **Write the 16 archetype descriptions** -- full paragraphs, before any code. Warm and specific, not horoscope-generic.
2. **Define archetypes** -- write the full lookup table with names, taglines, and descriptions in `archetype.py`. Pure data, no deps.
3. **DB + migration** -- add `ReaderArchetype` to `db.py`; write idempotent Alembic migration `0004_reader_archetypes`; update `purge.clear_profile`.
4. **`archetype.py` logic** -- implement `derive_archetype` with the Claude Haiku tool-use call.
5. **Schemas + API** -- add `ArchetypeOut`; wire up `POST /profile/archetype` and `GET /profile/archetype`.
6. **`lib/api.ts`** -- add `deriveArchetype`, `getArchetype`, `ArchetypeOut`, `ArchetypeAxisOut`, `ARCHETYPE_KEY`.
7. **`ArchetypeCard` component** -- build all states; integrate into `/profile`.
8. **`ArchetypeShareModal`** -- focus trap + canvas card + copy-as-image + copy-as-text.
9. **QA** -- end-to-end test with a real taste profile; verify `is_stale` transitions; confirm Haiku cost is negligible; run axe on the modal.

---

## Resolved decisions

- **Axis bar design:** Bars (not radar chart). Bars are clearer for 4 axes, composable with the existing UI, and consistent with the ratings breakdown bars on the dashboard (same `bg-user` fill on `bg-elevated` track).
- **Share card color:** Per-archetype, via `tasteAccent(code)`. The existing `lib/tasteAccent.ts` utility produces a stable, accessible HSL color from any string -- seeding it with the 4-letter code gives 16 distinct colors without maintaining a separate palette.
- **Re-derive cost gate:** Ungated. Haiku is cheap; in BYOK multi-tenant mode the user is paying for it anyway.
- **Archetype stability:** Intentional. Re-profiling then re-deriving can change the code -- the archetype reflects the current profile state.

## Still open

- **Archetype descriptions:** The 16 full-paragraph descriptions have not been written yet. Do this before starting the frontend build.
