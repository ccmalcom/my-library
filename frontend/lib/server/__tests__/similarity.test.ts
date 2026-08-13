import { describe, test, expect } from 'vitest';
import { ratio, titleSim, STRONG_SIM } from '../similarity';

describe('SequenceMatcher.ratio port', () => {
  // Expected values produced by CPython:
  //   from difflib import SequenceMatcher; SequenceMatcher(None, a, b).ratio()
  test('matches CPython on identical, disjoint and partial overlaps', () => {
    expect(ratio('dune', 'dune')).toBe(1.0);
    expect(ratio('', '')).toBe(1.0); // length 0 -> Python returns 1.0, not 0.0
    expect(ratio('abc', '')).toBe(0.0);
    expect(ratio('abcd', 'bcde')).toBe(0.75);
    expect(ratio('the hobbit', 'the hobbits')).toBeCloseTo(0.9523809523809523, 15);
    expect(ratio('mistborn', 'mistborn the final empire')).toBeCloseTo(0.48484848484848486, 15);
    // 2 single-char matches ('i', then 'n') out of 17 combined chars -> 4/17.
    expect(ratio('kindred', 'exhalation')).toBeCloseTo(0.23529411764705882, 15);
  });

  test('finds the earliest longest match, like CPython', () => {
    // "ab" occurs twice in b; CPython anchors on the first.
    expect(ratio('ab', 'abxab')).toBeCloseTo(0.5714285714285714, 15);
  });
});

describe('titleSim', () => {
  test('normalizes before comparing (subtitle and parentheticals dropped)', () => {
    expect(titleSim('Dune', 'Dune: Special Edition')).toBe(1.0);
    expect(titleSim('The Hobbit', 'The Hobbit (Illustrated)')).toBe(1.0);
    expect(titleSim('Mistborn (Mistborn, #1)', 'Mistborn')).toBe(1.0);
  });

  test('null-safe', () => {
    expect(titleSim(null, 'dune')).toBe(0.0);
    expect(titleSim(null, null)).toBe(1.0); // both normalize to "" -> Python's length-0 case
  });

  test('PYTHON QUIRK: sibling subtitles collide because normalizeTitle drops them', () => {
    // "Exodus: The Helium Sea" and "Exodus: The Archimedes Engine" are different
    // books, but _normalize_title truncates at ':' so both become "exodus".
    // recommend.py has always behaved this way (unlike the add-book flow, which
    // Chase fixed with _same_work). Reproduced deliberately -- do NOT "fix" it here.
    expect(titleSim('Exodus: The Helium Sea', 'Exodus: The Archimedes Engine')).toBe(1.0);
    expect(1.0).toBeGreaterThanOrEqual(STRONG_SIM);
  });
});
