'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import useSWR from 'swr';
import { api, type Stats, type ProfileStatus, PROFILE_STATUS_KEY } from '@/lib/api';
import { TasteHero } from '@/components/TasteHero';
import { Card, Button, useToast } from '@/components/ui';

// ── Stats strip ───────────────────────────────────────────────────────────────

function StatsStrip({ stats }: { stats: Stats }) {
  const toRead = stats.shelves?.['to-read'] ?? 0;
  const items = [
    { label: 'Books', value: stats.total },
    { label: 'Rated', value: stats.rated },
    {
      label: 'Avg rating',
      value: stats.mean_rating != null ? stats.mean_rating.toFixed(1) : '--',
    },
    { label: 'To read', value: toRead },
  ];

  return (
    <Card>
      <div className="grid grid-cols-2 gap-y-4 sm:gap-y-0 sm:grid-cols-4 sm:divide-x sm:divide-border sm:-mx-1">
        {items.map(({ label, value }) => (
          <div key={label} className="px-4 text-center">
            <p className="font-mono text-xl font-semibold text-text">{value}</p>
            <p className="mt-0.5 font-mono text-xs uppercase tracking-widest text-faint">
              {label}
            </p>
          </div>
        ))}
      </div>
    </Card>
  );
}

function StatsStripSkeleton() {
  return (
    <Card>
      <div className="grid grid-cols-2 gap-y-4 sm:gap-y-0 sm:grid-cols-4 sm:divide-x sm:divide-border sm:-mx-1">
        {[1, 2, 3, 4].map(i => (
          <div key={i} className="px-4 text-center space-y-2">
            <div className="h-6 w-12 mx-auto rounded bg-elevated motion-safe:animate-pulse" />
            <div className="h-3 w-16 mx-auto rounded bg-elevated motion-safe:animate-pulse" />
          </div>
        ))}
      </div>
    </Card>
  );
}

// ── Ratings breakdown ─────────────────────────────────────────────────────────

function RatingsBreakdown({ stats }: { stats: Stats }) {
  if (!stats.by_star || Object.keys(stats.by_star).length === 0) return null;

  return (
    <Card>
      <p className="mb-4 font-mono text-xs font-medium uppercase tracking-widest text-muted">
        Ratings breakdown
      </p>
      <div className="space-y-2">
        {[5, 4, 3, 2, 1].map(star => {
          const count = stats.by_star[String(star)] ?? 0;
          const pct   = stats.rated > 0 ? (count / stats.rated) * 100 : 0;
          return (
            <div key={star} className="flex items-center gap-3">
              <span className="w-8 text-right font-mono text-sm text-muted">
                {star}
                <span aria-hidden="true"> ★</span>
              </span>
              <div className="flex-1 overflow-hidden rounded-full bg-elevated h-2">
                <div
                  className="h-2 rounded-full bg-accent transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="w-8 text-right font-mono text-sm text-faint">{count}</span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function HomePage() {
  const router  = useRouter();
  const toast   = useToast();
  const [running, setRunning] = useState(false);

  const {
    data: stats,
    isLoading: statsLoading,
    error: statsError,
  } = useSWR<Stats>('stats', () => api.stats());

  const { data: profileStatus } = useSWR<ProfileStatus>(
    PROFILE_STATUS_KEY,
    () => api.profileStatus()
  );

  const noProfile  = profileStatus != null && profileStatus.last_profiled_at === null;
  const isDirty    = profileStatus?.dirty ?? false;
  const recBlocked = noProfile || isDirty;

  const recBlockMsg = noProfile
    ? 'No taste profile yet - head to My Profile to build one first.'
    : isDirty
    ? 'Your library has changed since the last profile build - head to My Profile to update it.'
    : null;

  async function handleRun() {
    setRunning(true);
    try {
      await api.runRecommend(10);
      router.push('/swipe');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Something went wrong running recommendations.');
      setRunning(false);
    }
  }

  return (
    <div className="fade-in space-y-6 py-6">
      {/* 1. Signature: Taste Hero */}
      <TasteHero />

      {/* 2. Stats strip */}
      {statsLoading ? (
        <StatsStripSkeleton />
      ) : statsError ? (
        <p className="text-sm text-danger">Could not load library stats.</p>
      ) : stats ? (
        <StatsStrip stats={stats} />
      ) : null}

      {/* 3. Ratings breakdown */}
      {stats && <RatingsBreakdown stats={stats} />}

      {/* 4. Run recommendations CTA */}
      <Card>
        <div className="text-center">
          <h2 className="mb-1 font-display text-lg font-semibold text-text">
            Ready for new picks?
          </h2>
          <p className="mb-5 text-sm text-muted">
            Claude will analyze your taste profile and find 10 books matched to you.
            This takes 30 - 60 seconds.
          </p>

          <Button
            size="lg"
            loading={running}
            disabled={running || recBlocked}
            onClick={handleRun}
          >
            {running ? 'Running...' : 'Run Recommendations'}
          </Button>

          {recBlockMsg && (
            <p className="mt-4 text-sm text-warning">{recBlockMsg}</p>
          )}
        </div>
      </Card>
    </div>
  );
}
