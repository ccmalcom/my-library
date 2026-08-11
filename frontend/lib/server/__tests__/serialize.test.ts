import { describe, expect, test, it } from 'vitest';
import {
  tsToIso,
  pyTitle,
  effectiveRating,
  round2,
  round4,
  pyRoundHalfEven,
  parseBoolParam,
  utcnowTs,
  todayIsoDate,
  pyList,
  parseIdParam,
  serializeResolutionConfidence,
} from '../serialize';
import { ApiError } from '../errors';
import type { ConfidenceLabel } from '../enrichment';

describe('tsToIso', () => {
  test('converts postgres timestamp string to ISO T form', () => {
    expect(tsToIso('2026-07-01 12:00:00')).toBe('2026-07-01T12:00:00');
    expect(tsToIso('2026-07-01 12:00:00.123456')).toBe('2026-07-01T12:00:00.123456');
  });
  test('passes null through', () => {
    expect(tsToIso(null)).toBeNull();
  });
});

describe('pyTitle', () => {
  // Expected values are Python str.title() outputs — including its quirks.
  test('matches Python str.title()', () => {
    expect(pyTitle('science fiction')).toBe('Science Fiction');
    expect(pyTitle('anthropological sf')).toBe('Anthropological Sf');
    expect(pyTitle("children's literature")).toBe("Children'S Literature"); // Python quirk: S after apostrophe
    expect(pyTitle('sci-fi & fantasy')).toBe('Sci-Fi & Fantasy');
    expect(pyTitle('WORLD WAR II')).toBe('World War Ii');
    expect(pyTitle('')).toBe('');
  });
});

describe('effectiveRating', () => {
  test('app rating wins when set', () => {
    expect(effectiveRating(5, 3)).toBe(5);
  });
  test('falls back to goodreads rating', () => {
    expect(effectiveRating(null, 4)).toBe(4);
  });
  test('goodreads 0 means unrated', () => {
    expect(effectiveRating(null, 0)).toBeNull();
  });
  test('app rating beats goodreads 0', () => {
    expect(effectiveRating(5, 0)).toBe(5);
  });
});

describe('rounding', () => {
  test('serializes the complete enrichment confidence table', () => {
    expect(
      ['HIGH', 'MEDIUM', 'LOW', 'NONE'].map((label) => [
        label,
        serializeResolutionConfidence(label as ConfidenceLabel),
      ])
    ).toEqual([
      ['HIGH', 0.95],
      ['MEDIUM', 0.7],
      ['LOW', 0.3],
      ['NONE', 0.0],
    ]);
  });

  test('round2 matches Python round(x, 2), including banker-rounded ties', () => {
    expect(round2(4.333333)).toBe(4.33);
    // Exact binary ties -- the only place Math.round(x*100)/100 can be wrong.
    // Ties round to EVEN: 12.5 -> 12, 37.5 -> 38, 62.5 -> 62, 87.5 -> 88.
    expect(round2(0.125)).toBe(0.12);
    expect(round2(0.375)).toBe(0.38);
    expect(round2(0.625)).toBe(0.62);
    expect(round2(0.875)).toBe(0.88);
    expect(round2(-0.125)).toBe(-0.12);
    // NOT ties: 0.015*100 is 1.4999999999999998 in binary, so it rounds DOWN,
    // which Math.round(0.015*100) gets wrong by scaling first.
    expect(round2(0.015)).toBe(0.01);
    expect(round2(0.045)).toBe(0.04);
    expect(round2(2.675)).toBe(2.67);
    expect(round2(0.95)).toBe(0.95);
    expect(round2(1)).toBe(1);
  });

  test('pyRoundHalfEven matches Python round(x)', () => {
    expect(pyRoundHalfEven(0.5)).toBe(0);
    expect(pyRoundHalfEven(1.5)).toBe(2);
    expect(pyRoundHalfEven(2.5)).toBe(2);
    expect(pyRoundHalfEven(4.5)).toBe(4);
    expect(pyRoundHalfEven(-0.5)).toBe(0);
    expect(pyRoundHalfEven(-1.5)).toBe(-2);
    expect(pyRoundHalfEven(18)).toBe(18);
    expect(pyRoundHalfEven(17.9)).toBe(18);
  });

  test('round4 matches Python round(x, 4), including banker-rounded ties', () => {
    expect(round4(0.123456)).toBe(0.1235);
    expect(round4(0)).toBe(0);
    expect(round4(1)).toBe(1);
    // Exact binary ties at the 4th decimal are the odd 32nds (x * 32 an odd
    // integer), the only place Math.round(x*10000)/10000 can be wrong.
    // Ties round to EVEN: 312.5 -> 312, 937.5 -> 938, 1562.5 -> 1562.
    expect(round4(0.03125)).toBe(0.0312);
    expect(round4(0.09375)).toBe(0.0938);
    expect(round4(0.15625)).toBe(0.1562);
    expect(round4(0.21875)).toBe(0.2188);
    expect(round4(-0.03125)).toBe(-0.0312);
    // NOT ties: these decimals have no exact binary form, so the exact value
    // sits just off the midpoint and the strict inequality decides.
    expect(round4(0.00005)).toBe(0.0001);
    expect(round4(0.00015)).toBe(0.0001);
    // A real /profile/highlights share: 1 genre book out of 32 enriched rated.
    expect(round4(1 / 32)).toBe(0.0312);
  });
});

describe('parseBoolParam', () => {
  test('FastAPI-style truthy strings', () => {
    for (const v of ['true', 'True', '1', 'yes', 'on']) expect(parseBoolParam(v)).toBe(true);
    for (const v of ['false', '0', 'no', 'off', undefined])
      expect(parseBoolParam(v as any)).toBe(false);
  });
});

it('utcnowTs returns space-separated UTC timestamp', () => {
  expect(utcnowTs()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
});
it('todayIsoDate returns YYYY-MM-DD', () => {
  expect(todayIsoDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});
it('pyList formats like Python list repr', () => {
  expect(pyList(['a', 'b'])).toBe("['a', 'b']");
  expect(pyList([])).toBe('[]');
});

describe('parseIdParam', () => {
  test('accepts plain integer strings', () => {
    expect(parseIdParam('7')).toBe(7);
    expect(parseIdParam('0')).toBe(0);
    expect(parseIdParam('-3')).toBe(-3);
    expect(parseIdParam('007')).toBe(7); // Number() coercion, same as old bare Number(id)
  });
  test('rejects non-numeric ids with a 422 ApiError instead of yielding NaN', () => {
    expect(() => parseIdParam('abc')).toThrow(ApiError);
    try {
      parseIdParam('abc');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(422);
      expect((err as ApiError).detail).toBe('validation error: id must be an integer');
    }
  });
  test('rejects non-integer numeric strings', () => {
    expect(() => parseIdParam('1.5')).toThrow(ApiError);
  });
  test('documents the Number("") === 0 edge case (matches Number.isInteger, not rejected)', () => {
    // A blank [id] segment can't actually reach a route handler through Next.js
    // routing, so this quirk of Number() is inherited, not specifically guarded.
    expect(parseIdParam('')).toBe(0);
  });
});
