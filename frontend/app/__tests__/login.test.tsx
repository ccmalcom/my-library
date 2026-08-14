/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import LoginPage from '@/app/login/page';

jest.mock('@/utils/supabase/client', () => ({
  authEnabled: true,
  getSupabaseClient: () => null,
}));
jest.mock('@/lib/authRedirect', () => ({ inviteCallbackRedirect: () => null }));

describe('/login', () => {
  it('exposes both credentials fields by accessible name', () => {
    render(<LoginPage />);
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('gives the password field a distinct id from the email field', () => {
    render(<LoginPage />);
    expect(screen.getByLabelText('Email').id).not.toBe(screen.getByLabelText('Password').id);
  });
});
