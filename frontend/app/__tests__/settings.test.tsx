/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import SettingsPage from '@/app/(main)/settings/page';
import { ToastProvider } from '@/components/ui';

jest.mock('swr', () => ({
  __esModule: true,
  default: () => ({ data: undefined, isLoading: false, error: undefined }),
  mutate: jest.fn(),
  useSWRConfig: () => ({ mutate: jest.fn() }),
}));
jest.mock('@/utils/supabase/client', () => ({
  authEnabled: true,
  getSupabaseClient: () => null,
}));

describe('/settings password change form', () => {
  it('gives all three password fields distinct accessible names', () => {
    render(
      <ToastProvider>
        <SettingsPage />
      </ToastProvider>
    );
    const names = ['Current password', 'New password', 'Confirm new password'];
    const ids = names.map((n) => screen.getAllByLabelText(n)[0]!.id);
    expect(new Set(ids).size).toBe(3);
  });
});
