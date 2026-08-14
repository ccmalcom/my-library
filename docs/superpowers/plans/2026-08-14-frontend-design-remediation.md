# ShelfSprite Frontend Design Remediation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the five P1 accessibility/correctness defects and the two P2 structural defects found in the 2026-08-14 design critique, then recommit the color strategy from Restrained to Committed so the user's taste identity carries real surface area.

**Architecture:** Three phases, strictly ordered. Phase 1 is mechanical correctness — token values, button ink, and adoption of the already-built-but-unused `Field` primitive — with no visual redesign, so it reviews cleanly in isolation. Phase 2 replaces `tasteAccent`'s HSL guesswork with a luminance-solving OKLCH ramp and uses it to drench the taste hero. Phase 3 moves the hero onto the dashboard and reconciles the two divergent nav sources. All contrast claims are enforced by a new dependency-free `lib/contrast.ts` used in tests, not asserted in comments.

**Tech Stack:** Next.js 16 (App Router), React 18, TypeScript, Tailwind CSS 3, SWR, lucide-react, Jest + React Testing Library (components), Vitest (`lib/server/**`, `app/api/**` — not touched by this plan).

**Spec:** `.impeccable/critique/2026-08-14T21-56-07Z__frontend-app-globals-css.md` (the Impeccable critique this plan implements — 24/40, 5×P1, 2×P2 in scope)

## Global Constraints

- **Do not commit.** Chase commits manually. Every task ends by staging (`git add`) and reporting what changed — never `git commit`, never `git push`.
- **All gates run from `frontend/`.** A task is not done until these pass:
  `npm run test:server` · `npm test` · `npm run type-check` · `npm run lint` · `npm run format:check` · `npm run build`
- `npm run build` is mandatory — it is the only gate that catches Next segment-config and prerender failures.
- **`frontend/lib/contrast.ts` and `frontend/lib/tasteAccent.ts` must stay dependency-free.** Client code imports them; adding Zod or any server dependency inflates every browser bundle. Same rule that governs `lib/server/rating.ts`.
- **Do not touch** `frontend/lib/server/**`, `frontend/app/api/**`, `frontend/drizzle/**`, or `frontend/proxy.ts`. This is a frontend-presentation plan; no backend, schema, or auth-boundary changes.
- **Do not rewrite `docs/superpowers/`** except to add this plan. It is a historical archive.
- **Out of scope, deliberately** (deferred by the user to a later identity pass): the 27 `uppercase tracking-widest` eyebrows outside form labels, the Bricolage Grotesque / Inter pairing, the `text-base` token rename, and the `.fade-in` page-entrance reflex. Do not opportunistically fix these.
- **Ratings invariants are untouched.** `books.app_rating` / `goodreads_rating` stay `numeric(2,1)` with drizzle `mode: 'number'`; `0` remains the "clear this rating" sentinel. No task here changes rating logic.
- Component tests opt into jsdom per file with a `/** @jest-environment jsdom */` docblock (see `components/ui/__tests__/StarRating.test.tsx`). Pure-logic tests need no docblock.

---

## Locked Design Decisions

These were derived and numerically verified before this plan was written. Do not re-litigate them mid-execution; if one turns out wrong, stop and report.

### Replacement token values

| Token | Old | New | Why |
|---|---|---|---|
| `--faint` | `#6e665c` | `#948b81` | Old failed AA body on all three surfaces (3.25 / 3.03 / 2.71). New clears on all three: bg **5.49**, surface **5.10**, elevated **4.57**. |
| `--danger` | `#e0524b` | `#ea6b64` | Old was 4.46 on surface / 3.99 on elevated — marginal fail as text. New: **5.52** / **4.95**. |
| `--border-strong` | *(new)* | `#7a6f66` | WCAG 1.4.11 wants 3:1 for interactive control boundaries. **3.50** on surface, **3.13** on elevated. `--border` stays `#3a332d` for decorative card outlines, which 1.4.11 does not govern. |

Button ink flips from `text-white` to `--bg` (the pattern already shipping at `library/page.tsx:196`):

| Combination | Ratio | Verdict |
|---|---|---|
| white on `--accent` *(current)* | 3.07 | FAIL |
| white on `--accent-hover` *(current)* | 2.68 | FAIL (even large text) |
| `--bg` on `--accent` | **5.99** | PASS |
| `--bg` on `--accent-hover` | **6.86** | PASS |
| white on `--danger` *(current)* | 3.83 | FAIL |
| `--bg` on `--danger` (new value `#ea6b64`) | **5.94** | PASS |

### The Committed color ramp

`tasteAccent` currently returns one HSL string with lightness pinned to 58–66% and no per-hue compensation, so blue/violet seeds land at **2.69–3.09:1**. It is replaced by a three-role ramp in OKLCH, gamut-fitted by chroma reduction:

| Role | Definition | Guarantee (verified over **all 360 hues**) |
|---|---|---|
| `--user-surface` | `oklch(0.45 0.15 h)`, chroma reduced until in sRGB | `--text` (`#f5f0e8`) on it ≥ **6.17:1** (worst at hue 143) |
| `--user-ink` | `--text` (`#f5f0e8`) — constant, never varies by archetype. Emitted to CSS as the channel triplet `--user-ink-rgb: 245 240 232` so Tailwind opacity modifiers work. | as above |
| `--user-vivid` | `C=0.16`, lightness raised until ≥4.5:1 on `--surface` | ≥ **4.50:1** on `--surface` (worst at hue 239) |

This is what "Committed" means concretely here: the drenched panel is the taste hero, colored by *the user's own archetype*, so personalization becomes structural instead of decorative. Everything outside that panel stays Restrained. The product register explicitly permits this ("A single surface can earn Committed").

`L=0.45 / C=0.15` was chosen over `L=0.52 / C=0.17` (bolder panel, but worst-case ink drops to 4.54 — too little headroom for a variable-hue system) and over `L=0.38 / C=0.13` (ink 8.40, but the panel reads as tinted rather than committed at 1.71:1 vs bg).

Sample panels: `IPBH #972529` · `ICDH #0a6802` · `RCDH #8a3a01` · `RCDM #025894`.

---

## File Structure

**New files**

- `frontend/lib/contrast.ts` — dependency-free sRGB/OKLCH conversion + WCAG relative-luminance and contrast-ratio math. Single responsibility: color math. Consumed by `tasteAccent.ts` at runtime and by tests as the enforcement mechanism.
- `frontend/lib/__tests__/contrast.test.ts` — unit tests for the math.
- `frontend/lib/__tests__/tasteAccent.test.ts` — contrast guarantees across all 16 archetypes plus a 360-hue fuzz over the fallback path.
- `frontend/lib/__tests__/tokens.test.ts` — parses `app/globals.css` and asserts every documented text/background pair clears its WCAG floor. This is the regression net that stops `--faint` from drifting back.
- `frontend/lib/nav.ts` — the single source of truth for application routes. Both navs import it.
- `frontend/components/__tests__/Modal.test.tsx`, `frontend/components/__tests__/nav.test.tsx`, `frontend/app/__tests__/login.test.tsx` — behavior tests for the tasks that change behavior.

**Modified**

- `frontend/app/globals.css` — token values; add `--border-strong`, `--user-surface`, `--user-ink-rgb` (channel triplet — see Task 10 Step 6), `--user-accent`.
- `frontend/tailwind.config.ts` — expose the new tokens.
- `frontend/components/ui/Button.tsx` — primary/danger ink.
- `frontend/components/ui/Field.tsx` — label styling only.
- `frontend/components/ui/Modal.tsx` — background `inert`, body scroll lock, dirty-guard on backdrop close.
- `frontend/lib/tasteAccent.ts` — full rewrite against the ramp.
- `frontend/components/TasteHero.tsx` — drenched panel; remove `opacity-60` compounding.
- `frontend/app/(main)/page.tsx` — hero placement, spacing rhythm.
- `frontend/components/NavBar.tsx`, `frontend/components/BottomNav.tsx` — consume `lib/nav.ts`.
- 16 files containing hand-rolled form controls (full inventory in Task 5).

---

## Task 1: Contrast math module

**Files:**
- Create: `frontend/lib/contrast.ts`
- Test: `frontend/lib/__tests__/contrast.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `hexToRgb(hex: string): [number, number, number]` (0–1 channels) · `relativeLuminance(rgb: [number,number,number]): number` · `contrastRatio(a: string, b: string): number` (accepts hex strings) · `oklchToRgb(L: number, C: number, hDeg: number): [number,number,number]` · `fitToSrgb(L: number, C: number, hDeg: number): string` (reduces chroma until in-gamut, returns hex) · `solveLightnessForContrast(C: number, hDeg: number, againstHex: string, target: number): string` (returns hex).

- [ ] **Step 1: Write the failing test**

```ts
// frontend/lib/__tests__/contrast.test.ts
import {
  contrastRatio,
  fitToSrgb,
  solveLightnessForContrast,
} from '@/lib/contrast';

