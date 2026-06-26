# Reader Archetype Feature — Implementation Plan

## Overview

A Myers-Briggs-style reader personality system. Claude scores the user's taste traits across 4 axes, producing a 4-letter code (e.g. `IPBH`) that maps to a named archetype ("The Wandering Escapist"). Derives entirely from existing taste traits — no new pipeline step, no extra enrichment.

---

## The Axis System

4 binary axes. Claude scores each on a float from -1.0 (left pole) to +1.0 (right pole). The letter assigned is whichever pole is stronger (ties broken by the left/first letter).

| Axis | Left pole (negative) | Right pole (positive) | Letter pair |
|------|---------------------|----------------------|-------------|
| **1. Lens** | **I**mmersive — reads to be transported; prizes absorption and escape over craft | **R**eflective — reads to think; prizes literary craft, ideas, challenging material | I / R |
| **2. Engine** | **P**lot-first — story momentum, events, twists drive ratings | **C**haracter-first — interiority, relationships, and development drive ratings | P / C |
| **3. Range** | **B**road — genre eclectic; jumps across categories; eclecticism is a value | **D**eep — genre loyal; digs into specific niches; often a series reader | B / D |
| **4. Resonance** | **H**eart — emotional resonance and mood are the primary rating driver | **M**ind — intellectual or structural craft is the primary rating driver | H / M |

2⁴ = **16 archetypes**, one per code combination.

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
| RCBM | The Cerebral Explorer | "Minds first — give me complex characters and ideas." |
| RCDH | The Canon Keeper | "A few authors, read completely and deeply." |
| RCDM | The Cerebral Architect | "A well-constructed mind on the page — that's everything." |

---

## Backend

### New module: `mylibrary/archetype.py`

**Responsibilities:**
- Define axis metadata (names, poles, descriptions) as constants.
- Define the 16 archetypes as a lookup dict (`code → {name, tagline, description}`).
- `derive_archetype(user_id, anthropic_key) -> ArchetypeResult` — the main entry point:
  1. Fetch `TasteTrait` rows for `user_id` from DB.
  2. If no traits exist, raise `RuntimeError` (→ HTTP 400) mirroring the recommend guard.
  3. Call Claude (Haiku — low-stakes classification) with tool-use, passing the trait claims and polarities. Ask it to score each of the 4 axes as a float −1.0…+1.0 with a brief rationale.
  4. Convert scores → 4-letter code → look up archetype name/tagline.
  5. Upsert a `ReaderArchetype` row and return `ArchetypeResult`.

**Claude tool schema for axis scoring:**
```json
{
  "name": "record_archetype_scores",
  "input_schema": {
    "properties": {
      "lens":      { "type": "number", "description": "−1=Immersive, +1=Reflective" },
      "engine":    { "type": "number", "description": "−1=Plot-first, +1=Character-first" },
      "range":     { "type": "number", "description": "−1=Broad, +1=Deep" },
      "resonance": { "type": "number", "description": "−1=Heart, +1=Mind" },
      "lens_rationale":      { "type": "string" },
      "engine_rationale":    { "type": "string" },
      "range_rationale":     { "type": "string" },
      "resonance_rationale": { "type": "string" }
    },
    "required": ["lens", "engine", "range", "resonance", ...]
  }
}
```

**Cost:** Single Haiku call over the taste traits (compact — ~10-20 short trait claims). Negligible.

**`ArchetypeResult` dataclass:**
```python
@dataclass
class ArchetypeResult:
    code: str              # e.g. "IPBH"
    name: str              # e.g. "The Wandering Escapist"
    tagline: str
    description: str
    axis_lens: float       # −1..+1
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
    user_id: Mapped[str]      # unique — one archetype per user
    code: Mapped[str]         # "IPBH"
    archetype_name: Mapped[str]
    archetype_tagline: Mapped[str]
    archetype_description: Mapped[str | None]  # full paragraph
    axis_lens: Mapped[float]       # −1..+1
    axis_engine: Mapped[float]
    axis_range: Mapped[float]
    axis_resonance: Mapped[float]
    lens_rationale: Mapped[str | None]
    engine_rationale: Mapped[str | None]
    range_rationale: Mapped[str | None]
    resonance_rationale: Mapped[str | None]
    derived_at: Mapped[datetime]
```

`user_id` has a `UniqueConstraint` — upsert pattern (same as `ProfileMeta`).

**Alembic migration:** `0003_reader_archetypes.py` (or whatever the next sequence number is). Adds the table. Backwards-compatible — no existing data affected.

**`init_db` (local SQLite mode):** add `CREATE TABLE IF NOT EXISTS reader_archetypes ...` via `Base.metadata.create_all`.

---

### Purge integration (`mylibrary/purge.py`)

`clear_profile` should also delete the `ReaderArchetype` row for the user — the archetype derives from the profile, so a profile reset should invalidate it.

---

### Schemas (`mylibrary/schemas.py`)

