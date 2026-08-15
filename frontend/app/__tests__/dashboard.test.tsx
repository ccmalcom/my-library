/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import HomePage from '@/app/(main)/page';
import { ToastProvider } from '@/components/ui';

jest.mock('@/components/TasteHero', () => ({
  TasteHero: () => <div data-testid="taste-hero" />,
}));
jest.mock('swr', () => ({
  __esModule: true,
  default: () => ({ data: undefined, isLoading: false, error: undefined }),
  mutate: jest.fn(),
}));
jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));

// HomePage calls useToast, which throws outside a provider.
function renderDashboard() {
  return render(
    <ToastProvider>
      <HomePage />
    </ToastProvider>
  );
}

describe('dashboard', () => {
  it('renders the taste hero', () => {
    renderDashboard();
    expect(screen.getByTestId('taste-hero')).toBeInTheDocument();
  });

  it('places the hero above the quiet utility tier', () => {
    const { container } = renderDashboard();
    const html = container.innerHTML;
    expect(html.indexOf('taste-hero')).toBeGreaterThan(-1);
    expect(html.indexOf('taste-hero')).toBeLessThan(html.indexOf('Ready for new picks?'));
  });
});