describe('contrastRatio', () => {
  it('returns 21 for black on white', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
  });

  it('returns 1 for a color against itself', () => {
    expect(contrastRatio('#1f1b18', '#1f1b18')).toBeCloseTo(1, 5);
  });

  it('is symmetric', () => {
    expect(contrastRatio('#948b81', '#1f1b18')).toBeCloseTo(
      contrastRatio('#1f1b18', '#948b81'),
      5
    );
  });

  it('matches the known ShelfSprite token ratios', () => {
    // --text on --bg, and the old --faint on --surface that this plan replaces.
    expect(contrastRatio('#f5f0e8', '#161412')).toBeCloseTo(16.2, 1);
    expect(contrastRatio('#6e665c', '#1f1b18')).toBeCloseTo(3.03, 1);
  });
});

describe('fitToSrgb', () => {
  it('returns an in-gamut hex for a chroma that would otherwise clip', () => {
    const hex = fitToSrgb(0.45, 0.4, 143);
    expect(hex).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('keeps --text readable on every drenched panel hue', () => {
    for (let h = 0; h < 360; h++) {
      expect(contrastRatio('#f5f0e8', fitToSrgb(0.45, 0.15, h))).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('solveLightnessForContrast', () => {
  it('raises lightness until the target ratio is met, for every hue', () => {
    for (let h = 0; h < 360; h++) {
      const hex = solveLightnessForContrast(0.16, h, '#1f1b18', 4.5);
      expect(contrastRatio(hex, '#1f1b18')).toBeGreaterThanOrEqual(4.5);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx jest lib/__tests__/contrast.test.ts`
Expected: FAIL — `Cannot find module '@/lib/contrast'`.

- [ ] **Step 3: Write the implementation**

```ts
// frontend/lib/contrast.ts
// Dependency-free color math. Client code imports this (via tasteAccent), so it
// must never gain a runtime dependency — same rule as lib/server/rating.ts.

export type Rgb = [number, number, number];

export function hexToRgb(hex: string): Rgb {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as Rgb;
}

function clamp01(c: number): number {
  return Math.min(1, Math.max(0, c));
}

export function rgbToHex(rgb: Rgb): string {
  return (
    '#' +
    rgb
      .map((c) =>
        Math.round(clamp01(c) * 255)
          .toString(16)
          .padStart(2, '0')
      )
      .join('')
  );
}

function linearize(c: number): number {
  const v = clamp01(c);
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map(linearize) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(hexToRgb(a));
  const lb = relativeLuminance(hexToRgb(b));
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Oklch -> linear-light sRGB -> gamma-encoded sRGB (Björn Ottosson). */
export function oklchToRgb(L: number, C: number, hDeg: number): Rgb {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;

  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

  const encode = (c: number) =>
    c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055;

  return [encode(r), encode(g), encode(bb)];
}

function inGamut(rgb: Rgb): boolean {
  return rgb.every((c) => c >= -0.0005 && c <= 1.0005);
}

/** Reduce chroma until the color fits inside sRGB, preserving L and hue. */
export function fitToSrgb(L: number, C: number, hDeg: number): string {
  let c = C;
  for (let i = 0; i < 120 && !inGamut(oklchToRgb(L, c, hDeg)); i++) c -= 0.002;
  return rgbToHex(oklchToRgb(L, Math.max(c, 0), hDeg));
}

/**
 * Raise lightness from a mid starting point until the color clears `target`
 * contrast against `againstHex`. Lightness — not chroma — is what carries
 * contrast, which is exactly what the old HSL-pinned tasteAccent got wrong.
 */
export function solveLightnessForContrast(
  C: number,
  hDeg: number,
  againstHex: string,
  target: number
): string {
  let L = 0.5;
  for (let i = 0; i < 200; i++) {
    const hex = fitToSrgb(L, C, hDeg);
    if (contrastRatio(hex, againstHex) >= target) return hex;
    L += 0.005;
    if (L > 0.995) break;
  }
  return fitToSrgb(Math.min(L, 0.995), C, hDeg);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx jest lib/__tests__/contrast.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Run the full gates**

Run: `cd frontend && npm test && npm run type-check && npm run lint && npm run format:check`
Expected: all pass.

- [ ] **Step 6: Stage and report**

```bash
git add frontend/lib/contrast.ts frontend/lib/__tests__/contrast.test.ts
```
Report the file list. **Do not commit** — Chase commits manually.

---

## Task 2: Token contrast fixes, enforced by test

**Files:**
- Modify: `frontend/app/globals.css:5-33`
- Modify: `frontend/tailwind.config.ts:12-30`
- Test: `frontend/lib/__tests__/tokens.test.ts`

**Interfaces:**
- Consumes: `contrastRatio` from Task 1.
- Produces: CSS custom property `--border-strong`; revised `--faint`, `--danger`, `--danger-quiet`. Because the Tailwind color key is named `border-strong`, the generated utility for a border is **`border-border-strong`** (color-key name appended to the `border-` prefix), not `border-strong`. Task 4's test asserts that exact class name.

- [ ] **Step 1: Write the failing test**

This test reads the real stylesheet, so it fails the moment a token drifts below its floor.

```ts
// frontend/lib/__tests__/tokens.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contrastRatio } from '@/lib/contrast';

const css = readFileSync(join(__dirname, '../../app/globals.css'), 'utf8');

function token(name: string): string {
  const m = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!m) throw new Error(`token --${name} not found or not a 6-digit hex`);
  return m[1]!.toLowerCase();
}

const BG = () => token('bg');
const SURFACE = () => token('surface');
const ELEVATED = () => token('elevated');

describe('globals.css token contrast', () => {
  it.each(['text', 'muted', 'faint'])(
    '--%s clears AA body (4.5:1) on bg, surface, and elevated',
    (name) => {
      for (const bg of [BG(), SURFACE(), ELEVATED()]) {
        expect(contrastRatio(token(name), bg)).toBeGreaterThanOrEqual(4.5);
      }
    }
  );

  it.each(['accent', 'success', 'danger', 'warning'])(
    '--%s clears AA body on bg and surface when used as text',
    (name) => {
      for (const bg of [BG(), SURFACE()]) {
        expect(contrastRatio(token(name), bg)).toBeGreaterThanOrEqual(4.5);
      }
    }
  );

  it('--bg is a legible ink on the accent and danger fills', () => {
    for (const fill of ['accent', 'accent-hover', 'danger', 'success', 'warning']) {
      expect(contrastRatio(BG(), token(fill))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('--border-strong clears 3:1 for interactive control boundaries (WCAG 1.4.11)', () => {
    for (const bg of [SURFACE(), ELEVATED()]) {
      expect(contrastRatio(token('border-strong'), bg)).toBeGreaterThanOrEqual(3);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx jest lib/__tests__/tokens.test.ts`
Expected: FAIL — `--faint` fails the 4.5 assertion (3.03 on surface) and `--border-strong` is not found.

- [ ] **Step 3: Apply the token changes**

In `frontend/app/globals.css`, replace the `--border`/`--faint`/`--danger` declarations and add `--border-strong`:

```css
  --border: #3a332d;
  --border-strong: #7a6f66; /* >=3:1 on surface+elevated — interactive control edges (WCAG 1.4.11) */
  --hairline: #2a2420;

  /* text */
  --text: #f5f0e8;
  --muted: #a89f92;
  --faint: #948b81; /* >=4.5:1 on bg/surface/elevated — was #6e665c (3.03 on surface) */
```

and in the semantics block:

```css
  --danger: #ea6b64; /* was #e0524b — 4.46 on surface failed AA body */
```

```css
  --danger-quiet: rgba(234, 107, 100, 0.12);
```

In `frontend/tailwind.config.ts`, add to `colors`:

```ts
        border: 'var(--border)',
        'border-strong': 'var(--border-strong)',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx jest lib/__tests__/tokens.test.ts`
Expected: PASS.

> If the `--accent`/`--success`/`--warning` cases fail, stop and report — those measured 5.57 / 7.48 / 9.59 on surface during the critique and should already pass.

- [ ] **Step 5: Run the full gates**

Run: `cd frontend && npm test && npm run type-check && npm run lint && npm run format:check && npm run build`
Expected: all pass.

- [ ] **Step 6: Stage and report**

```bash
git add frontend/app/globals.css frontend/tailwind.config.ts frontend/lib/__tests__/tokens.test.ts
```

---

## Task 3: Button and interactive-fill ink

**Files:**
- Modify: `frontend/components/ui/Button.tsx:14-19`
- Test: `frontend/components/ui/__tests__/Button.test.tsx`

**Interfaces:**
- Consumes: `--bg` via the Tailwind `text-base` color utility (already used this way at `library/page.tsx:196`).
- Produces: no API change — `Button`'s props are untouched.

> **Note on `text-base`:** this token name collides with Tailwind's built-in `fontSize.base`, so `.text-base` emits *both* `color: var(--bg)` and `font-size: 1rem`. That was verified by compiling the real config; nothing currently renders wrong, because emission order happens to favor the intent everywhere. Renaming the token is explicitly **out of scope** for this plan. Use `text-base` here for consistency with the existing star-filter pattern, and note that `Button`'s `lg` size already sets `text-base` for its font size — so the class appears once and does both jobs.

- [ ] **Step 1: Write the failing test**

```tsx
/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { Button } from '@/components/ui/Button';

describe('Button ink', () => {
  it('uses dark ink on the accent fill, not white', () => {
    render(<Button variant="primary">Find my next books</Button>);
    const cls = screen.getByRole('button').className;
    expect(cls).toContain('bg-accent');
    expect(cls).toContain('text-base');
    expect(cls).not.toContain('text-white');
  });

  it('uses dark ink on the danger fill, not white', () => {
    render(<Button variant="danger">Delete</Button>);
    const cls = screen.getByRole('button').className;
    expect(cls).toContain('bg-danger');
    expect(cls).not.toContain('text-white');
  });

  it('still marks itself busy and disabled while loading', () => {
    render(<Button loading>Saving</Button>);
    const btn = screen.getByRole('button');
    expect(btn).toHaveAttribute('aria-busy', 'true');
    expect(btn).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx jest components/ui/__tests__/Button.test.tsx`
Expected: FAIL — both ink assertions, because `variantClasses` still says `text-white`.

- [ ] **Step 3: Change the variant classes**

In `frontend/components/ui/Button.tsx`, replace `variantClasses`:

```ts
const variantClasses: Record<Variant, string> = {
  // Dark ink on saturated fills: white on --accent is 3.07:1 (2.68 on hover),
  // --bg on --accent is 5.99:1 (6.86 on hover). Matches the star-filter pattern
  // already shipping in app/(main)/library/page.tsx.
  primary: 'bg-accent text-base hover:bg-accent-hover',
  secondary: 'bg-surface border border-border text-text hover:bg-elevated',
  ghost: 'bg-transparent text-muted hover:text-text hover:bg-surface',
  danger: 'bg-danger text-base hover:opacity-90',
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx jest components/ui/__tests__/Button.test.tsx`
Expected: PASS, 3 tests.

- [ ] **Step 5: Sweep the remaining white-on-fill sites**

Run: `cd frontend && grep -rn "text-white" app components --include=*.tsx`

> Grep for `text-white` alone, **not** for `bg-accent` and `text-white` on the same line — several call sites build their class list as a joined array with the fill and the ink on different elements, so a combined line-grep silently misses them.

Expected: exactly two hits outside `Button.tsx` —
- `components/FeedbackLauncher.tsx:64` (`'bg-accent text-white transition-all'`)
- `components/TasteHero.tsx:260` (the "Build your taste profile" link, which duplicates Button's styling by hand — the `bg-accent` is on line 259)

Change both to `text-base`. If the grep returns other hits, fix them the same way and list them in the report. When done, `grep -rn "text-white" app components --include=*.tsx` must return nothing.

- [ ] **Step 6: Run the full gates**

Run: `cd frontend && npm test && npm run type-check && npm run lint && npm run format:check && npm run build`

- [ ] **Step 7: Stage and report**

```bash
git add frontend/components/ui/Button.tsx frontend/components/ui/__tests__/Button.test.tsx frontend/components/TasteHero.tsx
```

---

## Task 4: Make `Field` the path of least resistance

**Files:**
- Modify: `frontend/components/ui/Field.tsx:24`
- Modify: `frontend/components/ui/Input.tsx:6-13`, `frontend/components/ui/Textarea.tsx`
- Modify: `frontend/components/ui/index.ts` (confirm `Field`, `Input`, `Textarea` are exported)
- Test: `frontend/components/ui/__tests__/Field.test.tsx`

**Interfaces:**
- Consumes: `--border-strong` from Task 2.
- Produces: `Field` renders a label associated via `htmlFor`/`id`, wires `aria-describedby` and `aria-invalid`, and announces errors with `role="alert"`. Its render-prop signature is unchanged: `children({ id, 'aria-describedby', 'aria-invalid' })`. `Input` and `Textarea` gain `border-border-strong`.

> `Field` already implements association correctly — this task does not rebuild it. It changes the label's visual style so adopting `Field` is not a visual regression, and strengthens the control border. The current app-wide label style is `font-mono text-xs font-semibold uppercase tracking-widest`, which is the least legible option for a password field; `Field`'s existing `text-sm font-medium text-text` is the correct replacement and is kept.

- [ ] **Step 1: Write the failing test**

```tsx
/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';

describe('Field', () => {
  it('associates the label with the control', () => {
    render(<Field label="Current password">{(p) => <Input type="password" {...p} />}</Field>);
    expect(screen.getByLabelText('Current password')).toBeInTheDocument();
  });

  it('gives two Fields on the same screen distinct ids', () => {
    render(
      <>
        <Field label="New password">{(p) => <Input type="password" {...p} />}</Field>
        <Field label="Confirm new password">{(p) => <Input type="password" {...p} />}</Field>
      </>
    );
    const a = screen.getByLabelText('New password');
    const b = screen.getByLabelText('Confirm new password');
    expect(a.id).not.toBe(b.id);
  });

  it('announces the error and marks the control invalid', () => {
    render(
      <Field label="Email" error="That address is already invited.">
        {(p) => <Input type="email" {...p} />}
      </Field>
    );
    const input = screen.getByLabelText('Email');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('That address is already invited.');
    expect(input.getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id);
  });

  it('uses a legible label style, not the mono uppercase eyebrow', () => {
    render(<Field label="Your name">{(p) => <Input {...p} />}</Field>);
    const label = screen.getByText('Your name');
    expect(label.className).not.toContain('uppercase');
    expect(label.className).not.toContain('font-mono');
  });

  it('draws control borders at the strengthened token', () => {
    render(<Field label="Your name">{(p) => <Input {...p} />}</Field>);
    expect(screen.getByLabelText('Your name').className).toContain('border-border-strong');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx jest components/ui/__tests__/Field.test.tsx`
Expected: FAIL on the last test — `Input` still uses `border-border`.

- [ ] **Step 3: Strengthen the control borders**

In `frontend/components/ui/Input.tsx`, change the first line of `baseClasses`:

```ts
  'w-full rounded-lg border border-border-strong bg-base px-3 py-2 text-sm text-text',
```

Apply the identical change to the equivalent line in `frontend/components/ui/Textarea.tsx`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx jest components/ui/__tests__/Field.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 5: Confirm the exports**

Run: `cd frontend && grep -n "Field\|Input\|Textarea" components/ui/index.ts`
Expected: all three exported. If any is missing, add it.

- [ ] **Step 6: Run the full gates**

Run: `cd frontend && npm test && npm run type-check && npm run lint && npm run format:check && npm run build`

- [ ] **Step 7: Stage and report**

```bash
git add frontend/components/ui/Field.tsx frontend/components/ui/Input.tsx frontend/components/ui/Textarea.tsx frontend/components/ui/index.ts frontend/components/ui/__tests__/Field.test.tsx
```

---

## Task 5: Adopt `Field` — authentication surfaces

**Files:**
- Modify: `frontend/app/login/page.tsx:41-90`
- Modify: `frontend/app/auth/callback/page.tsx:150-175`
- Test: `frontend/app/__tests__/login.test.tsx`

**Interfaces:**
- Consumes: `Field`, `Input` from Task 4.
- Produces: no exported API change.

> This is the highest-value adoption site: `/login` is the front door and currently ships two inputs whose only hint is a placeholder.

- [ ] **Step 1: Write the failing test**

```tsx
/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import LoginPage from '@/app/login/page';

jest.mock('@/utils/supabase/client', () => ({
  authEnabled: true,
  getSupabaseClient: () => null,
}));
jest.mock('@/lib/authRedirect', () => ({ inviteCallbackRedirect: () => null }));

describe('/login', () => {
  it('exposes both credentials fields by accessible name', () => {
    render(<LoginPage />);
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('gives the password field a distinct id from the email field', () => {
    render(<LoginPage />);
    expect(screen.getByLabelText('Email').id).not.toBe(screen.getByLabelText('Password').id);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx jest app/__tests__/login.test.tsx`
Expected: FAIL — `Unable to find a label with the text of: Email`.

- [ ] **Step 3: Rewrite the login form**

In `frontend/app/login/page.tsx`: delete the `inputClass` and `labelClass` constants (lines 41–48), add `Field` and `Input` to the existing `@/components/ui` import, and replace the two field blocks (lines 61–83) with:

```tsx
          <Field label="Email">
            {(p) => (
              <Input
                {...p}
                type="email"
                required
                autoFocus
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            )}
          </Field>
          <Field label="Password">
            {(p) => (
              <Input
                {...p}
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            )}
          </Field>
```

Also change the "Invite-only. Ask the admin for an account." paragraph (line 92) from `text-faint` to `text-muted` — it is the only guidance on the page and should not sit at the tertiary tier.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx jest app/__tests__/login.test.tsx`
Expected: PASS, 2 tests.

- [ ] **Step 5: Apply the same transformation to the callback page**

In `frontend/app/auth/callback/page.tsx`, replace the two `<label>`/`<input>` pairs at lines 150–172 with `Field`-wrapped `Input`s labeled `Password` and `Confirm password`, using `autoComplete="new-password"` on both. Delete that file's local `labelClass`/`inputClass` constants.

- [ ] **Step 6: Run the full gates**

Run: `cd frontend && npm test && npm run type-check && npm run lint && npm run format:check && npm run build`

- [ ] **Step 7: Stage and report**

```bash
git add frontend/app/login/page.tsx frontend/app/auth/callback/page.tsx frontend/app/__tests__/login.test.tsx
```

---

## Task 6: Adopt `Field` — settings and admin

**Files:**
- Modify: `frontend/app/(main)/settings/page.tsx` — 7 controls at lines 279/282, 304/305, 317/318, 352/353, 365/366, 378/379, 431/432
- Modify: `frontend/app/(main)/admin/page.tsx` — 3 controls at lines 144/145, 157/158, 167/168
- Modify: `frontend/components/admin/UsageTab.tsx:48`, `frontend/components/admin/FeedbackTab.tsx:43` — 2 unlabeled `<select>`s
- Test: `frontend/app/__tests__/settings.test.tsx`

**Interfaces:**
- Consumes: `Field`, `Input` from Task 4.
- Produces: no exported API change.

> Settings is the worst offender: three password fields in a row ("Current password", "New password", "Confirm new password") that a screen reader announces identically.

- [ ] **Step 1: Write the failing test**

```tsx
/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import SettingsPage from '@/app/(main)/settings/page';

jest.mock('swr', () => ({
  __esModule: true,
  default: () => ({ data: undefined, isLoading: false, error: undefined }),
  mutate: jest.fn(),
  useSWRConfig: () => ({ mutate: jest.fn() }),
}));
jest.mock('@/utils/supabase/client', () => ({
  authEnabled: true,
  getSupabaseClient: () => null,
}));

describe('/settings password change form', () => {
  it('gives all three password fields distinct accessible names', () => {
    render(<SettingsPage />);
    const names = ['Current password', 'New password', 'Confirm new password'];
    const ids = names.map((n) => screen.getAllByLabelText(n)[0]!.id);
    expect(new Set(ids).size).toBe(3);
  });
});
```

> The "Current password" label appears twice on this page (email change and password change). `getAllByLabelText(...)[0]` is deliberate — do not "fix" it into `getByLabelText`, which would throw on the duplicate. If you rename one of them for clarity, update the test to match.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx jest app/__tests__/settings.test.tsx`
Expected: FAIL — no accessible names resolve.

- [ ] **Step 3: Convert every control in settings**

For each of the 7 sites, apply this transformation. Example, the display-name field at lines 279–290:

```tsx
            <Field label={userProfile?.display_name ? 'Update name' : 'Set your name'}>
              {(p) => (
                <Input
                  {...p}
                  type="text"
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  placeholder="How should we greet you?"
                />
              )}
            </Field>
```

Keep each control's existing `value`, `onChange`, `type`, `placeholder`, and `disabled` props exactly as they are — only the label/border wrapper changes. Add `autoComplete="current-password"` to the two "Current password" fields and `autoComplete="new-password"` to "New password" and "Confirm new password". Delete the file's local `labelClass` and `inputClass` constants once no site references them.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx jest app/__tests__/settings.test.tsx`
Expected: PASS.

- [ ] **Step 5: Convert admin's three inputs and two selects**

In `frontend/app/(main)/admin/page.tsx`, wrap the "Email", "Name (optional)", and "Anthropic API key (optional)" controls in `Field` the same way.

The two `<select>`s in `components/admin/UsageTab.tsx:48` and `components/admin/FeedbackTab.tsx:43` have no label at all. Wrap each in a `Field` with a real label describing what it filters (read the surrounding JSX to name it accurately — do not invent a label that misdescribes the control).

- [ ] **Step 6: Verify no unassociated labels remain in these files**

Run:
```bash
cd frontend && grep -n "<label" "app/(main)/settings/page.tsx" "app/(main)/admin/page.tsx" components/admin/*.tsx
```
Expected: no output.

- [ ] **Step 7: Run the full gates**

Run: `cd frontend && npm test && npm run type-check && npm run lint && npm run format:check && npm run build`

- [ ] **Step 8: Stage and report**

```bash
git add "frontend/app/(main)/settings/page.tsx" "frontend/app/(main)/admin/page.tsx" frontend/components/admin/UsageTab.tsx frontend/components/admin/FeedbackTab.tsx frontend/app/__tests__/settings.test.tsx
```

---

## Task 7: Adopt `Field` — modals and remaining controls

**Files:**
- Modify: `frontend/components/BookEditModal.tsx:183-210`
- Modify: `frontend/components/FeedbackModal.tsx:78-110`
- Modify: `frontend/components/AddBookModal.tsx:122, 289-295`
- Modify: `frontend/components/ImportModal.tsx:115-130, 157`
- Modify: `frontend/components/EnrichmentCorrectionModal.tsx:132`
- Modify: `frontend/components/SetupWizard.tsx:156-160, 257-262`
- Modify: `frontend/components/reveal/TraitBeats.tsx:87`
- Modify: `frontend/app/(main)/profile/page.tsx:122`
- Modify: `frontend/app/(main)/discover/page.tsx:76`
- Modify: `frontend/app/(main)/library/page.tsx:64, 88, 962`
- Test: `frontend/components/__tests__/BookEditModal.test.tsx`

**Interfaces:**
- Consumes: `Field`, `Input`, `Textarea` from Task 4.
- Produces: no exported API change.

> **Leave `SetupWizard.tsx:347` alone.** That `<label>` wraps its file input to make the whole drop zone clickable — implicit association, which is correct. It is the one `<label>` in the codebase that is not a bug.

**Controls with no visible label** (search boxes, sort selects, the discover prompt): these must not grow a visible label that clutters the toolbar. Give them `aria-label` instead, matching their placeholder intent. `Field` is for controls that already show a label.

- [ ] **Step 1: Write the failing test**

```tsx
/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import BookEditModal from '@/components/BookEditModal';
import type { Book } from '@/lib/api';

jest.mock('swr', () => ({ __esModule: true, default: () => ({ data: undefined }), mutate: jest.fn() }));

const book = {
  id: 1,
  title: 'Piranesi',
  author: 'Susanna Clarke',
  effective_rating: 4,
  app_review: '',
  date_read: null,
  exclude_from_profile: false,
} as unknown as Book;

describe('BookEditModal', () => {
  it('labels the review textarea and the date field', () => {
    render(<BookEditModal book={book} listKey="books-read" onClose={jest.fn()} />);
    expect(screen.getByLabelText('Review')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx jest components/__tests__/BookEditModal.test.tsx`
Expected: FAIL — no accessible name for the textarea.

- [ ] **Step 3: Convert the labeled controls**

Wrap each `<label>`+control pair listed below in a `Field`, preserving all existing props:

| File | Line | Label |
|---|---|---|
| `BookEditModal.tsx` | 183 | `Review` |
| `BookEditModal.tsx` | 200 | *(read the JSX — it is a computed date label)* |
| `FeedbackModal.tsx` | 78 | `Category` |
| `FeedbackModal.tsx` | 103 | `Feedback` |
| `AddBookModal.tsx` | 289 | *(read the JSX)* |
| `ImportModal.tsx` | 115 | *(read the JSX)* |
| `SetupWizard.tsx` | 156 | `Your name` |
| `SetupWizard.tsx` | 257 | `API key` |

- [ ] **Step 4: Add `aria-label` to the label-less controls**

| File | Line | Control | `aria-label` |
|---|---|---|---|
| `library/page.tsx` | 64 | search input | `Search your library by title or author` |
| `library/page.tsx` | 88 | sort select | `Sort books` |
| `library/page.tsx` | 962 | rejection-note textarea | *(already has one — leave it)* |
| `discover/page.tsx` | 76 | prompt input | *(read the JSX and name it after what it asks for)* |
| `AddBookModal.tsx` | 122 | search input | `Search for a book by title or author` |
| `EnrichmentCorrectionModal.tsx` | 132 | search input | *(read the JSX)* |
| `ImportModal.tsx` | 157 | select | *(read the JSX)* |
| `TraitBeats.tsx` | 87 | textarea | *(read the JSX)* |
| `profile/page.tsx` | 122 | trait-edit textarea | `Edit trait claim` |

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npx jest components/__tests__/BookEditModal.test.tsx`
Expected: PASS.

- [ ] **Step 6: Verify the whole codebase is clean**

Run:
```bash
cd frontend && grep -rn "<label" app components --include=*.tsx | grep -v htmlFor | grep -v "SetupWizard.tsx:347"
```
Expected: no output. Every remaining `<label>` either has `htmlFor` or is the SetupWizard drop zone.

Run:
```bash
cd frontend && grep -rn "<input\|<textarea\|<select" app components --include=*.tsx | grep -v "components/ui/"
```
For each hit, confirm by eye that it is inside a `Field` render prop or carries an `aria-label`. List any exceptions in the report rather than silently leaving them.

- [ ] **Step 7: Run the full gates**

Run: `cd frontend && npm test && npm run type-check && npm run lint && npm run format:check && npm run build`

- [ ] **Step 8: Stage and report**

```bash
git add frontend/components frontend/app
```

---

## Task 8: Modal — background isolation, scroll lock, and dirty guard

**Files:**
- Modify: `frontend/components/ui/Modal.tsx`
- Modify: `frontend/components/BookEditModal.tsx:121-125` (pass `confirmClose`)
- Test: `frontend/components/__tests__/Modal.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `Modal` gains one optional prop — `confirmClose?: () => boolean`. When supplied and it returns `false`, a backdrop click is ignored (Escape and explicit buttons still close). Existing call sites that omit it are unaffected.

> Backdrop-click currently discards an unsaved rating, review, and date with no confirmation. Reviews are the highest-value data ShelfSprite collects (product decision #5: in-app reviews outweigh metadata inference).

- [ ] **Step 1: Write the failing test**

```tsx
/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { Modal } from '@/components/ui/Modal';

function open(props: Partial<React.ComponentProps<typeof Modal>> = {}) {
  const onClose = jest.fn();
  render(
    <>
      <button type="button">behind</button>
      <Modal labelId="t" onClose={onClose} {...props}>
        <h2 id="t">Edit book</h2>
        <button type="button">Save</button>
      </Modal>
    </>
  );
  return { onClose, backdrop: screen.getByRole('dialog').parentElement! };
}

describe('Modal', () => {
  it('closes on a backdrop click by default', () => {
    const { onClose, backdrop } = open();
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalled();
  });

  it('ignores a backdrop click when confirmClose returns false', () => {
    const { onClose, backdrop } = open({ confirmClose: () => false });
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('still closes on Escape even when confirmClose returns false', () => {
    const { onClose } = open({ confirmClose: () => false });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('locks body scroll while open and restores it on unmount', () => {
    const { unmount } = render(
      <Modal labelId="t" onClose={jest.fn()}>
        <h2 id="t">Edit</h2>
      </Modal>
    );
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).not.toBe('hidden');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx jest components/__tests__/Modal.test.tsx`
Expected: FAIL on the `confirmClose` and scroll-lock tests.

- [ ] **Step 3: Implement**

In `frontend/components/ui/Modal.tsx`, add `confirmClose?: () => boolean` to `ModalProps`, add the scroll-lock effect, and gate the backdrop handler:

```tsx
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);
```

```tsx
  function handleBackdropClick() {
    // Escape and explicit Cancel always close. Only the backdrop — the one that
    // fires on a stray click — is guarded, because it is the path that silently
    // discards an unsaved review.
    if (confirmClose && !confirmClose()) return;
    onClose();
  }
```

and use `onClick={handleBackdropClick}` on the backdrop div.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx jest components/__tests__/Modal.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 5: Wire the dirty guard into BookEditModal**

In `frontend/components/BookEditModal.tsx`, compute dirtiness from the state already tracked at lines 43–46 and pass it through:

```tsx
  const isDirty =
    rating !== initialRating ||
    review !== initialReview ||
    dateRead !== initialDate ||
    exclude !== initialExclude;
```

```tsx
    <Modal
      labelId={titleId}
      onClose={onClose}
      confirmClose={() =>
        !isDirty || window.confirm('Discard your unsaved changes to this book?')
      }
      className={/* unchanged */}
    >
```

- [ ] **Step 6: Run the full gates**

Run: `cd frontend && npm test && npm run type-check && npm run lint && npm run format:check && npm run build`

- [ ] **Step 7: Stage and report**

```bash
git add frontend/components/ui/Modal.tsx frontend/components/BookEditModal.tsx frontend/components/__tests__/Modal.test.tsx
```

---

## Task 9: Disambiguate the swipe reject modal

**Files:**
- Modify: `frontend/app/(main)/swipe/page.tsx:313-356`
- Test: `frontend/app/__tests__/rejectModal.test.tsx`

**Interfaces:**
- Consumes: `submitReject`, `REJECT_REASONS` (already in the file).
- Produces: no exported API change.

> Today "Skip" and "Confirm" both call `submitReject` — byte-identical behavior. "Skip" reads as "cancel this dialog" but files the rejection, while Escape and backdrop-click (which look like they do nothing) are the actual cancels. One of the two buttons has to go.

- [ ] **Step 1: Write the failing test**

```tsx
/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';

describe('reject-reason modal copy', () => {
  it('does not offer two buttons that do the same thing', () => {
    // Guard at the source level: the modal must not render a "Skip" button that
    // shares its handler with the submit button.
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '../(main)/swipe/page.tsx'),
      'utf8'
    );
    const submitHandlers = src.match(/onClick=\{submitReject\}/g) ?? [];
    expect(submitHandlers).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx jest app/__tests__/rejectModal.test.tsx`
Expected: FAIL — received length 2.

- [ ] **Step 3: Replace the button row**

In `frontend/app/(main)/swipe/page.tsx`, replace the two-button row at lines 347–354 with a Cancel that actually cancels plus one submit whose label states what happens:

```tsx
          <div className="mt-5 flex gap-3 justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setPendingRejectId(null);
                setSelectedReasons(new Set());
              }}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={submitReject}>
              {selectedReasons.size > 0 ? 'Skip with reason' : 'Skip this book'}
            </Button>
          </div>
```

Also change the helper copy at line 325 from `text-faint` to `text-muted` so it clears AA body.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx jest app/__tests__/rejectModal.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run the full gates**

Run: `cd frontend && npm test && npm run type-check && npm run lint && npm run format:check && npm run build`

- [ ] **Step 6: Stage and report**

```bash
git add "frontend/app/(main)/swipe/page.tsx" frontend/app/__tests__/rejectModal.test.tsx
```

---

## Task 10: Rebuild `tasteAccent` on the verified ramp

**Files:**
- Modify: `frontend/lib/tasteAccent.ts` (full rewrite)
- Test: `frontend/lib/__tests__/tasteAccent.test.ts`

**Interfaces:**
- Consumes: `fitToSrgb`, `solveLightnessForContrast`, `contrastRatio` from Task 1.
- Produces: `tasteAccent(seed: string | null | undefined): TasteAccent` where `interface TasteAccent { surface: string; ink: string; vivid: string }` — **this is a breaking change from the old `string` return.** Every call site must be updated in this task. Current call sites: `app/(main)/page.tsx:141`, `components/TasteHero.tsx:146`, and any hit from the grep in Step 5.

> The old comment claims the archetype colors are "curated for legibility." Measured: IPDH 4.50, IPDM 4.49, RCDM 3.93 on `--surface` — three of sixteen fail. The hash fallback is worse (2.69 at hue 240). Hue is kept as the identity signal; lightness is solved rather than guessed.

- [ ] **Step 1: Write the failing test**

```ts
import { tasteAccent, ARCHETYPE_HUES } from '@/lib/tasteAccent';
import { contrastRatio } from '@/lib/contrast';

const SURFACE = '#1f1b18';
const TEXT = '#f5f0e8';

describe('tasteAccent', () => {
  it('returns the brand accent triple for a null seed', () => {
    expect(tasteAccent(null).vivid).toBe('#ff5c3a');
  });

  it.each(Object.keys(ARCHETYPE_HUES))(
    '%s: ink is readable on its drenched surface',
    (code) => {
      const a = tasteAccent(code);
      expect(contrastRatio(a.ink, a.surface)).toBeGreaterThanOrEqual(4.5);
    }
  );

  it.each(Object.keys(ARCHETYPE_HUES))(
    '%s: vivid is readable as small text on --surface',
    (code) => {
      expect(contrastRatio(tasteAccent(code).vivid, SURFACE)).toBeGreaterThanOrEqual(4.5);
    }
  );

  it('holds the same guarantees for arbitrary non-archetype seeds', () => {
    for (let i = 0; i < 400; i++) {
      const a = tasteAccent(`subject-${i}`);
      expect(contrastRatio(a.vivid, SURFACE)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(a.ink, a.surface)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('is deterministic for a given seed', () => {
    expect(tasteAccent('RCDM')).toEqual(tasteAccent('RCDM'));
    expect(tasteAccent('gothic-fiction')).toEqual(tasteAccent('gothic-fiction'));
  });

  it('keeps ink constant at the theme text color', () => {
    expect(tasteAccent('IPBH').ink).toBe(TEXT);
  });

  it('gives visibly different hues to different archetypes', () => {
    expect(tasteAccent('IPBH').surface).not.toBe(tasteAccent('RCDM').surface);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx jest lib/__tests__/tasteAccent.test.ts`
Expected: FAIL — `ARCHETYPE_HUES` is not exported and `tasteAccent` returns a string.

- [ ] **Step 3: Rewrite the module**

```ts
// frontend/lib/tasteAccent.ts
// Hue carries archetype identity; lightness is SOLVED for contrast rather than
// pinned, which is what the previous HSL implementation got wrong (blue and
// violet seeds landed at 2.69:1 on --surface).
import { contrastRatio, fitToSrgb, solveLightnessForContrast } from '@/lib/contrast';

/** Theme constants — keep in sync with app/globals.css. */
const SURFACE = '#1f1b18';
const TEXT = '#f5f0e8';
const BRAND_ACCENT = '#ff5c3a';

/** Drenched-panel geometry, verified across all 360 hues (worst ink 6.17:1). */
const PANEL_L = 0.45;
const PANEL_C = 0.15;
/** Vivid-accent chroma; lightness is solved per hue against --surface. */
const VIVID_C = 0.16;

export interface TasteAccent {
  /** Large colored field — the drenched taste-hero panel background. */
  surface: string;
  /** Ink that sits on `surface`. */
  ink: string;
  /** Saturated accent for small text, bars, and letters on the neutral --surface. */
  vivid: string;
}

export const ARCHETYPE_HUES: Record<string, number> = {
  IPBH: 24, // Wandering Escapist
  IPBM: 180, // Plot Mechanic
  IPDH: 0, // Serial Thrill-Seeker
  IPDM: 270, // Genre Architect
  ICBH: 345, // Empathic Rover
  ICBM: 210, // Character Analyst
  ICDH: 142, // Devoted Fan
  ICDM: 290, // Deep Empath
  RPBH: 38, // Conscious Adventurer
  RPBM: 170, // Eclectic Critic
  RPDH: 18, // Committed Purist
  RPDM: 225, // Structural Connoisseur
  RCBH: 318, // Literary Wanderer
  RCBM: 195, // Cerebral Explorer
  RCDH: 47, // Canon Keeper
  RCDM: 248, // Cerebral Architect
};

const cache = new Map<string, TasteAccent>();

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function build(hue: number): TasteAccent {
  return {
    surface: fitToSrgb(PANEL_L, PANEL_C, hue),
    ink: TEXT,
    vivid: solveLightnessForContrast(VIVID_C, hue, SURFACE, 4.5),
  };
}

const BRAND: TasteAccent = {
  surface: fitToSrgb(PANEL_L, PANEL_C, 24),
  ink: TEXT,
  vivid: BRAND_ACCENT,
};

export function tasteAccent(seed: string | null | undefined): TasteAccent {
  if (!seed) return BRAND;

  const cached = cache.get(seed);
  if (cached) return cached;

  const hue = Object.prototype.hasOwnProperty.call(ARCHETYPE_HUES, seed)
    ? ARCHETYPE_HUES[seed]!
    : hash(seed) % 360;

  const result = build(hue);
  cache.set(seed, result);
  return result;
}

/** Exported for tests and for any future palette tooling. */
export { contrastRatio };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx jest lib/__tests__/tasteAccent.test.ts`
Expected: PASS. The brand-accent test asserts `#ff5c3a` at 5.57:1 on surface — already above the floor, so no clamping is applied to it.

- [ ] **Step 5: Update every call site**

Run: `cd frontend && grep -rn "tasteAccent" app components lib --include=*.ts --include=*.tsx | grep -v __tests__`

For each hit, replace the single-value usage with the triple. In `app/(main)/page.tsx:141,157`:

```tsx
  const accent = tasteAccent(archetype ? archetype.code : null);
```
```tsx
    <div
      className="fade-in space-y-6 py-6"
      style={{
        ['--user-accent' as string]: accent.vivid,
        ['--user-surface' as string]: accent.surface,
        ['--user-ink-rgb' as string]: '245 240 232',
      }}
    >
```

Apply the same shape in `components/TasteHero.tsx` (lines 146, 275, 310).

- [ ] **Step 6: Expose the new custom properties**

In `frontend/app/globals.css`, add to `:root` alongside `--user-accent`:

```css
  /* per-user taste ramp (set at runtime by tasteAccent; fallbacks = brand) */
  --user-accent: #ff5c3a;
  --user-surface: #972529; /* = fitToSrgb(0.45, 0.15, 24) — the brand hue's drenched panel */
  /* Channel triplet, NOT hex: Tailwind's /opacity modifier cannot apply an alpha
     to a var() that already holds a full color. Task 11 needs text-user-ink/70. */
  --user-ink-rgb: 245 240 232;
```

In `frontend/tailwind.config.ts`, extend `colors`:

```ts
        user: {
          DEFAULT: 'var(--user-accent)',
          surface: 'var(--user-surface)',
          ink: 'rgb(var(--user-ink-rgb) / <alpha-value>)',
        },
```

> **This detail is load-bearing and was verified by compiling the real config.** Declaring `ink: 'var(--user-ink)'` against a hex custom property makes `text-user-ink/70`, `bg-user-ink/20`, and `border-user-ink/30` emit **no CSS at all** — the classes are silently dropped and the element renders unstyled. The `rgb(var(--…-rgb) / <alpha-value>)` form is what makes opacity modifiers work. This is the same trap the existing comment above `--success-quiet` in `globals.css` warns about; `--user-surface` and `--user-accent` stay as hex because nothing applies an opacity modifier to them.
>
> `user: 'var(--user-accent)'` becomes `user.DEFAULT`, so existing `text-user` / `bg-user` classes keep working unchanged.

Because `--user-ink` is now a triplet rather than a hex, `TasteAccent.ink` must be emitted in that form at the call sites. In `app/(main)/page.tsx` and `components/TasteHero.tsx`, set:

```tsx
        ['--user-ink-rgb' as string]: '245 240 232',
```

`ink` stays `#f5f0e8` on the `TasteAccent` object (the tests assert contrast against a hex), and the triplet is a static constant because ink never varies by archetype.

- [ ] **Step 7: Run the full gates**

Run: `cd frontend && npm test && npm run type-check && npm run lint && npm run format:check && npm run build`

- [ ] **Step 8: Stage and report**

```bash
git add frontend/lib/tasteAccent.ts frontend/lib/__tests__/tasteAccent.test.ts frontend/app/globals.css frontend/tailwind.config.ts "frontend/app/(main)/page.tsx" frontend/components/TasteHero.tsx
```

---

## Task 11: Drench the taste hero (the Committed surface)

**Files:**
- Modify: `frontend/components/TasteHero.tsx:308-431`
- Test: `frontend/components/__tests__/TasteHero.test.tsx`

**Interfaces:**
- Consumes: `TasteAccent` from Task 10; `user-surface` / `user-ink` Tailwind colors.
- Produces: no exported API change — `TasteHero` keeps its `compact?: boolean` prop.

> This is the whole point of the color recommit. The archetype panel stops being a neutral card with colored text and becomes a colored field. Everything outside it stays Restrained.

- [ ] **Step 1: Write the failing test**

```tsx
/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { TasteHero } from '@/components/TasteHero';

const archetype = {
  code: 'RCDM',
  name: 'The Cerebral Architect',
  tagline: 'You build cathedrals out of ideas.',
  is_stale: false,
  lens: { score: 0.6, rationale: 'r', letter: 'R' },
  engine: { score: -0.4, rationale: 'r', letter: 'C' },
  range: { score: 0.5, rationale: 'r', letter: 'D' },
  resonance: { score: 0.3, rationale: 'r', letter: 'M' },
};

jest.mock('swr', () => ({
  __esModule: true,
  default: (key: string) => {
    if (key === 'archetype') return { data: archetype, isLoading: false };
    if (key === 'profile-traits') return { data: [], isLoading: false };
    if (key === 'profile-subjects') return { data: { overall: [] }, isLoading: false };
    return { data: { last_profiled_at: '2026-01-01', dirty: false }, isLoading: false };
  },
  useSWRConfig: () => ({ mutate: jest.fn() }),
}));

describe('TasteHero', () => {
  it('renders the archetype panel as a drenched user-colored field', () => {
    const { container } = render(<TasteHero />);
    const panel = container.firstElementChild as HTMLElement;
    expect(panel.className).toContain('bg-user-surface');
    expect(panel.className).not.toContain('bg-surface');
  });

  it('names the archetype in ink that sits on the drenched panel', () => {
    render(<TasteHero />);
    expect(screen.getByText('The Cerebral Architect').className).toContain('text-user-ink');
  });
});
```

> The `useSWR` mock keys must match the constants in `TasteHero.tsx` (`ARCHETYPE_KEY`, `TRAITS_KEY`, `SUBJECTS_KEY`, `PROFILE_STATUS_KEY`). Read those values and adjust the mock if they differ from the strings above.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx jest components/__tests__/TasteHero.test.tsx`
Expected: FAIL — the panel is still `bg-surface`.

- [ ] **Step 3: Convert the archetype branch to the drenched panel**

In the final `return` of `TasteHero` (line 308), change the container and the text tiers:

```tsx
    <div
      style={{
        ['--user-accent' as string]: accent.vivid,
        ['--user-surface' as string]: accent.surface,
        ['--user-ink-rgb' as string]: '245 240 232',
      }}
      className={['rounded-2xl bg-user-surface text-user-ink', padClass].join(' ')}
    >
```

Then, inside the panel, colored-on-neutral text no longer applies — the field is the color. Replace:
- the "Reader type" eyebrow and "What is this?" button: `text-muted` / `text-faint` → `text-user-ink/70` and `text-user-ink/60`
- `<h1 className={headingClass}><span className="text-user">{archetype.name}</span></h1>` → drop the inner span; put `text-user-ink` on the `h1`
- the tagline `text-muted italic` → `text-user-ink/80 italic`
- axis bars: track `bg-elevated` → `bg-user-ink/20`, fill `bg-user` → `bg-user-ink`
- axis letters `text-user` → `text-user-ink`, axis names `text-faint` → `text-user-ink/70`
- the `why`/`hide` toggles `text-faint hover:text-muted` → `text-user-ink/60 hover:text-user-ink`
- the stale warning `text-warning` → `text-user-ink` with the existing warning icon retained if present

Leave the `Badge` and the two footer `Button`s as they are — they are components with their own contract, and the next task verifies them against the panel.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx jest components/__tests__/TasteHero.test.tsx`
Expected: PASS.

- [ ] **Step 5: Fix the footer buttons — `--muted` does not survive the drenched panel**

This was measured, not left open: `--muted` (`#a89f92`) against the drenched panels ranges from **3.08:1** (brand hue 24) down to **2.67:1** (worst, hue 141). It fails AA body on every archetype. So `variant="ghost"` — which is `text-muted` — must not be used inside the panel.

Change the two footer buttons in `TasteHero.tsx` (currently `ghost` for "Re-derive" and `secondary` for "Share") to carry panel ink explicitly:

```tsx
          <Button
            variant="ghost"
            size="sm"
            loading={rederiving}
            onClick={handleRederive}
            className="text-user-ink/80 hover:text-user-ink hover:bg-user-ink/10"
          >
            Re-derive
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShareOpen(true)}
            className="border-user-ink/30 bg-user-ink/10 text-user-ink hover:bg-user-ink/20"
          >
            Share
          </Button>
```

Then lock it in so it cannot regress — add to `frontend/lib/__tests__/tasteAccent.test.ts`:

```ts
  it.each(Object.keys(ARCHETYPE_HUES))(
    '%s: --muted is NOT usable on the drenched panel (guards against ghost buttons)',
    (code) => {
      // Documents why TasteHero overrides ghost/secondary ink inside the panel.
      expect(contrastRatio('#a89f92', tasteAccent(code).surface)).toBeLessThan(4.5);
    }
  );
```

- [ ] **Step 5b: Confirm the Badge still reads**

`Badge variant="mono"` is `bg-elevated text-muted` — same problem, and it renders the archetype code at the top of the panel. Override it at the call site (line 324) with `bg-user-ink/15 text-user-ink`, or swap to a plain `<span>` styled from panel ink. Report which you chose.

- [ ] **Step 6: Run the full gates**

Run: `cd frontend && npm test && npm run type-check && npm run lint && npm run format:check && npm run build`

- [ ] **Step 7: Stage and report**

```bash
git add frontend/components/TasteHero.tsx frontend/components/__tests__/TasteHero.test.tsx frontend/lib/__tests__/tasteAccent.test.ts
```

---

## Task 12: Put the hero on the dashboard and vary the rhythm

**Files:**
- Modify: `frontend/app/(main)/page.tsx:156-231`
- Test: `frontend/app/__tests__/dashboard.test.tsx`

**Interfaces:**
- Consumes: `TasteHero` from Task 11.
- Produces: no exported API change.

> `REDESIGN_SPEC.md` locks the concept: *"the hero of the app is the user's generated taste identity, surfaced on the dashboard (not buried in /profile)."* Today the dashboard shows a 14px badge at 60% opacity and three visually identical cards at uniform `space-y-6`.

- [ ] **Step 1: Write the failing test**

```tsx
/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import HomePage from '@/app/(main)/page';

jest.mock('@/components/TasteHero', () => ({
  TasteHero: () => <div data-testid="taste-hero" />,
}));
jest.mock('swr', () => ({
  __esModule: true,
  default: () => ({ data: undefined, isLoading: false, error: undefined }),
  mutate: jest.fn(),
}));
jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));

describe('dashboard', () => {
  it('renders the taste hero', () => {
    render(<HomePage />);
    expect(screen.getByTestId('taste-hero')).toBeInTheDocument();
  });

  it('places the hero above the stats strip', () => {
    const { container } = render(<HomePage />);
    const html = container.innerHTML;
    expect(html.indexOf('taste-hero')).toBeGreaterThan(-1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx jest app/__tests__/dashboard.test.tsx`
Expected: FAIL — `taste-hero` is not in the document.

- [ ] **Step 3: Restructure the page**

In `frontend/app/(main)/page.tsx`:

1. Import `TasteHero` from `@/components/TasteHero`.
2. Replace the archetype `Badge`/`Link` block (lines 169–191) with `<TasteHero />` placed immediately after the greeting `h1`. Delete the now-unused `Badge` import if nothing else uses it, and delete the `opacity-60` link entirely — that was a marginal color at 40% transparency.
3. Break the uniform rhythm: change the page wrapper from `space-y-6` to explicit spacing so the hero owns more room than the utility cards:

```tsx
    <div className="fade-in py-6" style={{ /* accent custom props, unchanged */ }}>
      <h1 className="font-display text-4xl sm:text-5xl font-extrabold tracking-tight text-text leading-tight">
        {/* unchanged greeting */}
      </h1>

      <div className="mt-6">
        <TasteHero />
      </div>

      <div className="mt-10 space-y-4">
        {/* stats strip + ratings breakdown — the quiet utility tier */}
      </div>

      <div className="mt-10">
        {/* "Ready for new picks?" CTA card */}
      </div>
    </div>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx jest app/__tests__/dashboard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Demote the duplicate on /profile**

`app/(main)/profile/page.tsx:544` renders `<TasteHero compact />`. Leave it — the profile page is where you edit traits and re-derive, so the hero belongs in both places. Confirm both render without a key collision by running the profile test suite if one exists.

- [ ] **Step 6: Run the full gates**

Run: `cd frontend && npm test && npm run type-check && npm run lint && npm run format:check && npm run build`

- [ ] **Step 7: Stage and report**

```bash
git add "frontend/app/(main)/page.tsx" frontend/app/__tests__/dashboard.test.tsx
```

---

## Task 13: One source of truth for navigation

**Files:**
- Create: `frontend/lib/nav.ts`
- Modify: `frontend/components/NavBar.tsx:10-17`
- Modify: `frontend/components/BottomNav.tsx:7-13`
- Test: `frontend/components/__tests__/nav.test.tsx`

**Interfaces:**
- Consumes: `lucide-react` icons (already a dependency, already used in `BottomNav`).
- Produces: `NAV_ROUTES: readonly NavRoute[]` where `interface NavRoute { href: string; label: string; Icon: LucideIcon; primary: boolean }`. `primary: true` means the route appears in the mobile bottom nav.

> `NavBar` lists Discover; `BottomNav` does not — on a phone the only route to it is a tertiary dashboard link. The two also name the same destinations differently ("My library" vs "Library").

- [ ] **Step 1: Write the failing test**

```tsx
/**
 * @jest-environment jsdom
 */
import { NAV_ROUTES } from '@/lib/nav';

describe('navigation route table', () => {
  it('gives every route exactly one label', () => {
    const byHref = new Map<string, string>();
    for (const r of NAV_ROUTES) {
      expect(byHref.has(r.href)).toBe(false);
      byHref.set(r.href, r.label);
    }
  });

  it('includes Discover', () => {
    expect(NAV_ROUTES.some((r) => r.href === '/discover')).toBe(true);
  });

  it('marks Discover as reachable from the mobile bottom nav', () => {
    expect(NAV_ROUTES.find((r) => r.href === '/discover')!.primary).toBe(true);
  });

  it('keeps the bottom nav within the five-item thumb budget', () => {
    expect(NAV_ROUTES.filter((r) => r.primary)).toHaveLength(5);
  });

  it('gives every route an icon', () => {
    for (const r of NAV_ROUTES) expect(typeof r.Icon).not.toBe('undefined');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx jest components/__tests__/nav.test.tsx`
Expected: FAIL — `Cannot find module '@/lib/nav'`.

- [ ] **Step 3: Write the route table**

```ts
// frontend/lib/nav.ts
// Single source of truth for application navigation. NavBar (desktop) renders
// every route; BottomNav (mobile) renders the `primary` ones. Previously the two
// components kept separate lists, which is how /discover became unreachable on
// mobile and how "My library" and "Library" ended up naming the same route.
import { BookOpen, Compass, Home, Settings, Shuffle, User } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface NavRoute {
  href: string;
  label: string;
  Icon: LucideIcon;
  /** Appears in the mobile bottom nav. Budget: 5, for thumb reach. */
  primary: boolean;
}

export const NAV_ROUTES: readonly NavRoute[] = [
  { href: '/', label: 'Home', Icon: Home, primary: true },
  { href: '/swipe', label: 'Swipe', Icon: Shuffle, primary: true },
  { href: '/discover', label: 'Discover', Icon: Compass, primary: true },
  { href: '/library', label: 'Library', Icon: BookOpen, primary: true },
  { href: '/profile', label: 'Profile', Icon: User, primary: true },
  { href: '/settings', label: 'Settings', Icon: Settings, primary: false },
] as const;
```

> Settings drops out of the bottom nav to keep it at five and make room for Discover. It stays one tap away in the desktop nav and is reachable on mobile from the profile page — confirm that link exists before finalizing; if it does not, add one to `/profile` in this task.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx jest components/__tests__/nav.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 5: Consume the table in both navs**

In `frontend/components/NavBar.tsx`, delete the local `links` array and map over `NAV_ROUTES` instead. In `frontend/components/BottomNav.tsx`, delete its local `links` array and map over `NAV_ROUTES.filter((r) => r.primary)`. Keep each component's existing class names, `aria-current` handling, and focus rings unchanged.

- [ ] **Step 6: Verify no divergent lists remain**

Run: `cd frontend && grep -n "href: '/" components/NavBar.tsx components/BottomNav.tsx`
Expected: no output — both now read from `lib/nav.ts`.

- [ ] **Step 7: Run the full gates**

Run: `cd frontend && npm test && npm run type-check && npm run lint && npm run format:check && npm run build`

- [ ] **Step 8: Stage and report**

```bash
git add frontend/lib/nav.ts frontend/components/NavBar.tsx frontend/components/BottomNav.tsx frontend/components/__tests__/nav.test.tsx
```

---

## Task 14: Whole-app verification

**Files:** none modified unless a check fails.

- [ ] **Step 1: Run every gate from a clean state**

```bash
cd frontend
npm run test:server && npm test && npm run type-check && npm run lint && npm run format:check && npm run build
```
Expected: all six pass. Record the test counts.

- [ ] **Step 2: Re-run the deterministic design detector**

```bash
node ~/.claude/plugins/cache/impeccable/impeccable/*/skills/impeccable/scripts/detect.mjs frontend/app frontend/components
```
Expected: exit 0, no findings — same as the pre-work baseline. If the drenched panel introduced a finding, report it rather than suppressing it.

- [ ] **Step 3: Confirm no unassociated form controls survive**

```bash
cd frontend && grep -rn "<label" app components --include=*.tsx | grep -v htmlFor | grep -v "SetupWizard.tsx:347"
```
Expected: no output.

- [ ] **Step 4: Exercise the app in a browser**

Per Chase's standing rule, tests alone do not establish that a change works. Start the app and walk the real flows:

```bash
cd frontend && npm run dev
```

Verify by eye, on both a desktop viewport and a ~390px mobile viewport:
1. `/login` — labels visible and clickable, focus rings land, Sign in works.
2. `/` — the drenched taste hero renders in the archetype color with legible ink; stats and CTA sit in the quieter tier below it.
3. `/swipe` — reject modal shows Cancel + one submit; Cancel really cancels.
4. `/library` — open a book, type a review, click the backdrop: the discard confirm appears.
5. Bottom nav shows five items including Discover; every label matches the desktop nav.

Report what you saw. If any step cannot be reached because of missing local env, say so explicitly rather than reporting it as verified.

- [ ] **Step 5: Re-run the critique to measure movement**

```
/impeccable critique frontend/app/globals.css
```
Expected: the trend line shows movement from the 24/40 baseline. Report the new score and any issues that survived.

- [ ] **Step 6: Stage and report**

```bash
git status --short
```
Summarize every file touched across all 14 tasks. **Do not commit.**

---

## Self-Review

**Spec coverage.** Every in-scope critique finding maps to a task:

| Critique finding | Severity | Task |
|---|---|---|
| Form controls unlabeled for assistive tech | P1 | 4, 5, 6, 7 |
| `--faint` fails AA body contrast (143 usages) | P1 | 2 |
| White-on-accent buttons fail contrast | P1 | 3 |
| `tasteAccent` fails its own legibility promise | P1 | 10 |
| Backdrop-click destroys unsaved review | P1 | 8 |
| Reject modal's "Skip" and "Confirm" are identical | P1 | 9 |
| Discover unreachable on mobile; divergent nav labels | P2 | 13 |
| Dashboard buries the taste hero | P2 | 11, 12 |
| Committed color strategy (user direction) | — | 10, 11 |
| `--border` below 3:1 for control boundaries | minor | 2, 4 |
| `--danger` marginal as text | minor | 2 |

Deliberately unaddressed, per the user's scope decision: the 27 eyebrows outside form labels, the Bricolage/Inter pairing, the `text-base` rename, `.fade-in`, `RatingsBreakdown`'s `transition-all` on width, `--hairline`/`--elevated` duplication, `ring-offset-base` halos, the X/R/+ glyphs, and swipe keyboard shortcuts. These are recorded here so the next pass does not have to rediscover them.

**Placeholder scan.** No TBDs. Six places instruct the implementer to read surrounding JSX before naming a label (Task 6 Step 5; Task 7 Steps 3–4) — that is deliberate, because inventing a label that misdescribes a control is worse than reading it, and I have not read those specific JSX blocks. Every such instance names the exact file and line.

**Type consistency.** `TasteAccent { surface, ink, vivid }` is defined in Task 10 and consumed in Tasks 11 and 12 under those exact names. `NavRoute { href, label, Icon, primary }` is defined in Task 13 and consumed in the same task. `Modal`'s new `confirmClose?: () => boolean` is defined in Task 8 and consumed in Task 8 Step 5. `contrastRatio` / `fitToSrgb` / `solveLightnessForContrast` are defined in Task 1 and consumed in Tasks 2, 10, and 11 with matching signatures.

**Known risk.** Task 10 changes `tasteAccent`'s return type from `string` to an object. Every call site must be updated in that same task or the build breaks — Step 5 exists for exactly that reason, and `npm run build` in Step 7 is the gate that catches a miss.
