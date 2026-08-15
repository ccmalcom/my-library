import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contrastRatio } from '@/lib/contrast';

const css = readFileSync(join(__dirname, '../../app/globals.css'), 'utf8');

function token(name: string): string {
  const m = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!m) throw new Error(`token --${name} not found or not a 6-digit hex`);
  return m[1]!.toLowerCase();
}

const BG = () => token('bg');
const SURFACE = () => token('surface');
const ELEVATED = () => token('elevated');

describe('globals.css token contrast', () => {
  it.each(['text', 'muted', 'faint'])(
    '--%s clears AA body (4.5:1) on bg, surface, and elevated',
    (name) => {
      for (const bg of [BG(), SURFACE(), ELEVATED()]) {
        expect(contrastRatio(token(name), bg)).toBeGreaterThanOrEqual(4.5);
      }
    }
  );

  it.each(['accent', 'success', 'danger', 'warning'])(
    '--%s clears AA body on bg and surface when used as text',
    (name) => {
      for (const bg of [BG(), SURFACE()]) {
        expect(contrastRatio(token(name), bg)).toBeGreaterThanOrEqual(4.5);
      }
    }
  );

  it('--bg is a legible ink on the accent and danger fills', () => {
    for (const fill of ['accent', 'accent-hover', 'danger', 'success', 'warning']) {
      expect(contrastRatio(BG(), token(fill))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('--border-strong clears 3:1 for interactive control boundaries (WCAG 1.4.11)', () => {
    for (const bg of [SURFACE(), ELEVATED()]) {
      expect(contrastRatio(token('border-strong'), bg)).toBeGreaterThanOrEqual(3);
    }
  });
});
