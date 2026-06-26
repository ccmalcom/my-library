'use client';

import { useState } from 'react';
import { getSupabaseClient } from '@/utils/supabase/client';
import { Button } from '@/components/ui';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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

  const inputClass = [
    'w-full rounded-lg border border-border bg-base px-3 py-2 text-sm text-text',
    'placeholder-faint focus:border-accent focus:outline-none',
    'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-base',
  ].join(' ');

  const labelClass = 'mb-1 block font-mono text-xs font-semibold uppercase tracking-widest text-muted';

  return (
    <div className='flex min-h-screen items-center justify-center bg-base px-4'>
      <div className='w-full max-w-sm rounded-2xl border border-border bg-surface p-8 shadow-2xl'>
        <p className='mb-1 text-center font-mono text-xs font-semibold uppercase tracking-widest text-faint'>
          MyLibrary
        </p>
        <h1 className='mb-6 text-center font-display text-2xl font-extrabold tracking-tight text-text'>
          Welcome back
        </h1>

        <form onSubmit={handleSubmit} className='space-y-4'>
          <div>
            <label className={labelClass}>Email</label>
            <input
              type='email'
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputClass}
              placeholder='you@example.com'
            />
          </div>
          <div>
            <label className={labelClass}>Password</label>
            <input
              type='password'
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputClass}
              placeholder={'\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'}
            />
          </div>

          {error && <p className='text-sm text-danger'>{error}</p>}

          <Button
            type='submit'
            size='lg'
            loading={loading}
            className='w-full'
          >
            {loading ? 'Signing in...' : 'Sign in'}
          </Button>
        </form>

        <p className='mt-4 text-center font-mono text-xs text-faint'>
          Invite-only. Ask the admin for an account.
        </p>
      </div>
    </div>
  );
}
