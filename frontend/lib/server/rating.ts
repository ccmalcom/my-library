/**
 * Rating domain rules. Ratings live on a 0.5 grid from 0.5 to 5.0.
 *
 * `app_rating IS NULL` means "no in-app override"; `goodreads_rating = 0`
 * means "unrated". Zero is never a rating, so 0.5 is the floor.
 *
 * This is deliberately NOT in serialize.ts: that module is the CPython
 * compatibility layer (pyRound/pyRepr/pyJsonDumps), and these are
 * ShelfSprite domain rules consumed by routes, import, and UI alike.
 */
import { z } from 'zod';

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
 * Zod validator for an incoming rating. `.multipleOf` uses decimal-safe
 * comparison, so 3.7 and 0.25 are rejected without float slop.
 */
export const ratingSchema = z.number().min(RATING_MIN).max(RATING_MAX).multipleOf(RATING_STEP);
