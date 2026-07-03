import { parseAuthCallbackHash } from '../authCallback';

describe('parseAuthCallbackHash', () => {
  it('extracts tokens from an invite hash', () => {
    const hash =
      '#access_token=abc.def.ghi&expires_at=1783103561&expires_in=3600' +
      '&refresh_token=qbysjqs6vrah&sb=&token_type=bearer&type=invite';
    expect(parseAuthCallbackHash(hash)).toEqual({
      kind: 'tokens',
      accessToken: 'abc.def.ghi',
      refreshToken: 'qbysjqs6vrah',
    });
  });

  it('extracts tokens from a recovery hash', () => {
    const hash =
      '#access_token=tok123&refresh_token=ref456&expires_in=3600&token_type=bearer&type=recovery';
    expect(parseAuthCallbackHash(hash)).toEqual({
      kind: 'tokens',
      accessToken: 'tok123',
      refreshToken: 'ref456',
    });
  });

  it('reports an error hash (reused/expired link) with the decoded message', () => {
    const hash =
      '#error=access_denied&error_code=otp_expired' +
      '&error_description=Email+link+is+invalid+or+has+expired&sb=';
    expect(parseAuthCallbackHash(hash)).toEqual({
      kind: 'error',
      message: 'Email link is invalid or has expired',
    });
  });

  it('prefers the error over any tokens that are also present', () => {
    const hash = '#access_token=tok&refresh_token=ref&error_description=Something+broke';
    expect(parseAuthCallbackHash(hash)).toEqual({
      kind: 'error',
      message: 'Something broke',
    });
  });

  it('returns none when only an access_token is present (refresh_token required)', () => {
    expect(parseAuthCallbackHash('#access_token=tok&type=invite')).toEqual({ kind: 'none' });
  });

  it('returns none for an empty hash', () => {
    expect(parseAuthCallbackHash('')).toEqual({ kind: 'none' });
    expect(parseAuthCallbackHash('#')).toEqual({ kind: 'none' });
  });

  it('handles a hash with no leading #', () => {
    expect(parseAuthCallbackHash('access_token=tok&refresh_token=ref')).toEqual({
      kind: 'tokens',
      accessToken: 'tok',
      refreshToken: 'ref',
    });
  });
});
