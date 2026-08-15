import { tasteAccent, ARCHETYPE_HUES } from '@/lib/tasteAccent';
import { contrastRatio } from '@/lib/contrast';

const SURFACE = '#1f1b18';
const TEXT = '#f5f0e8';

describe('tasteAccent', () => {
  it('returns the brand accent triple for a null seed', () => {
    expect(tasteAccent(null).vivid).toBe('#ff5c3a');
  });

  it.each(Object.keys(ARCHETYPE_HUES))('%s: ink is readable on its drenched surface', (code) => {
    const a = tasteAccent(code);
    expect(contrastRatio(a.ink, a.surface)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(Object.keys(ARCHETYPE_HUES))(
    '%s: vivid is readable as small text on --surface',
    (code) => {
      expect(contrastRatio(tasteAccent(code).vivid, SURFACE)).toBeGreaterThanOrEqual(4.5);
    }
  );

  it('holds the same guarantees for arbitrary non-archetype seeds', () => {
    for (let i = 0; i < 400; i++) {
      const a = tasteAccent(`subject-${i}`);
      expect(contrastRatio(a.vivid, SURFACE)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(a.ink, a.surface)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('is deterministic for a given seed', () => {
    expect(tasteAccent('RCDM')).toEqual(tasteAccent('RCDM'));
    expect(tasteAccent('gothic-fiction')).toEqual(tasteAccent('gothic-fiction'));
  });

  it('keeps ink constant at the theme text color', () => {
    expect(tasteAccent('IPBH').ink).toBe(TEXT);
  });

  it('gives visibly different hues to different archetypes', () => {
    expect(tasteAccent('IPBH').surface).not.toBe(tasteAccent('RCDM').surface);
  });
});
