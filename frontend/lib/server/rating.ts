/**
 * Rating domain rules. Ratings live on a 0.5 grid from 0.5 to 5.0.
 *
 * `app_rating IS NULL` means "no in-app override"; `goodreads_rating = 0`
 * means "unrated". Zero is never a rating, so 0.5 is the floor.
 *
 * This is deliberately NOT in serialize.ts: that module is the CPython
 * compatibility layer (pyRound/pyRepr/pyJsonDumps), and these are
 * ShelfSprite domain rules consumed by routes, import, and UI alike.
 *
 * Keep this module dependency-free. `StarRating` and the library page import
 * from it, so anything pulled in here ships to every client bundle -- a zod
 * import cost every page the zod runtime just to reach two numeric constants.
 */

export const RATING_STEP = 0.5;
export const RATING_MIN = 0.5;
export const RATING_MAX = 5;

/** True when `value` sits exactly on the half-star grid. */
export function isHalfStep(value: number): boolean {
  return Number.isFinite(value) && (value * 2) % 1 === 0;
}

/**
 * Round an arbitrary rating to the nearest half star, clamped to
 * [0.5, 5.0]. Exact halves round up. Returns null for "unrated" (<= 0)
 * and for non-finite input.
 *
 * Replaces roundRatingHalfUp, which rounded to the nearest WHOLE star and
 * so destroyed StoryGraph's half stars on import.
 */
export function roundRatingHalfStar(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  if (value <= 0) return null;
  const snapped = Math.round(value * 2) / 2;
  if (snapped < RATING_MIN) return RATING_MIN;
  if (snapped > RATING_MAX) return RATING_MAX;
  return snapped;
}

/**
 * True when `value` is a rating the API accepts: on the half-star grid and
 * within [0.5, 5.0]. Note 0 is NOT valid here -- it is the clear/unrated
 * sentinel, and callers must special-case it before asking.
 *
 * Deliberately a plain predicate rather than a zod schema. Both call sites
 * use it only as a boolean (the 422 message is written by hand, so parse
 * issues are discarded), and zod in this module reaches client bundles.
 */
export function isValidRating(value: number): boolean {
  return Number.isFinite(value) && value >= RATING_MIN && value <= RATING_MAX && isHalfStep(value);
}

/**
 * True when `rating` falls in the band a whole-star filter chip covers:
 * the chip's own star and the half below it, so a 3.5 is reachable from
 * the "4" chip. Without this, half-rated books match no chip at all.
 */
export function inStarBand(rating: number | null, chip: number): boolean {
  if (rating === null) return false;
  return rating > chip - 1 && rating <= chip;
}
