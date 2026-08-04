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
    expect(sameWork('Exodus: The Archimedes Engine', 'Peter F. Hamilton',
                    'Exodus: The Helium Sea', 'Peter F. Hamilton')).toBe(false);
    expect(sameWork('Dune', 'Frank Herbert', 'Dune', 'Arthur C. Clarke')).toBe(false);
  });
});
