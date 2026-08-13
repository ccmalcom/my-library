import { describe, it, expect } from 'vitest';
import { normalizeTitle, surname, normalizeFullTitle, sameWork } from './dedup';

describe('dedup', () => {
  it('normalizeTitle drops subtitle, parentheticals, punctuation', () => {
    expect(normalizeTitle('Dune: Special Edition')).toBe('dune');
    expect(normalizeTitle('The Hobbit (Illustrated)')).toBe('the hobbit');
    expect(normalizeTitle("Ender's  Game!")).toBe('ender s game');
    expect(normalizeTitle(null)).toBe('');
  });
  it('surname takes last word of normalized author', () => {
    expect(surname('Ursula K. Le Guin')).toBe('guin');
    expect(surname(null)).toBe('');
    expect(surname('')).toBe('');
  });
  it('normalizeFullTitle keeps the subtitle', () => {
    expect(normalizeFullTitle('Exodus: The Helium Sea')).toBe('exodus the helium sea');
  });
  it('sameWork: edition variant matches, sibling subtitles do not', () => {
    expect(sameWork('Dune', 'Frank Herbert', 'Dune: Special Edition', 'Herbert')).toBe(true);
    expect(
      sameWork(
        'Exodus: The Archimedes Engine',
        'Peter F. Hamilton',
        'Exodus: The Helium Sea',
        'Peter F. Hamilton'
      )
    ).toBe(false);
    expect(sameWork('Dune', 'Frank Herbert', 'Dune', 'Arthur C. Clarke')).toBe(false);
  });
  it('sameWork: same-surname different-author collision (inherited from Python behavior)', () => {
    // This documents an intentional false-positive surface inherited from mylibrary/enrich.py:
    // sameWork checks surname equality BEFORE comparing titles, so genuinely different books
    // by different authors who share a surname will be flagged as the same work.
    // E.g., Brian Herbert (Frank's son) wrote his own books; "Dune: House Atreides" by Brian
    // should NOT match Frank's "Dune", but it does because surname(authorA) === surname(authorB).
    // This is locked-in behavior — a refactor must not silently change it without test notice.
    expect(sameWork('Dune: House Atreides', 'Brian Herbert', 'Dune', 'Frank Herbert')).toBe(true);
  });
});
