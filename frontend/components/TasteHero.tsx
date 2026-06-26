'use client';

import { useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import {
  api,
  type Trait,
  type SubjectBreakdown,
  type ProfileStatus,
  type ArchetypeOut,
  PROFILE_STATUS_KEY,
  ARCHETYPE_KEY,
} from '@/lib/api';
import { Badge, Button } from '@/components/ui';
import { useToast } from '@/components/ui';
import { tasteAccent } from '@/lib/tasteAccent';
import { ArchetypeShareModal } from '@/components/ArchetypeShareModal';
import Link from 'next/link';

const TRAITS_KEY   = 'profile-traits';
const SUBJECTS_KEY = 'profile-subjects';

const AXIS_META = [
  { key: 'lens'      as const, left: 'Immersive',    right: 'Reflective'      },
  { key: 'engine'    as const, left: 'Plot-first',    right: 'Character-first' },
  { key: 'range'     as const, left: 'Broad',         right: 'Deep'            },
  { key: 'resonance' as const, left: 'Heart',         right: 'Mind'            },
];

interface TasteHeroProps {
  compact?: boolean;
}

export function TasteHero({ compact = false }: TasteHeroProps) {
  const { mutate } = useSWRConfig();
  const toast = useToast();
  const [deriving, setDeriving]           = useState(false);
  const [rederiving, setRederiving]       = useState(false);
  const [expandedAxis, setExpandedAxis]   = useState<string | null>(null);
  const [expandedChip, setExpandedChip]   = useState<number | null>(null);
  const [shareOpen, setShareOpen]         = useState(false);

  const { data: profileStatus, isLoading: statusLoading } =
    useSWR<ProfileStatus>(PROFILE_STATUS_KEY, () => api.profileStatus());
  const { data: traits, isLoading: traitsLoading } =
    useSWR<Trait[]>(TRAITS_KEY, () => api.profile());
  const { data: subjects, isLoading: subjectsLoading } =
    useSWR<SubjectBreakdown>(SUBJECTS_KEY, () => api.profileSubjects());
  const { data: archetype, isLoading: archetypeLoading } =
    useSWR<ArchetypeOut | null>(ARCHETYPE_KEY, () => api.getArchetype());

  const isLoading = statusLoading || traitsLoading || subjectsLoading || archetypeLoading;

  const topSubject = subjects?.overall?.[0]?.subject ?? null;
  const topTrait   = traits?.[0] ?? null;
  const seed       = archetype ? archetype.code : (topSubject ?? topTrait?.claim ?? null);
  const accentHsl  = tasteAccent(seed);

  const noProfile =
    !isLoading &&
    (profileStatus?.last_profiled_at === null ||
      (traits !== undefined && traits.length === 0));

  const padClass = compact ? 'p-5' : 'p-8 sm:p-12';

  // Pre-compute axis bar geometry (plain vars, not IIFEs).
  const axisItems = archetype
    ? AXIS_META.map((a) => {
        const axisData = archetype[a.key];
        const score    = axisData.score;
        const pct      = Math.abs(score) * 50;
        const barLeft  = score < 0 ? `${50 - pct}%` : '50%';
        const barWidth = `${pct}%`;
        const leftWins = score < 0;
        return { ...a, score, barLeft, barWidth, rationale: axisData.rationale, leftWins, letter: axisData.letter };
      })
    : null;

  const chipCount       = compact ? 3 : 5;
  const chipTraits      = (traits ?? []).slice(0, chipCount);

  const headingClass = [
    'font-display font-extrabold tracking-tight leading-[1.05]',
    compact ? 'text-3xl' : 'text-4xl sm:text-5xl',
  ].join(' ');

  async function handleDiscover() {
    setDeriving(true);
    try {
      const result = await api.deriveArchetype();
      await mutate(ARCHETYPE_KEY, result, { revalidate: false });
    } catch {
      toast.error('Failed to derive archetype');
    } finally {
      setDeriving(false);
    }
  }

  async function handleRederive() {
    setRederiving(true);
    try {
      const result = await api.deriveArchetype();
      await mutate(ARCHETYPE_KEY, result, { revalidate: false });
    } catch {
      toast.error('Could not re-derive archetype');
    } finally {
      setRederiving(false);
    }
  }

  // ── Loading skeleton ────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className={['rounded-2xl border border-border bg-surface', padClass].join(' ')}>
        <div className='space-y-4'>
          <div className='h-3 w-24 rounded bg-elevated motion-safe:animate-pulse' />
          <div className='h-9 w-3/4 rounded bg-elevated motion-safe:animate-pulse' />
          <div className='h-9 w-1/2 rounded bg-elevated motion-safe:animate-pulse' />
          <div className='mt-4 flex gap-2'>
            {[1, 2, 3].map(i => (
              <div
                key={i}
                className='h-6 w-20 rounded-full bg-elevated motion-safe:animate-pulse'
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
        <p className='font-mono text-xs uppercase tracking-widest text-muted mb-3'>
          Reader Type
        </p>
        <h1
          className={[
            'font-display font-extrabold tracking-tight text-text leading-tight',
            compact ? 'text-3xl' : 'text-4xl sm:text-5xl',
          ].join(' ')}
        >
          MyLibrary doesn&apos;t know you yet.
        </h1>
        <p className='mt-4 text-muted text-sm max-w-sm mx-auto'>
          Build your taste profile and discover your reader type.
        </p>
        <Link
          href='/profile'
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

  // ── Has profile, no archetype yet ───────────────────────────────────────────
  if (!archetype) {
    return (
      <div
        style={{ ['--user-accent' as string]: accentHsl }}
        className={[
          'rounded-2xl border border-border bg-surface text-center',
          padClass,
        ].join(' ')}
      >
        <p className='font-mono text-xs uppercase tracking-widest text-muted mb-3'>
          Reader Type
        </p>
        <h1
          className={[
            'font-display font-extrabold tracking-tight text-text leading-tight',
            compact ? 'text-3xl' : 'text-4xl sm:text-5xl',
          ].join(' ')}
        >
          What kind of reader are you?
        </h1>
        <p className='mt-4 text-muted text-sm max-w-sm mx-auto'>
          We&apos;ll analyze your taste profile to place you on four reading axes and find your archetype.
        </p>
        <Button
          variant='primary'
          loading={deriving}
          onClick={handleDiscover}
          className='mt-6'
        >
          Discover your reader type
        </Button>
      </div>
    );
  }

  // ── Archetype display ───────────────────────────────────────────────────────
  return (
    <div
      style={{ ['--user-accent' as string]: accentHsl }}
      className={['rounded-2xl border border-border bg-surface', padClass].join(' ')}
    >
      <p className='font-mono text-xs uppercase tracking-widest text-muted mb-3'>
        Reader Type
      </p>
      <div className='flex items-center gap-3 mb-1'>
        <Badge variant='mono' className='text-base px-3 py-1'>
          {archetype.code}
        </Badge>
      </div>
      <p className='font-mono text-xs text-faint mb-3'>
        {AXIS_META.map((a, i) => {
          const axisData = archetype[a.key];
          const label = axisData.score < 0 ? a.left : a.right;
          return (
            <span key={a.key}>
              <span className='text-user'>{axisData.letter}</span>
              {' '}{label}
              {i < 3 ? ' · ' : ''}
            </span>
          );
        })}
      </p>
      <h1 className={headingClass}>
        <span className='text-user'>{archetype.name}</span>
      </h1>
      <p className='text-sm text-muted italic mt-2'>{archetype.tagline}</p>

      {/* Trait chips as supporting detail -- click to expand truncated claims */}
      {chipTraits.length > 0 && (
        <div className='mt-6 flex flex-wrap gap-2'>
          {chipTraits.map(t => {
            const truncated = t.claim.length > 60;
            const isExpanded = expandedChip === t.id;
            const chipLabel = truncated && !isExpanded ? t.claim.slice(0, 57) + '...' : t.claim;
            return (
              <button
                key={t.id}
                type='button'
                onClick={() => truncated && setExpandedChip(isExpanded ? null : t.id)}
                className={truncated ? 'cursor-pointer' : 'cursor-default'}
              >
                <Badge variant='mono'>
                  {chipLabel}
                </Badge>
              </button>
            );
          })}
        </div>
      )}

      {/* Axis bars: axis-name | bar | letter + winning-label [why] */}
      {axisItems && (
        <div className='mt-6 space-y-2'>
          {axisItems.map((a) => {
            const isExpanded = expandedAxis === a.key;
            const winningLabel = a.leftWins ? a.left : a.right;
            return (
              <div key={a.key}>
                <div className='flex items-center gap-3'>
                  <span className='w-20 shrink-0 text-xs text-faint capitalize'>{a.key}</span>
                  <div className='relative flex-1 h-2 rounded-full bg-elevated overflow-hidden'>
                    <div
                      className='absolute h-2 rounded-full bg-user'
                      style={{ left: a.barLeft, width: a.barWidth }}
                    />
                  </div>
                  <div className='w-32 shrink-0 flex items-center gap-1.5'>
                    <span className='font-mono text-xs font-semibold text-user'>{a.letter}</span>
                    <span className='text-xs text-text flex-1 min-w-0'>{winningLabel}</span>
                    {a.rationale && (
                      <button
                        type='button'
                        className='shrink-0 text-xs text-faint hover:text-muted transition-colors'
                        onClick={() => setExpandedAxis(isExpanded ? null : a.key)}
                        aria-expanded={isExpanded}
                      >
                        {isExpanded ? 'hide' : 'why'}
                      </button>
                    )}
                  </div>
                </div>
                {isExpanded && a.rationale && (
                  <p className='mt-1 pl-24 text-xs text-muted'>{a.rationale}</p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Footer: stale nudge + actions */}
      <div className='flex justify-between items-center mt-5'>
        <div>
          {archetype.is_stale && (
            <span className='text-xs text-warning'>
              Profile updated -- archetype may be outdated.
            </span>
          )}
        </div>
        <div className='flex items-center gap-2'>
          <Button variant='ghost' size='sm' loading={rederiving} onClick={handleRederive}>
            Re-derive
          </Button>
          <Button variant='secondary' size='sm' onClick={() => setShareOpen(true)}>
            Share
          </Button>
        </div>
      </div>

      {/* Share modal */}
      {shareOpen && (
        <ArchetypeShareModal archetype={archetype} onClose={() => setShareOpen(false)} />
      )}
    </div>
  );
}
