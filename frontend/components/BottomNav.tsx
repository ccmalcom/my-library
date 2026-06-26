'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, Shuffle, BookOpen, User, Settings } from 'lucide-react';

const links = [
  { href: '/',         label: 'Home',     Icon: Home     },
  { href: '/swipe',    label: 'Swipe',    Icon: Shuffle  },
  { href: '/library',  label: 'Library',  Icon: BookOpen },
  { href: '/profile',  label: 'Profile',  Icon: User     },
  { href: '/settings', label: 'Settings', Icon: Settings },
];

const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-base';

export default function BottomNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label='Main navigation'
      className='fixed bottom-0 left-0 right-0 z-50 border-t border-border bg-base/90 backdrop-blur-sm sm:hidden'
    >
      <div className='flex items-stretch pb-4'>
        {links.map(({ href, label, Icon }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={[
                'flex flex-1 flex-col items-center gap-0.5 px-1 py-2 text-center transition-colors',
                focusRing,
                active ? 'text-accent' : 'text-muted hover:text-text',
              ].join(' ')}
            >
              <Icon size={20} aria-hidden='true' />
              <span className='font-mono text-[10px] uppercase tracking-wider'>{label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
