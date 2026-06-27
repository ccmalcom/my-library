'use client';

import { useState, useRef, useEffect } from 'react';
import useSWR, { mutate } from 'swr';
import {
  api,
  type Trait,
  type Stats,
  type SubjectBreakdown,
  type Book,
  type ProfileStatus,
  type UserProfile,
  PROFILE_STATUS_KEY,
  USER_PROFILE_KEY,
} from '@/lib/api';
import { Button, Badge, Card, useToast } from '@/components/ui';
import { TasteHero } from '@/components/TasteHero';
import { useFeedbackPrompt } from '@/hooks/useFeedbackPrompt';

const TRAITS_KEY   = 'profile-traits';
const STATS_KEY    = 'stats';
const SUBJECTS_KEY = 'profile-subjects';
const BOOKS_KEY    = 'books-all';

// ─── Trait card ───────────────────────────────────────────────────────────────

function TraitCard({
  trait,
  bookMap,
}: {
  trait: Trait;
  bookMap: Map<number, string>;
}) {
  const toast = useToast();
  const isReward = trait.polarity === 'reward';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]     = useState(trait.claim);
  const [saving, setSaving]   = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) setDraft(trait.claim);
  }, [trait.claim, editing]);

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
      textareaRef.current.focus();
    }
  }, [editing, draft]);

  async function save() {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === trait.claim) {
      setEditing(false);
      setDraft(trait.claim);
      return;
    }
    setSaving(true);
    try {
      await api.updateTrait(trait.id, { claim: trimmed });
      await mutate(TRAITS_KEY);
      toast.success('Trait saved.');
      setEditing(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    setEditing(false);
    setDraft(trait.claim);
  }

  const exhibitTitles  = (trait.exhibits  ?? []).map((id) => bookMap.get(id)).filter(Boolean) as string[];
  const contrastTitles = (trait.contrasts ?? []).map((id) => bookMap.get(id)).filter(Boolean) as string[];

  const polarityVariant = isReward ? 'success' : 'danger';
  const polarityLabel   = isReward ? 'Loves' : 'Avoids';
  const borderClass     = isReward
    ? 'border-success/30 bg-success/5'
    : 'border-danger/30 bg-danger/5';

  return (
    <div className={['rounded-xl border p-4 space-y-3 transition', borderClass].join(' ')}>
      {/* Header row */}
      <div className='flex items-start gap-3'>
        <Badge variant={polarityVariant} className='mt-0.5 shrink-0'>
          {polarityLabel}
        </Badge>

        {/* Claim */}
        <div className='flex-1 min-w-0'>
          {editing ? (
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={1}
              className={[
                'w-full resize-none rounded-lg border border-accent bg-elevated px-3 py-2',
                'text-sm text-text focus:outline-none focus-visible:ring-1 focus-visible:ring-accent',
              ].join(' ')}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save();
                if (e.key === 'Escape') cancel();
              }}
            />
          ) : (
            <button
              type='button'
              onClick={() => setEditing(true)}
              title='Click to edit'
              className='group text-left text-sm text-text hover:text-text focus-visible:outline-none'
            >
              {trait.claim}
              <span className='ml-2 opacity-0 group-hover:opacity-50 text-xs text-faint transition-opacity'>
                edit
              </span>
            </button>
          )}
        </div>

        {/* Confidence + status */}
        <div className='shrink-0 flex flex-col items-end gap-1'>
          <span className='font-mono text-xs text-faint'>
            {Math.round(trait.inference_confidence * 100)}%
          </span>
          {trait.status !== 'proposed' && (
            <Badge variant={trait.status === 'edited' ? 'accent' : trait.status === 'confirmed' ? 'success' : 'default'}>
              {trait.status}
            </Badge>
          )}
        </div>
      </div>

      {/* Edit actions */}
      {editing && (
        <div className='flex items-center gap-2 pl-14'>
          <Button size='sm' loading={saving} onClick={() => void save()}>
            {saving ? 'Saving...' : 'Save'}
          </Button>
          <Button size='sm' variant='ghost' onClick={cancel}>
            Cancel
          </Button>
          <span className='text-xs text-faint'>Cmd+Enter to save · Esc to cancel</span>
        </div>
      )}

      {/* Evidence books */}
      {(exhibitTitles.length > 0 || contrastTitles.length > 0) && (
        <div className='pl-14 space-y-1.5'>
          {exhibitTitles.length > 0 && (
            <div className='flex flex-wrap gap-1'>
              <span className='text-xs text-faint mr-1'>Evidence:</span>
              {exhibitTitles.slice(0, 4).map((t) => (
                <Badge key={t} variant='mono'>{t}</Badge>
              ))}
            </div>
          )}
          {contrastTitles.length > 0 && (
            <div className='flex flex-wrap gap-1'>
              <span className='text-xs text-faint mr-1'>Contrast:</span>
              {contrastTitles.slice(0, 3).map((t) => (
                <Badge key={t}>{t}</Badge>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Build profile CTA ────────────────────────────────────────────────────────

function BuildProfileCTA({ onBuild }: { onBuild: () => Promise<void> }) {
  const [running, setRunning] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  async function handle() {
    setRunning(true);
    setError(null);
    try {
      await onBuild();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Build failed.');
      setRunning(false);
    }
  }

  return (
    <Card className='text-center space-y-4'>
      <p className='text-muted font-medium'>No taste profile yet.</p>
      <p className='text-sm text-faint'>
        Claude will read your rated books and infer what you love and avoid.
        This takes about 30 seconds and needs your Anthropic API key.
      </p>
      <Button loading={running} onClick={handle}>
        {running ? 'Building profile...' : 'Build Profile'}
      </Button>
      {error && <p className='text-sm text-danger'>{error}</p>}
    </Card>
  );
}

// ─── Traits section ───────────────────────────────────────────────────────────

function TraitsSection({
  traits,
  bookMap,
  onBuildProfile,
}: {
  traits: Trait[];
  bookMap: Map<number, string>;
  onBuildProfile: () => Promise<void>;
}) {
  const [filter, setFilter] = useState<'all' | 'reward' | 'aversion'>('all');

  const rewards   = traits.filter((t) => t.polarity === 'reward');
  const aversions = traits.filter((t) => t.polarity === 'aversion');

  const visible =
    filter === 'all' ? traits : filter === 'reward' ? rewards : aversions;

  const filterBtnClass = (active: boolean) =>
    [
      'rounded-md px-2.5 py-1 text-xs capitalize transition',
      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
      active ? 'bg-elevated text-text' : 'text-muted hover:text-text',
    ].join(' ');

  return (
    <section className='space-y-4'>
      <div className='flex items-center justify-between'>
        <div>
          <h2 className='font-display text-lg font-semibold text-text'>Taste Traits</h2>
          <p className='mt-0.5 text-xs text-faint'>
            Claude inferred these from your ratings. Click any trait to reword it.
          </p>
        </div>
        <div className='flex gap-1 rounded-lg border border-border bg-elevated p-1'>
          {(['all', 'reward', 'aversion'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={filterBtnClass(filter === f)}
            >
              {f === 'all'
                ? `All (${traits.length})`
                : f === 'reward'
                ? `Loves (${rewards.length})`
                : `Avoids (${aversions.length})`}
            </button>
          ))}
        </div>
      </div>

      {traits.length === 0 ? (
        <BuildProfileCTA onBuild={onBuildProfile} />
      ) : visible.length === 0 ? (
        <p className='py-10 text-center text-faint'>No traits match this filter.</p>
      ) : (
        <div className='space-y-3'>
          {visible.map((t) => (
            <TraitCard key={t.id} trait={t} bookMap={bookMap} />
          ))}
        </div>
      )}
    </section>
  );
}

// ─── Rating distribution ──────────────────────────────────────────────────────

function RatingSection({ stats }: { stats: Stats }) {
  const total      = stats.rated ?? 0;
  const byStarData = stats.by_star ?? {};

  return (
    <section className='space-y-4'>
      <div>
        <h2 className='font-display text-lg font-semibold text-text'>Rating Distribution</h2>
        <p className='mt-0.5 text-xs text-faint'>
          {total} rated book{total !== 1 ? 's' : ''}{' '}
          {stats.mean_rating != null ? `· mean ${stats.mean_rating.toFixed(2)}` : ''}
        </p>
      </div>
      <Card>
        <div className='space-y-3'>
          {[5, 4, 3, 2, 1].map((star) => {
            const count = byStarData[String(star)] ?? 0;
            const pct   = total > 0 ? (count / total) * 100 : 0;
            return (
              <div key={star} className='flex items-center gap-3'>
                <span className='w-12 shrink-0 text-right font-mono text-sm text-accent'>
                  {'\u2605'.repeat(star)}
                </span>
                <div className='flex-1 overflow-hidden rounded-full bg-elevated h-2.5'>
                  <div
                    className='h-2.5 rounded-full bg-accent transition-all duration-500'
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className='w-16 shrink-0 text-right font-mono text-sm text-muted'>
                  {count}{' '}
                  <span className='text-faint text-xs'>({pct.toFixed(0)}%)</span>
                </span>
              </div>
            );
          })}
        </div>
      </Card>
    </section>
  );
}

// ─── Genre breakdown ──────────────────────────────────────────────────────────

function GenreSection({ subjects }: { subjects: SubjectBreakdown }) {
  const [tier, setTier] = useState<string>('all');
  const tierKeys = Object.keys(subjects.by_tier);

  const items    = tier === 'all' ? subjects.overall : (subjects.by_tier[tier] ?? []);
  const maxCount = items[0]?.count ?? 1;

  const filterBtnClass = (active: boolean) =>
    [
      'rounded-md px-2.5 py-1 text-xs transition',
      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
      active ? 'bg-elevated text-text' : 'text-muted hover:text-text',
    ].join(' ');

  return (
    <section className='space-y-4'>
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div>
          <h2 className='font-display text-lg font-semibold text-text'>Genre Breakdown</h2>
          <p className='mt-0.5 text-xs text-faint'>
            Subjects from enriched catalog data across your rated books.
          </p>
        </div>
        <div className='flex flex-wrap gap-1 rounded-lg border border-border bg-elevated p-1'>
          <button onClick={() => setTier('all')} className={filterBtnClass(tier === 'all')}>
            All
          </button>
          {tierKeys.map((k) => (
            <button key={k} onClick={() => setTier(k)} className={filterBtnClass(tier === k)}>
              {'\u2605'.repeat(Number(k))}
            </button>
          ))}
        </div>
      </div>

      {items.length === 0 ? (
        <p className='py-10 text-center text-faint'>
          No subject data yet. Run enrich to pull catalog metadata.
        </p>
      ) : (
        <Card>
          <div className='space-y-2.5'>
            {items.map(({ subject, count }) => {
              const pct = (count / maxCount) * 100;
              return (
                <div key={subject} className='flex items-center gap-3'>
                  <span
                    className='w-24 sm:w-40 shrink-0 truncate text-sm text-muted'
                    title={subject}
                  >
                    {subject}
                  </span>
                  <div className='flex-1 overflow-hidden rounded-full bg-elevated h-2'>
                    <div
                      className='h-2 rounded-full bg-accent transition-all duration-500'
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className='w-6 shrink-0 text-right font-mono text-xs text-faint'>
                    {count}
                  </span>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </section>
  );
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function Skeleton() {
  return (
    <div className='space-y-3'>
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className='h-16 rounded-xl border border-border bg-surface motion-safe:animate-pulse'
        />
      ))}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ProfilePage() {
  const { data: traits = [], isLoading: traitsLoading } = useSWR<Trait[]>(
    TRAITS_KEY,
    () => api.profile()
  );
  const { data: stats, isLoading: statsLoading } = useSWR<Stats>(
    STATS_KEY,
    () => api.stats()
  );
  const { data: subjects, isLoading: subjectsLoading } = useSWR<SubjectBreakdown>(
    SUBJECTS_KEY,
    () => api.profileSubjects()
  );
  const { data: allBooks = [] } = useSWR<Book[]>(
    BOOKS_KEY,
    () => api.books({ limit: 500 })
  );

  const bookMap   = new Map(allBooks.map((b) => [b.id, b.title]));
  const isLoading = traitsLoading || statsLoading || subjectsLoading;

  // post-first-profile feedback prompt: fire once when profile data first loads
  const { fire: fireProfilePrompt, modal: profileModal } = useFeedbackPrompt('post-first-profile');
  const profileFiredRef = useRef(false);
  useEffect(() => {
    if (!traitsLoading && !profileFiredRef.current) {
      profileFiredRef.current = true;
      fireProfilePrompt();
    }
  }, [traitsLoading, fireProfilePrompt]);

  async function handleBuildProfile() {
    await api.runProfile();
    await Promise.all([
      mutate(TRAITS_KEY),
      mutate(PROFILE_STATUS_KEY),
    ]);
  }

  return (
    <div className='fade-in space-y-8 py-6'>
      <TasteHero compact />

      {isLoading ? (
        <Skeleton />
      ) : (
        <>
          <TraitsSection
            traits={traits}
            bookMap={bookMap}
            onBuildProfile={handleBuildProfile}
          />
          {stats && <RatingSection stats={stats} />}
          {subjects && <GenreSection subjects={subjects} />}
        </>
      )}
      {profileModal}
    </div>
  );
}
