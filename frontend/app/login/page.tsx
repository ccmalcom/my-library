'use client';

import { useEffect, useState } from 'react';
import { getSupabaseClient } from '@/utils/supabase/client';
import { inviteCallbackRedirect } from '@/lib/authRedirect';
import { Field, Input, Button } from '@/components/ui';
import BrandLogo from '@/components/BrandLogo';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // A misconfigured Supabase invite/recovery link can land its session tokens in the hash at
  // the app root, which middleware bounces here to /login (fragment preserved). Forward such a
  // hash to /auth/callback — the page that actually consumes it and prompts for a password —
  // so onboarding completes regardless of the Supabase redirect config. See lib/authRedirect.
  useEffect(() => {
    const target = inviteCallbackRedirect(window.location.hash);
    if (target) window.location.replace(target);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const supabase = getSupabaseClient();
    if (!supabase) {
      setError('Auth is not configured (no Supabase env).');
      return;
    }
    setLoading(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    window.location.assign('/');
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-base px-4">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-8 shadow-2xl">
        <BrandLogo
          priority
          sizes="208px"
          className="mx-auto mb-5 h-auto w-52"
        />
        <h1 className="mb-6 text-center font-display text-2xl font-extrabold tracking-tight text-text">
          Welcome back
        </h1>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Field label="Email">
            {(p) => (
              <Input
                {...p}
                type="email"
                required
                autoFocus
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            )}
          </Field>
          <Field label="Password">
            {(p) => (
              <Input
                {...p}
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            )}
          </Field>

          {error && <p className="text-sm text-danger">{error}</p>}

          <Button type="submit" size="lg" loading={loading} className="w-full">
            {loading ? 'Signing in\u2026' : 'Sign in'}
          </Button>
        </form>

        <p className="mt-4 text-center font-mono text-xs text-muted">
          Invite-only. Ask the admin for an account.
        </p>
      </div>
    </div>
  );
}
