'use client';

import { useState, useMemo } from 'react';
import useSWR from 'swr';
import { motion, useReducedMotion } from 'framer-motion';
import {
  api,
  ARCHETYPE_KEY,
  DIRECTIVE_KEY,
  getDirective,
  type Stats,
  type Trait,
  type ArchetypeOut,
  type ProfileHighlights,
  type Book,
  type Directive,
} from '@/lib/api';
import { buildBeats, type Beat } from '@/lib/revealBeats';
import { tasteAccent } from '@/lib/tasteAccent';
import { RevealFrame, RevealButton } from './revealFrame';
import { RewardTraitBeat, AversionsBeat } from './TraitBeats';

// Fade-in wrapper honoring reduced motion.
function Stagger({ children, reduced }: { children: React.ReactNode; reduced: boolean }) {
  if (reduced) return <>{children}</>;
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
    >
      {children}
    </motion.div>
  );
}

export default function RevealSequence({
  onClose,
  onFinish,
}: {
  onClose: () => void;
  onFinish: () => void;
}) {
  const reduced = useReducedMotion() ?? false;
  const [index, setIndex] = useState(0);
  const [verdicts, setVerdicts] = useState<Record<number, 'confirmed' | 'edited' | 'rejected'>>({});
  const recordVerdict = (id: number, v: 'confirmed' | 'edited' | 'rejected') =>
    setVerdicts((prev) => ({ ...prev, [id]: v }));

  // Fetch every input in parallel. reveal-lines POST also generates any missing lines.
  const { data: stats } = useSWR<Stats>('reveal-stats', () => api.stats());
  const { data: traits, error: traitsErr } = useSWR<Trait[]>('reveal-traits', () =>
    api.generateRevealLines()
  );
  // Older accounts (pre-dating the archetype feature) never derived one, and a
  // fresh account never will have — derive on demand so the reveal doesn't stall.
  const { data: archetype, error: archetypeErr } = useSWR<ArchetypeOut>(
    ARCHETYPE_KEY,
    async () => (await api.getArchetype()) ?? api.deriveArchetype()
  );
  const { data: highlights } = useSWR<ProfileHighlights>('reveal-highlights', () =>
    api.profileHighlights()
  );
  const { data: books } = useSWR<Book[]>('reveal-books', () => api.books({ limit: 500 }));
  // Not part of the `ready` gate: a reader may legitimately have no directive yet.
  const { data: directive } = useSWR<Directive>(DIRECTIVE_KEY, () => getDirective());

  const ready = stats && traits && archetype && highlights && books;

  const beats: Beat[] = useMemo(() => {
    if (!ready) return [];
    return buildBeats({ stats, traits, archetype, highlights, books, directive });
  }, [ready, stats, traits, archetype, highlights, books, directive]);

  const accent = archetype ? tasteAccent(archetype.code) : 'var(--accent)';

  // ── Error state ─────────────────────────────────────────────────────────────
  if (traitsErr || archetypeErr) {
    return (
      <RevealFrame accent={accent}>
        <div className="space-y-4">
          <h2 className="font-display text-2xl font-bold text-text">
            The reveal tripped on something.
          </h2>
          <p className="text-sm text-muted">Your profile is safe.</p>
          <RevealButton onClick={onClose}>See it here</RevealButton>
        </div>
      </RevealFrame>
    );
  }

  // ── Loading state ───────────────────────────────────────────────────────────
  if (!ready || beats.length === 0) {
    return (
      <RevealFrame accent={accent}>
        <p className="font-mono text-sm text-muted motion-safe:animate-pulse">
          Reading between your lines…
        </p>
      </RevealFrame>
    );
  }

  const beat = beats[index];
  const next = () => setIndex((i) => Math.min(i + 1, beats.length - 1));

  return (
    <RevealFrame accent={accent} progress={{ index, total: beats.length }} onSkip={onClose}>
      <Stagger reduced={reduced} key={index}>
        {renderBeat(beat, {
          next,
          onFinish,
          onClose,
          onVerdict: recordVerdict,
          verdicts,
        })}
      </Stagger>
    </RevealFrame>
  );
}

