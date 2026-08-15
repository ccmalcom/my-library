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
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui';
import { useToast } from '@/components/ui';
import { Modal } from '@/components/ui/Modal';
import { tasteAccent } from '@/lib/tasteAccent';
import { ArchetypeShareModal } from '@/components/ArchetypeShareModal';
import Link from 'next/link';

// ── Archetype explainer modal ─────────────────────────────────────────────────

function ArchetypeExplainerModal({ onClose }: { onClose: () => void }) {
  const titleId = 'archetype-explainer-title';
  return (
    <Modal labelId={titleId} onClose={onClose} className="w-full max-w-lg">
      <div className="rounded-2xl border border-border bg-surface p-6 space-y-5">
        <div>
          <h2 id={titleId} className="font-display text-xl font-bold text-text">
            Your reader type
          </h2>
          <p className="mt-1 text-sm text-muted">
            A personality system for readers, based on four reading axes.
          </p>
        </div>

        <div className="space-y-4 text-sm">
          <p className="text-muted">
            We scored your taste profile across four dimensions to figure out what kind of reader
            you are. Each axis produces one letter, and together they make your four-letter reader
            code.
          </p>

          <div className="space-y-3">
            {[
              {
                letters: 'I / R',
                name: 'Lens',
                desc: 'Do you read to be transported into another world (Immersive), or to engage with ideas and craft (Reflective)?',
              },
              {
                letters: 'P / C',
                name: 'Engine',
                desc: "Are you driven by what happens next (Plot-first), or by who it's happening to (Character-first)?",
              },
              {
                letters: 'B / D',
                name: 'Range',
                desc: 'Do you roam across genres and authors (Broad), or go deep into a few favourites (Deep)?',
              },
              {
                letters: 'H / M',
                name: 'Resonance',
                desc: 'Does a book hit hardest when it makes you feel something (Heart), or when it gives you something to think about (Mind)?',
              },
            ].map(({ letters, name, desc }) => (
              <div key={name} className="flex gap-3">
                <span className="font-mono text-xs font-bold text-user w-10 shrink-0 pt-0.5">
                  {letters}
                </span>
                <div>
                  <span className="font-semibold text-text">{name}: </span>
                  <span className="text-muted">{desc}</span>
                </div>
              </div>
            ))}
          </div>

          <p className="text-muted">
            The four letters combine into one of 16 named archetypes, from The Wandering Escapist to
            The Cerebral Architect. Your code is derived from your actual rated books and taste
            traits, so it should feel like you.
          </p>

          <p className="text-faint text-xs">
            Doesn&apos;t feel like you? Correct your traits and re-derive. The code follows the
            evidence.
          </p>
        </div>

        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Got it
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const TRAITS_KEY = 'profile-traits';
const SUBJECTS_KEY = 'profile-subjects';

const AXIS_META = [
  { key: 'lens' as const, left: 'Immersive', right: 'Reflective' },
  { key: 'engine' as const, left: 'Plot-first', right: 'Character-first' },
  { key: 'range' as const, left: 'Broad', right: 'Deep' },
  { key: 'resonance' as const, left: 'Heart', right: 'Mind' },
];

interface TasteHeroProps {
  compact?: boolean;
}

export function TasteHero({ compact = false }: TasteHeroProps) {
  const { mutate } = useSWRConfig();
  const toast = useToast();
  const [deriving, setDeriving] = useState(false);
  const [rederiving, setRederiving] = useState(false);
  const [expandedAxis, setExpandedAxis] = useState<string | null>(null);
  const [expandedChip, setExpandedChip] = useState<number | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [explainerOpen, setExplainerOpen] = useState(false);

  const { data: profileStatus, isLoading: statusLoading } = useSWR<ProfileStatus>(
    PROFILE_STATUS_KEY,
    () => api.profileStatus()
  );
  const { data: traits, isLoading: traitsLoading } = useSWR<Trait[]>(TRAITS_KEY, () =>
    api.profile()
  );
  const { data: subjects, isLoading: subjectsLoading } = useSWR<SubjectBreakdown>(
    SUBJECTS_KEY,
    () => api.profileSubjects()
  );
  const { data: archetype, isLoading: archetypeLoading } = useSWR<ArchetypeOut | null>(
    ARCHETYPE_KEY,
    () => api.getArchetype()
  );

  const isLoading = statusLoading || traitsLoading || subjectsLoading || archetypeLoading;

  const topSubject = subjects?.overall?.[0]?.subject ?? null;
  const topTrait = traits?.[0] ?? null;
  const seed = archetype ? archetype.code : (topSubject ?? topTrait?.claim ?? null);
  const accent = tasteAccent(seed);
  const accentVars = {
    ['--user-accent' as string]: accent.vivid,
    ['--user-surface' as string]: accent.surface,
    ['--user-ink-rgb' as string]: '245 240 232',
  };

  const noProfile =
    !isLoading &&
    (profileStatus?.last_profiled_at === null || (traits !== undefined && traits.length === 0));

  const padClass = compact ? 'p-5' : 'p-8 sm:p-12';

  // Pre-compute axis bar geometry (plain vars, not IIFEs).
  const axisItems = archetype
    ? AXIS_META.map((a) => {
        const axisData = archetype[a.key];
        const score = axisData.score;
        const pct = Math.abs(score) * 50;
        const barLeft = score < 0 ? `${50 - pct}%` : '50%';
        const barWidth = `${pct}%`;
        const leftWins = score < 0;
        return {
          ...a,
          score,
          barLeft,
          barWidth,
          rationale: axisData.rationale,
          leftWins,
          letter: axisData.letter,
        };
      })
    : null;

  const chipCount = compact ? 3 : 5;
  const chipTraits = (traits ?? []).slice(0, chipCount);

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
      toast.error("Couldn't derive your archetype. Try again in a moment.");
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
      toast.error("Re-derive didn't take. Try again.");
    } finally {
      setRederiving(false);
    }
  }

  // ── Loading skeleton ────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className={['rounded-2xl border border-border bg-surface', padClass].join(' ')}>
        <div className="space-y-4">
          <div className="h-3 w-24 rounded bg-elevated motion-safe:animate-pulse" />
          <div className="h-9 w-3/4 rounded bg-elevated motion-safe:animate-pulse" />
          <div className="h-9 w-1/2 rounded bg-elevated motion-safe:animate-pulse" />
          <div className="mt-4 flex gap-2">
            {[1, 2, 3].map((i) => (
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
        className={['rounded-2xl border border-border bg-surface text-center', padClass].join(' ')}
      >
        {explainerOpen && <ArchetypeExplainerModal onClose={() => setExplainerOpen(false)} />}
        <div className="flex items-center gap-3 mb-3">
          <p className="font-mono text-xs uppercase tracking-widest text-muted">Reader type</p>
          <button
            type="button"
            onClick={() => setExplainerOpen(true)}
            className="font-mono text-xs text-faint hover:text-muted transition-colors"
          >
            What is this?
          </button>
        </div>
        <h1
          className={[
            'font-display font-extrabold tracking-tight text-text leading-tight',
            compact ? 'text-3xl' : 'text-4xl sm:text-5xl',
          ].join(' ')}
        >
          ShelfSprite doesn&apos;t know you yet.
        </h1>
        <p className="mt-4 text-muted text-sm max-w-sm mx-auto">
          Build your taste profile and find out what your shelf says about you.
        </p>
        <Link
          href="/profile"
          className={[
            'mt-6 inline-flex items-center gap-2 rounded-lg bg-accent text-sm font-semibold',
            'text-base hover:bg-accent-hover active:scale-95 transition-all',
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
        style={accentVars}
        className={['rounded-2xl border border-border bg-surface text-center', padClass].join(' ')}
      >
        {explainerOpen && <ArchetypeExplainerModal onClose={() => setExplainerOpen(false)} />}
        <div className="flex items-center gap-3 mb-3">
          <p className="font-mono text-xs uppercase tracking-widest text-muted">Reader type</p>
          <button
            type="button"
            onClick={() => setExplainerOpen(true)}
            className="font-mono text-xs text-faint hover:text-muted transition-colors"
          >
            What is this?
          </button>
        </div>
        <h1
          className={[
            'font-display font-extrabold tracking-tight text-text leading-tight',
            compact ? 'text-3xl' : 'text-4xl sm:text-5xl',
          ].join(' ')}
        >
          What kind of reader are you?
        </h1>
        <p className="mt-4 text-muted text-sm max-w-sm mx-auto">
          Four axes, sixteen archetypes. Your rated books already know the answer.
        </p>
        <Button variant="primary" loading={deriving} onClick={handleDiscover} className="mt-6">
          Discover your reader type
        </Button>
      </div>
    );
  }

  // ── Archetype display ───────────────────────────────────────────────────────
  // The drenched panel: the field itself carries the user's archetype color, so
  // nothing inside it may use the neutral text tokens -- --muted lands at
  // 2.67-3.08:1 on these surfaces. Everything here is panel ink at an opacity.
  return (
    <div
      style={accentVars}
      className={['rounded-2xl bg-user-surface text-user-ink', padClass].join(' ')}
    >
      <div className="flex items-center gap-3 mb-3">
        <p className="font-mono text-xs uppercase tracking-widest text-user-ink/85">Reader type</p>
        <button
          type="button"
          onClick={() => setExplainerOpen(true)}
          className="font-mono text-xs text-user-ink/85 hover:text-user-ink transition-colors"
        >
          What is this?
        </button>
      </div>
      <div className="flex items-center gap-3 mb-1">
        <span className="inline-flex items-center rounded-full bg-user-ink/10 px-3 py-1 font-mono text-[1rem] font-medium text-user-ink">
          {archetype.code}
        </span>
      </div>
      <p className="font-mono text-xs text-user-ink/85 mb-3">
        {AXIS_META.map((a, i) => {
          const axisData = archetype[a.key];
          const label = axisData.score < 0 ? a.left : a.right;
          return (
            <span key={a.key}>
              <span className="text-user-ink">{axisData.letter}</span> {label}
              {i < 3 ? ' · ' : ''}
            </span>
          );
        })}
      </p>
      <h1 className={[headingClass, 'text-user-ink'].join(' ')}>{archetype.name}</h1>
      <p className="text-sm text-user-ink/85 italic mt-2">{archetype.tagline}</p>

      {/* Trait chips as supporting detail -- click to expand truncated claims */}
      {chipTraits.length > 0 && (
        <div className="mt-6 flex flex-wrap gap-2">
          {chipTraits.map((t) => {
            const truncated = t.claim.length > 60;
            const isExpanded = expandedChip === t.id;
            const chipLabel = truncated && !isExpanded ? t.claim.slice(0, 57) + '\u2026' : t.claim;
            return (
              <button
                key={t.id}
                type="button"
                disabled={!truncated}
                onClick={() => truncated && setExpandedChip(isExpanded ? null : t.id)}
                className={truncated ? 'cursor-pointer' : 'cursor-default'}
              >
                <span className="inline-flex items-center rounded-full bg-user-ink/10 px-2.5 py-0.5 font-mono text-xs font-medium text-user-ink">
                  {chipLabel}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Axis bars: axis-name | bar | letter + winning-label [why] */}
      {axisItems && (
        <div className="mt-6 space-y-2">
          {axisItems.map((a) => {
            const isExpanded = expandedAxis === a.key;
            const winningLabel = a.leftWins ? a.left : a.right;
            return (
              <div key={a.key}>
                <div className="flex items-center gap-3">
                  <span className="w-20 shrink-0 text-xs text-user-ink/85 capitalize">{a.key}</span>
                  <div className="relative flex-1 h-2 rounded-full bg-user-ink/20 overflow-hidden">
                    <div
                      className="absolute h-2 rounded-full bg-user-ink"
                      style={{ left: a.barLeft, width: a.barWidth }}
                    />
                  </div>
                  <div className="w-32 shrink-0 flex items-center gap-1.5">
                    <span className="font-mono text-xs font-semibold text-user-ink">
                      {a.letter}
                    </span>
                    <span className="text-xs text-user-ink flex-1 min-w-0">{winningLabel}</span>
                    {a.rationale && (
                      <button
                        type="button"
                        className="shrink-0 text-xs text-user-ink/85 hover:text-user-ink transition-colors"
                        onClick={() => setExpandedAxis(isExpanded ? null : a.key)}
                        aria-expanded={isExpanded}
                      >
                        {isExpanded ? 'hide' : 'why'}
                      </button>
                    )}
                  </div>
                </div>
                {isExpanded && a.rationale && (
                  <p className="mt-1 pl-24 text-xs text-user-ink/85">{a.rationale}</p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Footer: stale nudge + actions */}
      <div className="flex justify-between items-center mt-5">
        <div>
          {archetype.is_stale && (
            // --warning cannot carry the signal on a drenched panel, so the icon does.
            <span className="flex items-center gap-1.5 text-xs text-user-ink">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              Profile changed, so this archetype may be stale. Re-derive when ready.
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* ghost/secondary resolve to --muted, which fails AA on every panel hue. */}
          <Button
            variant="ghost"
            size="sm"
            loading={rederiving}
            onClick={handleRederive}
            className="text-user-ink/85 hover:text-user-ink hover:bg-user-ink/10"
          >
            Re-derive
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShareOpen(true)}
            className="border-user-ink/60 bg-user-ink/5 text-user-ink hover:bg-user-ink/10"
          >
            Share
          </Button>
        </div>
      </div>

      {shareOpen && (
        <ArchetypeShareModal archetype={archetype} onClose={() => setShareOpen(false)} />
      )}
      {explainerOpen && <ArchetypeExplainerModal onClose={() => setExplainerOpen(false)} />}
    </div>
  );
}
