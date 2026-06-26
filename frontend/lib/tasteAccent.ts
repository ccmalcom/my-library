// Fixed accent color per archetype code — curated for legibility on the dark theme.
// Warm hues for Immersive (I) types, cooler hues for Reflective (R) types.
const ARCHETYPE_COLORS: Record<string, string> = {
  IPBH: 'hsl(24,  88%, 60%)',   // Wandering Escapist      — persimmon orange
  IPBM: 'hsl(180, 70%, 48%)',   // Plot Mechanic           — cyan
  IPDH: 'hsl(0,   80%, 60%)',   // Serial Thrill-Seeker    — red
  IPDM: 'hsl(270, 68%, 64%)',   // Genre Architect         — purple
  ICBH: 'hsl(345, 78%, 63%)',   // Empathic Rover          — rose
  ICBM: 'hsl(210, 72%, 62%)',   // Character Analyst       — cornflower blue
  ICDH: 'hsl(142, 60%, 50%)',   // Devoted Fan             — emerald
  ICDM: 'hsl(290, 65%, 62%)',   // Deep Empath             — violet
  RPBH: 'hsl(38,  88%, 55%)',   // Conscious Adventurer    — amber gold
  RPBM: 'hsl(170, 68%, 47%)',   // Eclectic Critic         — seafoam teal
  RPDH: 'hsl(18,  74%, 56%)',   // Committed Purist        — burnt sienna
  RPDM: 'hsl(225, 65%, 62%)',   // Structural Connoisseur  — slate blue
  RCBH: 'hsl(318, 72%, 60%)',   // Literary Wanderer       — magenta
  RCBM: 'hsl(195, 75%, 52%)',   // Cerebral Explorer       — sky blue
  RCDH: 'hsl(47,  86%, 54%)',   // Canon Keeper            — golden yellow
  RCDM: 'hsl(248, 65%, 64%)',   // Cerebral Architect      — indigo
};

const cache = new Map<string, string>();

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * Returns the accent color for a given seed.
 * If the seed is a known 4-letter archetype code, returns its curated color.
 * Otherwise derives a deterministic HSL from the seed string.
 * Falls back to the brand accent when no seed is provided.
 */
export function tasteAccent(seed: string | null | undefined): string {
  if (!seed) return 'var(--accent)';

  if (Object.prototype.hasOwnProperty.call(ARCHETYPE_COLORS, seed)) return ARCHETYPE_COLORS[seed]!;

  const cached = cache.get(seed);
  if (cached) return cached;

  const h1 = hash(seed);
  const h2 = hash(seed + 'S');
  const h3 = hash(seed + 'L');

  const hue   = h1 % 360;
  const sat   = 70 + (h2 % 16); // 70-85
  const light = 58 + (h3 % 9);  // 58-66

  const result = `hsl(${hue}, ${sat}%, ${light}%)`;
  cache.set(seed, result);
  return result;
}
