// Single source of truth for application navigation. NavBar (desktop) renders
// every route; BottomNav (mobile) renders the `primary` ones. Previously the two
// components kept separate lists, which is how /discover became unreachable on
// mobile and how "My library" and "Library" ended up naming the same route.
import { BookOpen, Compass, Home, Settings, Shuffle, User } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface NavRoute {
  href: string;
  label: string;
  Icon: LucideIcon;
  /** Appears in the mobile bottom nav. Budget: 5, for thumb reach. */
  primary: boolean;
}

export const NAV_ROUTES: readonly NavRoute[] = [
  { href: '/', label: 'Home', Icon: Home, primary: true },
  { href: '/swipe', label: 'Swipe', Icon: Shuffle, primary: true },
  { href: '/discover', label: 'Discover', Icon: Compass, primary: true },
  { href: '/library', label: 'Library', Icon: BookOpen, primary: true },
  { href: '/profile', label: 'Profile', Icon: User, primary: true },
  { href: '/settings', label: 'Settings', Icon: Settings, primary: false },
] as const;
