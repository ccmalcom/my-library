import { describe, expect, test, it } from 'vitest';
import {
  tsToIso, pyTitle, effectiveRating, round2, round4, parseBoolParam,
  utcnowTs, todayIsoDate, pyList,
} from '../serialize';

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
  test('round2 / round4', () => {
    expect(round2(4.333333)).toBe(4.33);
    expect(round4(0.123456)).toBe(0.1235);
    expect(round4(0)).toBe(0);
  });
});

describe('parseBoolParam', () => {
  test('FastAPI-style truthy strings', () => {
    for (const v of ['true', 'True', '1', 'yes', 'on']) expect(parseBoolParam(v)).toBe(true);
    for (const v of ['false', '0', 'no', 'off', undefined]) expect(parseBoolParam(v as any)).toBe(false);
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
