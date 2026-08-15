/**
 * @jest-environment jsdom
 */
import { NAV_ROUTES } from '@/lib/nav';

describe('navigation route table', () => {
  it('gives every route exactly one label', () => {
    const byHref = new Map<string, string>();
    for (const r of NAV_ROUTES) {
      expect(byHref.has(r.href)).toBe(false);
      byHref.set(r.href, r.label);
    }
  });

  it('includes Discover', () => {
    expect(NAV_ROUTES.some((r) => r.href === '/discover')).toBe(true);
  });

  it('marks Discover as reachable from the mobile bottom nav', () => {
    expect(NAV_ROUTES.find((r) => r.href === '/discover')!.primary).toBe(true);
  });

  it('keeps the bottom nav within the five-item thumb budget', () => {
    expect(NAV_ROUTES.filter((r) => r.primary)).toHaveLength(5);
  });

  it('gives every route an icon', () => {
    for (const r of NAV_ROUTES) expect(typeof r.Icon).not.toBe('undefined');
  });
});
