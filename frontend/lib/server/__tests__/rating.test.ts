import { describe, expect, it } from 'vitest';
import { isHalfStep, ratingSchema, roundRatingHalfStar } from '../rating';

describe('roundRatingHalfStar', () => {
  it('keeps values already on the half-star grid', () => {
    expect(roundRatingHalfStar(4.5)).toBe(4.5);
    expect(roundRatingHalfStar(3)).toBe(3);
  });

  it('rounds to the nearest half star, halves going up', () => {
    expect(roundRatingHalfStar(4.24)).toBe(4);
    expect(roundRatingHalfStar(4.25)).toBe(4.5);
    expect(roundRatingHalfStar(3.7)).toBe(3.5);
    expect(roundRatingHalfStar(3.8)).toBe(4);
  });

  it('clamps to the 0.5-5.0 domain', () => {
    expect(roundRatingHalfStar(7)).toBe(5);
    expect(roundRatingHalfStar(0.3)).toBe(0.5);
  });

  it('treats zero and below as unrated', () => {
    expect(roundRatingHalfStar(0)).toBeNull();
    expect(roundRatingHalfStar(-2)).toBeNull();
  });

  it('returns null for non-finite input', () => {
    expect(roundRatingHalfStar(Number.NaN)).toBeNull();
    expect(roundRatingHalfStar(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('isHalfStep', () => {
  it('accepts the grid and rejects everything else', () => {
    expect(isHalfStep(0.5)).toBe(true);
    expect(isHalfStep(5)).toBe(true);
    expect(isHalfStep(3.7)).toBe(false);
    expect(isHalfStep(0.25)).toBe(false);
  });
});

describe('ratingSchema', () => {
  it('accepts half stars and whole stars', () => {
    expect(ratingSchema.safeParse(4.5).success).toBe(true);
    expect(ratingSchema.safeParse(1).success).toBe(true);
  });

  it('rejects off-grid, out-of-range, and zero', () => {
    for (const bad of [3.7, 0.25, 0, 5.5, -1]) {
      expect(ratingSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('serialization rule', () => {
  // Global Constraint 6: whole ratings serialize as integers, halves as .5.
  // `mode: 'number'` gives this for free -- this test pins it so a future
  // pyFloatStr-style formatter cannot quietly turn 4 into "4.0" in a prompt.
  it('renders whole ratings without a decimal', () => {
    expect(JSON.stringify({ rating: 4 })).toBe('{"rating":4}');
    expect(JSON.stringify({ rating: 4.5 })).toBe('{"rating":4.5}');
  });
});
