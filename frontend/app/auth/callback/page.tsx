'use client';

import { useEffect, useState } from 'react';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { getSupabaseClient } from '@/utils/supabase/client';
import { Button, Spinner } from '@/components/ui';

// Landing spot for Supabase invite (and password-recovery) links. Supabase puts the session
// tokens in the URL *hash* fragment, which never reaches the server — so this must be a plain
// client page, not something middleware can gate or redirect before the JS runs. Once the
// Supabase client consumes the hash and establishes a session, we ask the user to set a
// password (invited accounts start with none) before sending them into the app.
const SESSION_TIMEOUT_MS = 6000;

export default function AuthCallbackPage() {
  const [phase, setPhase] = useState<'loading' | 'set-password' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const supabase = getSupabaseClient();
    if (!supabase) {
      window.location.assign('/login');
      return;
    }

    const hashParams = new URLSearchParams(window.location.hash.slice(1));
    const hashError = hashParams.get('error_description');
    if (hashError) {
      // Defer: setState must not run synchronously in the effect body itself.
      queueMicrotask(() => {
        setErrorMsg(hashError.replace(/\+/g, ' '));
        setPhase('error');
      });
      return;
    }

    let settled = false;
    const { data: sub } = supabase.auth.onAuthStateChange(
      (_event: AuthChangeEvent, session: Session | null) => {
        if (session && !settled) {
          settled = true;
          setPhase('set-password');
        }
      }
    );

    supabase.auth.getSession().then((res: { data: { session: Session | null } }) => {
      const { session } = res.data;
      if (session && !settled) {
        settled = true;
        setPhase('set-password');
      }
    });

    const timeout = setTimeout(() => {
      if (!settled) {
        setErrorMsg('This invite link is invalid or has expired. Ask your admin to resend it.');
        setPhase('error');
      }
    }, SESSION_TIMEOUT_MS);

    return () => {
      sub.subscription.unsubscribe();
      clearTimeout(timeout);
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      setErrorMsg('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setErrorMsg("Passwords don't match.");
      return;
    }
    const supabase = getSupabaseClient();
    if (!supabase) return;
    setSaving(true);
    setErrorMsg(null);
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setErrorMsg(error.message);
      setSaving(false);
      return;
    }
    window.location.assign('/');
  }

  const inputClass = [
    'w-full rounded-lg border border-border bg-base px-3 py-2 text-sm text-text',
    'placeholder-faint focus:border-accent focus:outline-none',
    'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-base',
  ].join(' ');

  const labelClass =
    'mb-1 block font-mono text-xs font-semibold uppercase tracking-widest text-muted';

  return (
    <div className="flex min-h-screen items-center justify-center bg-base px-4">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-8 shadow-2xl">
        <p className="mb-1 text-center font-mono text-xs font-semibold uppercase tracking-widest text-faint">
          MyLibrary
        </p>
        <h1 className="mb-6 text-center font-display text-2xl font-extrabold tracking-tight text-text">
          Welcome
        </h1>

        {phase === 'loading' && (
          <div className="flex justify-center py-8">
            <Spinner size="md" />
          </div>
        )}

        {phase === 'error' && (
          <div className="space-y-4">
            <p className="text-sm text-danger">{errorMsg}</p>
            <Button className="w-full" onClick={() => window.location.assign('/login')}>
              Back to sign in
            </Button>
          </div>
        )}

        {phase === 'set-password' && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <p className="text-sm text-muted">Set a password to finish creating your account.</p>
            <div>
              <label className={labelClass}>Password</label>
              <input
                type="password"
                required
                autoFocus
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setErrorMsg(null);
                }}
                className={inputClass}
                placeholder={'\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'}
              />
            </div>
            <div>
              <label className={labelClass}>Confirm password</label>
              <input
                type="password"
                required
                value={confirm}
                onChange={(e) => {
                  setConfirm(e.target.value);
                  setErrorMsg(null);
                }}
                className={inputClass}
                placeholder={'••••••••'}
              />
            </div>

            {errorMsg && <p className="text-sm text-danger">{errorMsg}</p>}

            <Button type="submit" size="lg" loading={saving} className="w-full">
              {saving ? 'Saving...' : 'Set password & continue'}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