function renderBeat(
  beat: Beat,
  h: {
    next: () => void;
    onFinish: () => void;
    onClose: () => void;
    onVerdict: (id: number, v: 'confirmed' | 'edited' | 'rejected') => void;
    verdicts: Record<number, 'confirmed' | 'edited' | 'rejected'>;
  }
) {
  switch (beat.kind) {
    case 'cold-open':
      return (
        <div className="space-y-5">
          <h2 className="font-display text-4xl font-extrabold leading-tight text-text sm:text-5xl">
            We read your library.
          </h2>
          <p className="text-base text-muted">
            {beat.thin
              ? `It\u2019s ${beat.nBooks} books, enough for a sketch but not yet a portrait.`
              : `All ${beat.nBooks} books. The obsessions, the abandonments, the ones you rated at 2 a.m. and never reviewed.`}
          </p>
          <p className="text-base text-muted">Here’s what your shelf says about you.</p>
          <RevealButton onClick={h.next}>Show me</RevealButton>
        </div>
      );

    case 'numbers':
      return (
        <div className="space-y-5">
          <p className="font-display text-2xl font-bold text-text sm:text-3xl">
            <span className="text-user">{beat.nRated}</span> books rated ·{' '}
            <span className="text-user">{beat.nAuthors}</span> authors
            {beat.topGenre ? (
              <>
                {' '}
                · <span className="text-user">{beat.topGenre}</span> more than anything else
              </>
            ) : null}
          </p>
          {beat.avg != null && (
            <p className="text-base text-muted">
              Your average rating is <span className="text-user">{beat.avg.toFixed(2)}</span>.{' '}
              {beat.quip}
            </p>
          )}
          <RevealButton onClick={h.next}>Keep going</RevealButton>
        </div>
      );

    case 'reward-trait':
      return <RewardTraitBeat beat={beat} onNext={h.next} onVerdict={h.onVerdict} />;

    case 'aversions':
      return <AversionsBeat beat={beat} onNext={h.next} onVerdict={h.onVerdict} />;

    case 'shelves':
      return (
        <div className="space-y-5 text-left">
          {beat.genres.length >= 2 && (
            <p className="text-base text-muted">
              <span className="font-semibold text-text">Genre:</span>{' '}
              {beat.genres[0].share >= 0.8 ? (
                <>
                  {beat.genres[0].subject}, {Math.round(beat.genres[0].share * 100)}% of your shelf.
                  You know what you are.
                </>
              ) : (
                <>
                  {beat.genres[0].subject} is home. But {beat.genres[1].subject} is where you go
                  when nobody’s watching.
                </>
              )}
            </p>
          )}
          <p className="text-base text-muted">
            <span className="font-semibold text-text">Authors:</span>{' '}
            {beat.authors.length > 0
              ? `${beat.authors.join(', ')}. When you find a voice you trust, you follow it.`
              : 'No repeat authors in your top tier: you follow books, not names. Rare.'}
          </p>
          {beat.formatLine && (
            <p className="text-base text-muted">
              <span className="font-semibold text-text">Format:</span> {beat.formatLine}
            </p>
          )}
          <div className="text-center">
            <RevealButton onClick={h.next}>Keep going</RevealButton>
          </div>
        </div>
      );

    case 'axis':
      return (
        <div className="space-y-4">
          <p className="font-mono text-5xl font-extrabold text-user">{beat.codeSoFar}</p>
          <h2 className="font-display text-2xl font-bold capitalize text-text">{beat.axisKey}.</h2>
          <p className="text-base text-muted">{beat.poleLine}</p>
          {beat.rationale && <p className="text-sm text-faint">{beat.rationale}</p>}
          {beat.nearCenter && (
            <p className="text-xs italic text-faint">
              This one was close. You live near the middle of this axis.
            </p>
          )}
          <RevealButton onClick={h.next}>Continue</RevealButton>
        </div>
      );

    case 'finale':
      return (
        <div className="space-y-4">
          <p className="text-sm text-muted">
            {beat.thin
              ? 'Early read: you might be...'
              : `Four axes. ${beat.nBooks} books of evidence. One reader:`}
          </p>
          <p className="font-mono text-lg text-user">{beat.archetype.code}</p>
          <h1 className="font-display text-4xl font-extrabold text-user sm:text-5xl">
            {beat.archetype.name}
          </h1>
          <p className="text-sm italic text-muted">{beat.archetype.tagline}</p>
          <p className="text-sm text-muted">
            There are sixteen kinds of reader in our system. You’re the one who{' '}
            {beat.archetype.hook}.
          </p>
          <RevealButton onClick={h.next}>Continue</RevealButton>
        </div>
      );

    case 'summary': {
      const values = Object.values(h.verdicts);
      const nConfirmed = values.filter((v) => v === 'confirmed').length;
      const nEdited = values.filter((v) => v === 'edited').length;
      const nRejected = values.filter((v) => v === 'rejected').length;
      const total = values.length;
      const allConfirmed = total > 0 && nConfirmed === total;
      const mostlyRejected = total > 0 && nRejected / total > 0.5;
      return (
        <div className="space-y-4">
          {allConfirmed ? (
            <>
              <h2 className="font-display text-2xl font-bold text-text">You confirmed the lot.</h2>
              <p className="text-base text-muted">
                Either we nailed it or you’re being polite. You can revise any of this later on your
                profile page.
              </p>
            </>
          ) : mostlyRejected ? (
            <>
              <h2 className="font-display text-2xl font-bold text-text">
                We missed more than we hit. That happens with libraries like yours.
              </h2>
              <p className="text-base text-muted">
                Your corrections just taught us more than the import did. The next pass will be
                sharper.
              </p>
            </>
          ) : (
            <>
              <p className="font-display text-xl font-bold text-text">
                <span className="text-user">{nConfirmed}</span> confirmed.{' '}
                <span className="text-user">{nEdited}</span> said better by you.{' '}
                <span className="text-user">{nRejected}</span> struck from the record.
              </p>
              <p className="text-base text-muted">
                This is your taste profile now: not just what we inferred, what you signed off on.
                It gets smarter every time you rate, review, or correct us.
              </p>
            </>
          )}
          <RevealButton onClick={h.next}>Continue</RevealButton>
        </div>
      );
    }

    case 'directive':
      return (
        <div className="space-y-5">
          {beat.nlText ? (
            <>
              <h2 className="font-display text-2xl font-bold text-text">
                Your standing instructions
              </h2>
              <p className="whitespace-pre-wrap text-base text-muted">{beat.nlText}</p>
              <p className="text-sm text-faint">
                These steer every recommendation. Refine them anytime on your profile.
              </p>
            </>
          ) : (
            <>
              <h2 className="font-display text-2xl font-bold text-text">
                One more thing: tell us what you’re after.
              </h2>
              <p className="text-base text-muted">
                You can give the recommender standing instructions in your own words: “more
                nonfiction this year”, “nothing bleak”, “keep it short”. Add yours on your profile.
              </p>
            </>
          )}
          <RevealButton onClick={h.next}>Continue</RevealButton>
        </div>
      );

    case 'handoff':
      return (
        <div className="space-y-5">
          <h2 className="font-display text-3xl font-bold text-text">
            Enough about you. Let’s put it to work.
          </h2>
          <RevealButton onClick={h.onFinish}>Get my first recommendations</RevealButton>
          <div>
            <button
              type="button"
              onClick={h.onClose}
              className="font-mono text-xs text-faint hover:text-muted transition-colors"
            >
              Or explore your profile
            </button>
          </div>
        </div>
      );
  }
}