```python
class ArchetypeAxisOut(BaseModel):
    score: float        # −1..+1
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

`is_stale` is computed at read time by comparing `derived_at` against `ProfileMeta.last_profiled_at`. This mirrors how the taste profile dirty-state is reported and lets the frontend show a "re-derive" nudge after re-profiling.

---

### API endpoints (`mylibrary/api.py`)

```
POST /profile/archetype          # derive (or re-derive) — Claude call
GET  /profile/archetype          # read stored archetype (404 if none)
```

**POST:** same guard as recommend — raises 400 if no taste profile exists. Returns `ArchetypeOut`.

**GET:** returns `ArchetypeOut` with `is_stale` computed inline. Returns 404 if no archetype has been derived yet.

---

## Frontend

### `lib/api.ts` additions

```typescript
export async function deriveArchetype(): Promise<ArchetypeOut>
export async function getArchetype(): Promise<ArchetypeOut | null>
```

`getArchetype` returns `null` on 404 (no archetype yet) rather than throwing.

### `ArchetypeCard` component (`components/ArchetypeCard.tsx`)

Rendered as a section on `/profile`, below the taste traits.

**States:**
1. **No archetype yet** — "Discover your reader type" button → POST `/profile/archetype` → loading spinner → result.
2. **Has archetype, fresh** — full card display (see below).
3. **Has archetype, stale** (`is_stale: true`) — full card with a subtle "Re-derive" nudge (same visual language as the reprofiling banner).

**Card display:**
- Large code badge (`IPBH`) in a monospace style.
- Archetype name as heading + tagline as subtext.
- 4 axis bars — each a labeled slider-style bar showing the score between the two poles. Something like:
  ```
  Immersive ←————●————→ Reflective
  Plot-first ←——●——————→ Character-first
  ```
- Expandable rationale per axis (collapsed by default).
- "Share" button → opens `ArchetypeShareModal`.

### `ArchetypeShareModal` component (`components/ArchetypeShareModal.tsx`)

A modal with:
1. A styled **share card** (rendered as a `<div>` with a fixed aspect ratio — think Spotify Wrapped aesthetic). Contains: app name, code, archetype name, tagline, 4 axis labels. Styled with Tailwind — dark background, bold typography.
2. **"Copy as image"** button — uses the [Canvas API / `html2canvas`](https://html2canvas.hertzen.com/) to rasterize the card div to a PNG and trigger a download or copy to clipboard. Alternatively, a pre-built SVG card (simpler, no npm dep).
3. **"Copy text"** button — copies `"I'm The Wandering Escapist (IPBH) on MyLibrary — mylibrary.app"` to clipboard.

**Implementation note on the shareable image:** The simplest reliable approach is to build the card as a fixed-size `<canvas>` element drawn programmatically (no external dep, no html2canvas flakiness). The card content is simple enough — a few text elements + colored bars — that Canvas 2D API is sufficient. `canvas.toBlob()` → `navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])` handles the copy.

### Profile page integration (`app/(main)/profile/page.tsx`)

Add `<ArchetypeCard />` as a new section. SWR key: `"archetype"` (GET `/profile/archetype`).

After a `POST /profile/archetype` completes, mutate `"archetype"` with the response data so the card updates without a refetch.

---

## Staleness logic

| Event | Effect |
|-------|--------|
| User re-profiles (full or incremental) | `ProfileMeta.last_profiled_at` bumps → archetype `is_stale: true` on next GET |
| User re-derives archetype | `ReaderArchetype.derived_at` bumps → `is_stale: false` |
| User clears profile | `ReaderArchetype` row deleted |
| User clears library | `ReaderArchetype` row deleted (cascades via `clear_profile`) |

---

## Implementation order

1. **Define archetypes** — write the full 16-archetype table with names, taglines, and descriptions in `archetype.py`. This is pure data, no deps.
2. **DB + migration** — add `ReaderArchetype` to `db.py`; write Alembic migration; update `init_db`; update `purge.clear_profile`.
3. **`archetype.py` logic** — implement `derive_archetype` with the Claude tool-use call.
4. **Schemas + API** — add `ArchetypeOut`; wire up the two endpoints.
5. **`ArchetypeCard` component** — build and integrate into `/profile`.
6. **`ArchetypeShareModal`** — canvas card + copy-as-image + copy-as-text.
7. **QA** — end-to-end test with a real taste profile; verify `is_stale` transitions; check Haiku cost.

---

## Open questions / decisions deferred

- **Archetype descriptions:** The 16 descriptions (full paragraphs) need writing. Tone: warm and specific, not generic horoscope copy.
- **Axis bar design:** Slider-style inline bars vs. a radar/spider chart. The radar is flashier but harder to read for 4 axes. Bars are clearer and composable.
- **Share card aesthetics:** Color per archetype (e.g. earthy tones for Wandering Escapist, cool blues for Cerebral Architect) vs. uniform brand color. Per-archetype color is higher delight.
- **Re-derive cost gate:** Since Haiku is cheap, re-derive can be ungated. But if moving to multi-tenant with BYOK, this is just a Haiku call the user is paying for — no issue.
- **Archetype stability:** If a user re-profiles and then re-derives, could their archetype flip? Yes, intentionally. The archetype reflects the current profile.
