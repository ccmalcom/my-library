'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LogOut } from 'lucide-react';
import useSWR from 'swr';
import { authEnabled, getSupabaseClient } from '@/utils/supabase/client';
import { adminMe, ADMIN_ME_KEY } from '@/lib/api';

const links = [
  { href: '/', label: 'Home' },
  { href: '/swipe', label: 'Swipe' },
  { href: '/library', label: 'My Library' },
  { href: '/profile', label: 'My Profile' },
  { href: '/settings', label: 'Settings' },
];

const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-base';

export default function NavBar() {
  const pathname = usePathname();
  const { data: me } = useSWR(ADMIN_ME_KEY, adminMe);

  async function handleSignOut() {
    const supabase = getSupabaseClient();
    if (supabase) await supabase.auth.signOut();
    window.location.assign('/login');
  }

  return (
    <nav className='sticky top-0 z-50 border-b border-border bg-base/90 backdrop-blur-sm'>
      <div className='mx-auto flex max-w-4xl items-center justify-between px-4 py-3'>
        <span className='font-mono text-xs font-semibold uppercase tracking-widest text-muted'>
          MyLibrary
        </span>
        {/* Desktop nav links */}
        <div className='hidden sm:flex gap-1'>
          {links.map(({ href, label }) => {
            const active = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={[
                  'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  focusRing,
                  active
                    ? 'bg-elevated text-text'
                    : 'text-muted hover:bg-elevated hover:text-text',
                ].join(' ')}
              >
                {label}
              </Link>
            );
          })}
          {me?.is_admin && (
            <Link
              href='/admin'
              aria-current={pathname === '/admin' ? 'page' : undefined}
              className={[
                'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                focusRing,
                pathname === '/admin'
                  ? 'bg-elevated text-text'
                  : 'text-muted hover:bg-elevated hover:text-text',
              ].join(' ')}
            >
              Admin
            </Link>
          )}
          {authEnabled && (
            <button
              type='button'
              onClick={handleSignOut}
              className={[
                'rounded-md px-3 py-1.5 text-sm font-medium text-muted transition-colors',
                'hover:bg-elevated hover:text-danger',
                focusRing,
              ].join(' ')}
            >
              Sign out
            </button>
          )}
        </div>
        {/* Mobile sign-out icon */}
        {authEnabled && (
          <button
            type='button'
            onClick={handleSignOut}
            aria-label='Sign out'
            className={[
              'flex sm:hidden items-center justify-center rounded-md p-2 text-muted transition-colors',
              'hover:bg-elevated hover:text-danger',
              focusRing,
            ].join(' ')}
          >
            <LogOut size={18} aria-hidden='true' />
          </button>
        )}
      </div>
    </nav>
  );
}
