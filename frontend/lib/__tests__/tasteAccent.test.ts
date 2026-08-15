import { tasteAccent, ARCHETYPE_HUES } from '@/lib/tasteAccent';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contrastRatio, hexToRgb } from '@/lib/contrast';

const SURFACE = '#1f1b18';
const TEXT = '#f5f0e8';

const CODES = Object.keys(ARCHETYPE_HUES);

/**
 * A `text-user-ink/70` class does NOT render --text: it renders --text composited
 * over the panel at 70% alpha, which is a different, lower-contrast color. Every
 * ink opacity TasteHero uses is asserted here against the composited value, because
 * eyeballing the class name is exactly how the old --faint defect survived.
 */
function inkOver(alpha: number, panelHex: string): string {
  const ink = hexToRgb(TEXT);
  const panel = hexToRgb(panelHex);
  return (
    '#' +
    ink
      .map((c, i) =>
        Math.round((alpha * c + (1 - alpha) * panel[i]!) * 255)
          .toString(16)
          .padStart(2, '0')
      )
      .join('')
  );
}

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

  it.each(Object.keys(ARCHETYPE_HUES))(
    '%s: --muted is NOT usable on the drenched panel (guards against ghost buttons)',
    (code) => {
      // Documents why TasteHero overrides ghost/secondary ink inside the panel.
      expect(contrastRatio('#a89f92', tasteAccent(code).surface)).toBeLessThan(4.5);
    }
  );

  it('gives visibly different hues to different archetypes', () => {
    expect(tasteAccent('IPBH').surface).not.toBe(tasteAccent('RCDM').surface);
  });
});

describe('drenched-panel ink tiers (TasteHero)', () => {
  // The panel runs a two-tier ink system: full ink for primary text, /85 for
  // secondary. /60, /70 and /80 were tried and composite to 3.23, 3.83 and 4.53 --
  // the first two fail AA body outright and the third has no headroom.
  // Read the real component, so lowering a tier in TasteHero.tsx fails here rather
  // than shipping. Same enforcement pattern as tokens.test.ts reading globals.css.
  const hero = readFileSync(join(__dirname, '../../components/TasteHero.tsx'), 'utf8');
  const textAlphas = Array.from(new Set(hero.match(/text-user-ink\/\d+/g) ?? []));

  it('actually finds ink opacity classes in TasteHero', () => {
    expect(textAlphas.length).toBeGreaterThan(0);
  });

  it.each(textAlphas)('%s clears AA body on every archetype panel', (cls) => {
    const alpha = Number(cls.split('/')[1]) / 100;
    for (const code of CODES) {
      const panel = tasteAccent(code).surface;
      expect(contrastRatio(inkOver(alpha, panel), panel)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(CODES)('%s: full ink on the /10 chip and button fills clears AA body', (code) => {
    const panel = tasteAccent(code).surface;
    // Chips, the archetype code pill, and the Share button all sit on ink/10.
    // At ink/15 this lands at 4.49 -- under the floor, hence /10.
    expect(contrastRatio(inkOver(1, panel), inkOver(0.1, panel))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(CODES)('%s: the Share border clears 3:1 as a control boundary (1.4.11)', (code) => {
    const panel = tasteAccent(code).surface;
    // border-user-ink/60. At /30 this was 1.82 -- invisible as a control edge.
    expect(contrastRatio(inkOver(0.6, panel), panel)).toBeGreaterThanOrEqual(3);
  });

  it.each(CODES)('%s: the axis bar fill reads against its track (1.4.11)', (code) => {
    const panel = tasteAccent(code).surface;
    // Full-ink fill on a bg-user-ink/20 track.
    expect(contrastRatio(inkOver(1, panel), inkOver(0.2, panel))).toBeGreaterThanOrEqual(3);
  });
});
