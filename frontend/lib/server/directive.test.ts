import { describe, it, expect } from 'vitest';
import { cleanDirectiveConstraints } from './directive';

describe('cleanDirectiveConstraints', () => {
  it('normalizes languages to 2-letter lowercase', () => {
    expect(cleanDirectiveConstraints({ languages: ['EN', ' fr ', ''] }))
      .toEqual({ languages: ['en', 'fr'] });
  });
  it('coerces digit strings, keeps ints, skips bools, drops unknown keys', () => {
    expect(cleanDirectiveConstraints({ min_year: '1990', max_year: 2020, page_max: 400, series: true }))
      .toEqual({ min_year: 1990, max_year: 2020 });
  });
  it('empty input → {}', () => {
    expect(cleanDirectiveConstraints(null)).toEqual({});
  });
});
