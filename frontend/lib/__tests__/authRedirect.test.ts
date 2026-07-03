import { inviteCallbackRedirect } from '../authRedirect';

describe('inviteCallbackRedirect', () => {
  it('forwards an invite hash to /auth/callback, preserving the fragment', () => {
    const hash = '#access_token=abc&refresh_token=xyz&type=invite&expires_in=3600';
    expect(inviteCallbackRedirect(hash)).toBe(
      '/auth/callback#access_token=abc&refresh_token=xyz&type=invite&expires_in=3600'
    );
  });

  it('forwards a password-recovery hash', () => {
    expect(inviteCallbackRedirect('#type=recovery&access_token=abc')).toBe(
      '/auth/callback#type=recovery&access_token=abc'
    );
  });

  it('forwards on an access_token even without a type', () => {
    expect(inviteCallbackRedirect('#access_token=abc')).toBe('/auth/callback#access_token=abc');
  });

  it('forwards an auth error hash so the callback page can render it', () => {
    const hash = '#error=access_denied&error_description=Email+link+is+invalid+or+has+expired';
    expect(inviteCallbackRedirect(hash)).toBe(`/auth/callback${hash}`);
  });

  it('accepts a hash without the leading #', () => {
    expect(inviteCallbackRedirect('type=invite&access_token=abc')).toBe(
      '/auth/callback#type=invite&access_token=abc'
    );
  });

  it('returns null for an empty hash', () => {
    expect(inviteCallbackRedirect('')).toBeNull();
    expect(inviteCallbackRedirect('#')).toBeNull();
  });

  it('returns null for a non-auth hash (e.g. an in-page anchor)', () => {
    expect(inviteCallbackRedirect('#section-2')).toBeNull();
    expect(inviteCallbackRedirect('#foo=bar')).toBeNull();
  });
});
