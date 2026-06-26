const cache = new Map<string, string>();

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * Deterministic seed -> HSL color for the per-user taste accent.
 * Constrained to S: 70-85%, L: 58-66% for legibility on dark backgrounds.
 * Falls back to the persimmon brand accent when no seed is provided.
 */
export function tasteAccent(seed: string | null | undefined): string {
  if (!seed) return 'var(--accent)';

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
