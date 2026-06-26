# Reader Archetype Feature -- Implementation Plan

> **AGENT EXECUTION CONTRACT.** Build in the order in the "Implementation order" section. Each
> reference below was verified against the codebase on 2026-06-26. Where a file/line/constant is
> named, use it exactly -- do NOT invent alternatives or search for differently-named helpers.
> Follow existing patterns; do not introduce new libraries, hex colors, or abstractions.
> After each code step, read the file back to confirm the edit; do not run git state-mutating
> commands. Run tests via `python -m pytest`.

## Overview

A Myers-Briggs-style reader personality system. Claude scores the user's taste traits across 4
axes, producing a 4-letter code (e.g. `IPBH`) that maps to a named archetype ("The Wandering
Escapist"). Derives entirely from existing taste traits -- no new pipeline step, no extra
enrichment.

**Relationship to TasteHero** (`frontend/components/TasteHero.tsx`): ArchetypeCard is
complementary, not competing. TasteHero is trait-level ("what Claude inferred, in your words")
and lives on `/`; ArchetypeCard is archetype-level ("your reader type classification") and lives
on `/profile`. Different questions, different pages.

**Timing:** Build after the frontend redesign is merged (all 6 phases). The archetype section
slots into the redesigned `/profile`. Do not mix this into redesign sessions.

---

## The Axis System

4 binary axes. Claude scores each on a float -1.0 (left pole) to +1.0 (right pole). The assigned
letter is whichever pole is stronger; **ties (score == 0.0) break to the left/first letter.**

| Axis             | Left pole (negative)                                                   | Right pole (positive)                                            | Letter pair |
| ---------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------- |
| **1. Lens**      | **I**mmersive -- reads to be transported; prizes absorption and escape | **R**eflective -- reads to think; prizes craft, ideas, challenge | I / R       |
| **2. Engine**    | **P**lot-first -- momentum, events, twists drive ratings               | **C**haracter-first -- interiority, relationships, development   | P / C       |
| **3. Range**     | **B**road -- genre eclectic; jumps categories                          | **D**eep -- genre loyal; digs niches; often a series reader      | B / D       |
| **4. Resonance** | **H**eart -- emotional resonance and mood drive ratings                | **M**ind -- intellectual/structural craft drives ratings         | H / M       |

Code order is Lens+Engine+Range+Resonance. 2^4 = **16 archetypes**, one per code.

---

## The 16 Archetypes

| Code | Name                       | Tagline                                                     |
| ---- | -------------------------- | ----------------------------------------------------------- |
| IPBH | The Wandering Escapist     | "Give me a new world every week."                           |
| IPBM | The Plot Mechanic          | "A perfect engine of a story."                              |
| IPDH | The Serial Thrill-Seeker   | "One more chapter. Always one more."                        |
| IPDM | The Genre Architect        | "The rules of the genre exist to be mastered."              |
| ICBH | The Empathic Rover         | "Show me how different people feel."                        |
| ICBM | The Character Analyst      | "Tell me who they are, not what happens."                   |
| ICDH | The Devoted Fan            | "I live in this world now."                                 |
| ICDM | The Deep Empath            | "I only finish books that feel true."                       |
| RPBH | The Conscious Adventurer   | "Beautiful prose AND a great story."                        |
| RPBM | The Eclectic Critic        | "I'll read anything once, and have opinions."               |
| RPDH | The Committed Purist       | "I know exactly what I like, and why."                      |
| RPDM | The Structural Connoisseur | "Architecture and execution, above all."                    |
| RCBH | The Literary Wanderer      | "Voice and feeling, across every genre."                    |
| RCBM | The Cerebral Explorer      | "Minds first -- give me complex characters and ideas."      |
| RCDH | The Canon Keeper           | "A few authors, read completely and deeply."                |
| RCDM | The Cerebral Architect     | "A well-constructed mind on the page -- that's everything." |

Name + tagline only -- no long-form description paragraphs. The tagline carries the flavor.

---

## Backend

> **Pattern anchors (verified):**
>
> - Claude tool-use call: copy the shape from `mylibrary/profile.py` `extract_taste_profile`
>   (lazy `from anthropic import Anthropic`; `client.messages.create(model=..., max_tokens=...,
system=..., tools=[_TOOL], tool_choice={"type":"tool","name":"record_archetype_scores"},
messages=[{"role":"user","content":prompt}])`; then loop `message.content` for the block
>   whose `type == "tool_use"` and read `block.input`).
> - Key resolution: `from .user_settings import resolve_anthropic_key`; `resolve_anthropic_key(user_id)`.
> - Model string: EXACTLY `"claude-haiku-4-5-20251001"` (as used in `mylibrary/recommend.py:302`).
> - Timestamps: `from .db import utcnow`; call `utcnow()`. Never `datetime.utcnow`.
> - User scoping: `from .config import LOCAL_USER_ID`; trailing `user_id: str = LOCAL_USER_ID`
>   on every function; filter every query by `user_id`.

### New module: `mylibrary/archetype.py`

**Responsibilities:**

- Axis metadata (names, poles) as constants.
- 16 archetypes as a lookup dict (`code -> {name, tagline}`).
- `derive_archetype(*, user_id: str = LOCAL_USER_ID) -> ArchetypeResult`:
  1. `init_db()`. Resolve key via `resolve_anthropic_key(user_id)`; if falsy, raise `RuntimeError`
     (message style copied from `profile.extract_taste_profile`).
  2. Fetch `TasteTrait` rows for `user_id`. If none, raise `RuntimeError("No taste profile ...")`.
     (The POST endpoint wraps this in `try/except RuntimeError -> HTTPException(400)` -- there is
     **no** global RuntimeError handler in `api.py`; each endpoint converts it locally.)
  3. Haiku tool-use call (model `"claude-haiku-4-5-20251001"`), passing trait claims + polarities.
     Ask for each of 4 axis floats -1.0..+1.0 plus a brief rationale.
  4. Scores -> 4-letter code (sign per axis: **negative => left letter, positive => right letter;
     exactly 0.0 => left letter**). Look up name/tagline from the dict.
  5. Upsert the `ReaderArchetype` row keyed by `user_id` (query `one_or_none()`; update in place
     if present else `session.add(...)` -- same upsert shape as `profile.get_profile_meta`).
     Stamp `derived_at = utcnow()`. Return `ArchetypeResult`.

**Claude tool schema** (`record_archetype_scores`): `input_schema.type = "object"`; number props
`lens|engine|range|resonance` (descriptions: `-1=Immersive,+1=Reflective`,
`-1=Plot-first,+1=Character-first`, `-1=Broad,+1=Deep`, `-1=Heart,+1=Mind`); string props
`lens_rationale|engine_rationale|range_rationale|resonance_rationale`; all 8 in `required`.

**`ArchetypeResult` dataclass:** fields `code, name, tagline: str`,
`axis_lens, axis_engine, axis_range, axis_resonance: float`,
`lens_rationale, engine_rationale, range_rationale, resonance_rationale: str`,
`derived_at: datetime`.

---

### DB: new table `reader_archetypes` (`mylibrary/db.py`)

`class ReaderArchetype(Base)`, `__tablename__ = "reader_archetypes"`. Columns:
`id` PK; `user_id: str` with a **`UniqueConstraint`** (one archetype per user -- upsert, same as
`ProfileMeta`); `code: str`; `archetype_name: str`; `archetype_tagline: str`;
`axis_lens|axis_engine|axis_range|axis_resonance: float`;
`lens_rationale|engine_rationale|range_rationale|resonance_rationale: str | None`;
`derived_at: datetime`.

> Do NOT add a redundant `UniqueConstraint` on the PK `id` -- that bug made every autogenerate
> emit a spurious `create_unique_constraint` (see `taste_traits` history in CLAUDE.md).

**`init_db` (local SQLite):** no change needed -- `Base.metadata.create_all` picks up the new
model automatically.

**Alembic migration -- NUMBER IS `0005`, NOT `0004`.** Current head is
`0004_add_rec_description` (revision id `"0004_add_rec_description"`). Create
`alembic/versions/0005_reader_archetypes.py` with:

- `revision: str = "0005_reader_archetypes"`
- `down_revision: Union[str, None] = "0004_add_rec_description"`
- **Idempotent** body: `from alembic import op`, `from sqlalchemy import inspect`; in `upgrade()`
  do `insp = inspect(op.get_bind())`; `if "reader_archetypes" not in insp.get_table_names(): op.create_table(...)`.
  Mirror the inspect-and-skip pattern in `0002`/`0003`. (Reason: the `0001` baseline runs
  `Base.metadata.create_all()` from live models, so on a fresh DB the table may already exist by
  the time 0005 runs.)
- `downgrade()`: `op.drop_table("reader_archetypes")`.

---

### Purge integration (`mylibrary/purge.py`)

> **Edit `_delete_profile_rows`, NOT `clear_profile`.** Verified: `clear_library` and
> `delete_account` call `_delete_profile_rows(session, user_id)` directly -- they do NOT call
> `clear_profile`. Putting the delete in the shared helper makes all three paths (profile reset,
> library clear, account delete) drop the archetype row. Editing only `clear_profile` would leave
> orphaned archetype rows on library-clear/account-delete.

In `_delete_profile_rows`, add (before the `return`):

```python
session.query(ReaderArchetype).filter(
    ReaderArchetype.user_id == user_id
).delete(synchronize_session=False)
```

and add `ReaderArchetype` to the `from .db import (...)` block at the top of `purge.py`.
No FK exists (archetype references nothing), so ordering relative to the other deletes is free.

---

### Schemas (`mylibrary/schemas.py`)

`ArchetypeAxisOut(BaseModel)`: `score: float`, `letter: str` (winning pole letter),
`rationale: str | None`.

`ArchetypeOut(BaseModel)`: `code, name, tagline: str`,
`lens|engine|range|resonance: ArchetypeAxisOut`, `derived_at: datetime`, `is_stale: bool`.

`is_stale` is computed at read time: `derived_at < ProfileMeta.last_profiled_at` for this user
(mirrors the taste-profile dirty-state). Compute it in the GET handler, not the DB.

---

### API endpoints (`mylibrary/api.py`)

Add both with the `current_user` dependency (`UserId` alias) like every other data route.

`POST /profile/archetype` -- derive/re-derive. Body:

```python
@app.post("/profile/archetype", response_model=ArchetypeOut)
def post_archetype(user_id: UserId):
    try:
        result = archetype.derive_archetype(user_id=user_id)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return _archetype_out(result, user_id)   # build ArchetypeOut incl. is_stale + per-axis letters
```

`GET /profile/archetype` -- read stored row; **404 if none derived yet**; compute `is_stale`
inline by loading this user's `ProfileMeta.last_profiled_at`. Use `session.get`/query scoped by
`user_id` (cross-tenant access must 404, per the existing convention).

Add a small `_archetype_out(...)` helper that maps a stored row / `ArchetypeResult` to
`ArchetypeOut`, deriving each axis `letter` from its score (negative or 0.0 -> left letter,
positive -> right letter) and assembling per-axis `ArchetypeAxisOut`.

---

## Frontend

### Design system (locked by the redesign -- verified primitives)

Use token classes only (no hardcoded hex): bg `bg-base|bg-surface|bg-elevated`; text
`text-text|text-muted|text-faint`; border `border-border`; accent
`bg-accent|text-accent|bg-accent-quiet`; semantic `text-success|text-danger|text-warning`;
per-user `text-user|bg-user` (resolve `--user-accent`). Fonts: `font-display` (headings),
default `font-sans` (body), `font-mono` (codes/data labels). Icons: `lucide-react` (no emoji).

**Verified component APIs (use exactly, do NOT reimplement):**

- `Button` (`components/ui/Button.tsx`): props `variant: 'primary'|'secondary'|'ghost'|'danger'`,
  `size: 'sm'|'md'|'lg'`, `loading?: boolean` (renders inline Spinner, sets `disabled`+`aria-busy`).
- `Badge` (`components/ui/Badge.tsx`): props `variant: 'default'|'mono'|'success'|'danger'|'warning'|'accent'`
  and `className` ONLY. **There is no `size`/`large` prop** -- make the code badge large via
  `className` (e.g. `className="text-base px-3 py-1"`), not a prop.
- `Modal` (`components/ui/Modal.tsx`): props `labelId: string`, `onClose: () => void`,
  `children`, `className`. **Already provides** focus-trap, Tab cycling, Escape-to-close,
  `role="dialog"`, `aria-modal`, `aria-labelledby`, and focus-restore on unmount. There is **no
  `useFocusTrap` hook** -- do not look for one. Wrap content in `Modal` and those a11y
  requirements are satisfied; do not hand-roll them.
- `useToast()` from `components/ui` (`export { ToastProvider, useToast } from './Toast'`).
- `Card`, `Spinner`, `Field` also exported from `components/ui` index.
- Per-archetype accent: `tasteAccent(code)` from `lib/tasteAccent.ts` (verified signature
  `(seed: string | null | undefined) => string`, returns an `hsl(...)` string). Set it as
  `style={{ ['--user-accent' as string]: tasteAccent(code) }}` on the card wrapper -- the exact
  pattern `TasteHero.tsx` uses -- so `text-user`/`bg-user` resolve inside the card.

---

### `lib/api.ts` additions (verified helpers: `get`/`post` exist)

> `post<T>(path, body?)` works with no body (verified -- `body` is optional). `get<T>` throws
> `new Error("GET ${path} -> ${status}")`, so the status code IS in `.message` -- the `404`
> substring check below is valid.

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

Add interfaces `ArchetypeAxisOut { score: number; letter: string; rationale: string | null }`
and `ArchetypeOut { code, name, tagline: string;
lens, engine, range, resonance: ArchetypeAxisOut; derived_at: string; is_stale: boolean }`.

Export `ARCHETYPE_KEY = 'archetype'` (string const) as the shared SWR key.

> **.tsx gotchas (CLAUDE.md):** prefer single-quoted strings; no non-ASCII inside JS string
> literals; no IIFEs in JSX (compute derived values as plain vars before `return`). After editing
> any `.tsx` with string literals, run the smart-quote fix snippet from CLAUDE.md if needed.

---

### `ArchetypeCard` (`components/ArchetypeCard.tsx`)

`'use client'`; section on `/profile` below the taste traits; uses `useSWR(ARCHETYPE_KEY, api.getArchetype)`.

**States:**

1. **Loading** -- skeleton matching the Card shape (`motion-safe:animate-pulse`).
2. **No archetype** (data === null) -- `Card` with eyebrow + invitation line + primary `Button`
   (`size="md"`) "Discover your reader type". onClick: `post` via `api.deriveArchetype()`, use the
   Button `loading` prop while pending, then `mutate(ARCHETYPE_KEY, result, { revalidate: false })`.
   Toast on error.
3. **Fresh** -- full card (below).
4. **Stale** (`is_stale === true`) -- full card + quiet amber hint line and a small "Re-derive"
   `Button` (`variant="secondary" size="sm"`), matching `ReprofileBanner` language. No
   `window.confirm`/`alert` -- re-derive is cheap and reversible.

**Card structure:** wrapper sets `--user-accent` via `tasteAccent(code)`. Eyebrow
(`font-mono text-xs uppercase tracking-widest text-muted`) "Reader Type"; code `Badge variant="mono"`
with `className="text-base px-3 py-1"`; name `font-display text-2xl font-bold text-text`; tagline
`text-sm text-muted italic`; then the axis bars (mt-5); footer `flex justify-between mt-5` with
stale nudge (if any) + Share `Button variant="secondary" size="sm"`.

**Axis bars (bars, not radar -- resolved).** Track: `relative h-2 rounded-full bg-elevated overflow-hidden`.
Compute fill as plain vars (no IIFE):

```tsx
const pct = Math.abs(score) * 50; // 0-50
const left = score < 0 ? `${50 - pct}%` : '50%';
// <div style={{ left, width: `${pct}%` }} className="absolute h-2 rounded-full bg-user" />
```

Left/right pole labels: `text-xs text-faint`, `w-28` (right-aligned left label, left-aligned right
label). Rationale: collapsed by default, toggled via `useState`.

---

### `ArchetypeShareModal` (`components/ArchetypeShareModal.tsx`)

Wrap in the `Modal` primitive (pass `labelId` matching the title element's `id`, and `onClose`).
Modal already handles role/aria/focus-trap/Escape/restore -- do NOT reimplement.

**Contents:**

1. Fixed-size share card `<div>` (~400x300): "MyLibrary" wordmark (`font-display`, small), the
   4-letter code (`font-mono`, very large, `text-user`), name (`font-display` bold), tagline
   (`text-muted`), a thin row of 4 axis labels. Bg `bg-elevated` + accent wash from `--user-accent`.
2. **"Copy as image"** (`Button variant="secondary"`): rasterize via Canvas 2D (no `html2canvas`
   dep -- draw programmatically). `canvas.toBlob()` ->
   `navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])`. Toast success/error.
   Canvas fonts may not match `font-display`/`font-mono`; use web-safe fallbacks (`system-ui`/
   `monospace`) or preload via `FontFace`. Looks great > pixel-perfect.
3. **"Copy text"** (`Button variant="ghost"`): copies `'I am [Name] ([CODE]) on MyLibrary'`
   (ASCII apostrophe, no curly quotes). Toast success.

---

### Profile page (`app/(main)/profile/page.tsx`)

Add `<ArchetypeCard />` as a section after the taste traits (before or after the genre breakdown --
whichever flows). Page already uses SWR; add `useSWR(ARCHETYPE_KEY, api.getArchetype)` alongside
existing hooks.

---

## Staleness logic (verified against purge.py)

| Event                            | Effect                                                            |
| -------------------------------- | ----------------------------------------------------------------- |
| Re-profile (full or incremental) | `ProfileMeta.last_profiled_at` bumps -> `is_stale: true` next GET |
| Re-derive archetype              | `ReaderArchetype.derived_at` bumps -> `is_stale: false`           |
| Clear profile                    | `_delete_profile_rows` deletes the archetype row                  |
| Clear library / delete account   | both call `_delete_profile_rows`, so the row is deleted there too |

---

## Implementation order

1. **`archetype.py` data** -- axis constants + 16-entry lookup dict (names + taglines). Pure data.
2. **DB + migration** -- add `ReaderArchetype` to `db.py`; write idempotent `0005_reader_archetypes`
   (down_revision `"0004_add_rec_description"`); add the delete to `purge._delete_profile_rows`.
3. **`archetype.py` logic** -- `derive_archetype` (Haiku tool-use, exact model string, `utcnow()`, upsert).
4. **Schemas + API** -- `ArchetypeAxisOut`/`ArchetypeOut`; `POST`/`GET /profile/archetype`
   (POST wraps RuntimeError -> 400; GET 404s when none; both compute axis letters + `is_stale`).
5. **`lib/api.ts`** -- `deriveArchetype`, `getArchetype`, types, `ARCHETYPE_KEY`.
6. **`ArchetypeCard`** -- all 4 states; integrate into `/profile`.
7. **`ArchetypeShareModal`** -- via `Modal`; canvas image + text copy; toasts.
8. **QA** -- end-to-end with a real profile; verify `is_stale` transitions across re-profile/re-derive;
   verify clear-library deletes the archetype row; run `python -m pytest`; run axe on the modal.

---

## Resolved decisions

- **Bars, not radar** -- clearer for 4 axes, consistent with dashboard rating bars (`bg-user` on `bg-elevated`).
- **Share color** -- per-archetype via `tasteAccent(code)`; 16 stable distinct HSL colors, no separate palette.
- **Re-derive ungated** -- Haiku is cheap; BYOK user pays anyway.
- **Archetype is not stable across re-profiles** -- intentional; it reflects the current profile state.
- **No long-form descriptions** -- each archetype is name + tagline only.
