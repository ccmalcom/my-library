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
