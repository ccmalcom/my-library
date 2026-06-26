'use client';

import Link from 'next/link';
import useSWR from 'swr';
import {
  api,
  type Trait,
  type SubjectBreakdown,
  type ProfileStatus,
  PROFILE_STATUS_KEY,
} from '@/lib/api';
import { Badge } from '@/components/ui';
import { tasteAccent } from '@/lib/tasteAccent';

const TRAITS_KEY   = 'profile-traits';
const SUBJECTS_KEY = 'profile-subjects';

// Split a trait claim into [before, after] at a natural break point so the
// second half can be rendered in the per-user accent color.
function splitClaim(claim: string): [string, string] {
  const commaIdx = claim.indexOf(', ');
  const semiIdx  = claim.indexOf('; ');
  const dashIdx  = claim.indexOf(' - ');
  const splitters = [
    { idx: commaIdx, leftLen: 1, rightSkip: 2 },
    { idx: semiIdx,  leftLen: 1, rightSkip: 2 },
    { idx: dashIdx,  leftLen: 0, rightSkip: 3 },
  ].filter(s => s.idx > 0);

  if (splitters.length > 0) {
    const best = splitters.reduce((a, b) => (a.idx < b.idx ? a : b));
    return [claim.slice(0, best.idx + best.leftLen), claim.slice(best.idx + best.rightSkip)];
  }

  // Fall back: split at the last space before the 45% mark
  const mid      = Math.floor(claim.length * 0.45);
  const spaceIdx = claim.lastIndexOf(' ', mid);
  if (spaceIdx > 0) {
    return [claim.slice(0, spaceIdx), claim.slice(spaceIdx + 1)];
  }
  return ['', claim];
}

interface TasteHeroProps {
  compact?: boolean;
}

export function TasteHero({ compact = false }: TasteHeroProps) {
  const { data: profileStatus, isLoading: statusLoading } =
    useSWR<ProfileStatus>(PROFILE_STATUS_KEY, () => api.profileStatus());
  const { data: traits, isLoading: traitsLoading } =
    useSWR<Trait[]>(TRAITS_KEY, () => api.profile());
  const { data: subjects, isLoading: subjectsLoading } =
    useSWR<SubjectBreakdown>(SUBJECTS_KEY, () => api.profileSubjects());

  const isLoading = statusLoading || traitsLoading || subjectsLoading;

  const topSubject = subjects?.overall?.[0]?.subject ?? null;
  const topTrait   = traits?.[0] ?? null;
  const seed       = topSubject ?? topTrait?.claim ?? null;
  const accentHsl  = tasteAccent(seed);

  const noProfile =
    !isLoading &&
    (profileStatus?.last_profiled_at === null ||
      (traits !== undefined && traits.length === 0));

  const padClass = compact ? 'p-5' : 'p-8 sm:p-12';

  // ── Loading skeleton ────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className={['rounded-2xl border border-border bg-surface', padClass].join(' ')}>
        <div className="space-y-4">
          <div className="h-3 w-24 rounded bg-elevated motion-safe:animate-pulse" />
          <div className="h-9 w-3/4 rounded bg-elevated motion-safe:animate-pulse" />
          <div className="h-9 w-1/2 rounded bg-elevated motion-safe:animate-pulse" />
          <div className="mt-4 flex gap-2">
            {[1, 2, 3].map(i => (
              <div
                key={i}
                className="h-6 w-20 rounded-full bg-elevated motion-safe:animate-pulse"
              />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ── No profile CTA ──────────────────────────────────────────────────────────
  if (noProfile) {
    return (
      <div
        className={[
          'rounded-2xl border border-border bg-surface text-center',
          padClass,
        ].join(' ')}
      >
        <p className="font-mono text-xs uppercase tracking-widest text-muted mb-3">
          Taste Profile
        </p>
        <h1
          className={[
            'font-display font-extrabold tracking-tight text-text leading-tight',
            compact ? 'text-3xl' : 'text-4xl sm:text-5xl',
          ].join(' ')}
        >
          MyLibrary doesn't know you yet.
        </h1>
        <p className="mt-4 text-muted text-sm max-w-sm mx-auto">
          Build your taste profile and the app will show you something true about your reading life.
        </p>
        <Link
          href="/profile"
          className={[
            'mt-6 inline-flex items-center gap-2 rounded-lg bg-accent text-sm font-semibold',
            'text-white hover:bg-accent-hover active:scale-95 transition-all',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            'focus-visible:ring-offset-2 focus-visible:ring-offset-base px-6 py-3',
          ].join(' ')}
        >
          Build your taste profile
        </Link>
      </div>
    );
  }

  if (!topTrait) return null;

  const [before, after] = splitClaim(topTrait.claim);
  const chipCount      = compact ? 3 : 5;
  const remainingTraits = (traits ?? []).slice(1, chipCount + 1);

  // ── Has profile ─────────────────────────────────────────────────────────────
  return (
    <div
      style={{ ['--user-accent' as string]: accentHsl }}
      className={['rounded-2xl border border-border bg-surface', padClass].join(' ')}
    >
      <p className="font-mono text-xs uppercase tracking-widest text-muted mb-4">
        Your Taste Profile
      </p>

      <h1
        className={[
          'font-display font-extrabold tracking-tight leading-[1.05]',
          compact ? 'text-3xl' : 'text-4xl sm:text-5xl',
        ].join(' ')}
      >
        {before && <span className="text-text">{before}{' '}</span>}
        <span className="text-user">{after}</span>
      </h1>

      {remainingTraits.length > 0 && (
        <div className="mt-6 flex flex-wrap gap-2">
          {remainingTraits.map(t => {
            const chipLabel = t.claim.length > 60
              ? t.claim.slice(0, 57) + '...'
              : t.claim;
            return (
              <Badge key={t.id} variant="mono">
                {chipLabel}
              </Badge>
            );
          })}
        </div>
      )}
    </div>
  );
}
