/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { TasteHero } from '@/components/TasteHero';
import { ToastProvider } from '@/components/ui';

const archetype = {
  code: 'RCDM',
  name: 'The Cerebral Architect',
  tagline: 'You build cathedrals out of ideas.',
  is_stale: false,
  lens: { score: 0.6, rationale: 'r', letter: 'R' },
  engine: { score: -0.4, rationale: 'r', letter: 'C' },
  range: { score: 0.5, rationale: 'r', letter: 'D' },
  resonance: { score: 0.3, rationale: 'r', letter: 'M' },
};

jest.mock('swr', () => ({
  __esModule: true,
  default: (key: string) => {
    if (key === 'archetype') return { data: archetype, isLoading: false };
    // Non-empty: an empty trait list routes TasteHero into its no-profile CTA branch.
    if (key === 'profile-traits')
      return { data: [{ id: 1, claim: 'Prefers dense, structural prose' }], isLoading: false };
    if (key === 'profile-subjects') return { data: { overall: [] }, isLoading: false };
    return { data: { last_profiled_at: '2026-01-01', dirty: false }, isLoading: false };
  },
  useSWRConfig: () => ({ mutate: jest.fn() }),
}));

// TasteHero calls useToast, which throws outside a provider.
function renderHero() {
  return render(
    <ToastProvider>
      <TasteHero />
    </ToastProvider>
  );
}

describe('TasteHero', () => {
  it('renders the archetype panel as a drenched user-colored field', () => {
    const { container } = renderHero();
    const panel = container.firstElementChild as HTMLElement;
    expect(panel.className).toContain('bg-user-surface');
    expect(panel.className).not.toContain('bg-surface');
  });

  it('names the archetype in ink that sits on the drenched panel', () => {
    renderHero();
    expect(screen.getByText('The Cerebral Architect').className).toContain('text-user-ink');
  });
});
