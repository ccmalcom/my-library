'use client';

import { useState, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import useSWR, { mutate } from 'swr';
import { Inbox, Sparkles } from 'lucide-react';
import { api, type Book, type Recommendation, type Trait, REJECT_REASONS, rejectRecWithReasons, recordTasteSignal, PROFILE_STATUS_KEY } from '@/lib/api';
import { Button, Spinner, useToast } from '@/components/ui';
import SwipeCard from '@/components/SwipeCard';
import BookEditModal from '@/components/BookEditModal';
import { useFeedbackPrompt } from '@/hooks/useFeedbackPrompt';

export default function SwipePage() {
  const router = useRouter();
  const toast  = useToast();
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());
  const [reviewing, setReviewing] = useState<Book | null>(null);
  const [pendingRejectId, setPendingRejectId] = useState<number | null>(null);
  const [selectedReasons, setSelectedReasons] = useState<Set<string>>(new Set());

  const { data: recs, isLoading: recsLoading, error: recsError } =
    useSWR<Recommendation[]>('recommendations', () => api.recommendations());

  const { data: traits = [] } =
    useSWR<Trait[]>('profile', () => api.profile());

  // post-recs feedback prompt: fire when the user actions the last card this session
  const runId = recs?.[0]?.run_id;
  const { fire: fireRecsPrompt, modal: recsModal } = useFeedbackPrompt('post-recs', runId);

  const pending = (recs ?? [])
    .filter((r) => r.status === 'served' && !dismissed.has(r.id))
    .sort((a, b) => a.rank - b.rank);

  const total = (recs ?? []).filter(
    (r) => r.status === 'served' || dismissed.has(r.id)
  );

  useEffect(() => {
    if (dismissed.size > 0 && pending.length === 0 && recs && recs.length > 0) {
      fireRecsPrompt();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending.length, dismissed.size]);

  const handleDecide = useCallback(
    async (recId: number, status: 'accepted' | 'rejected' | 'already_read') => {
      if (status === 'rejected') {
        setPendingRejectId(recId);
        setSelectedReasons(new Set());
        return;
      }
      setDismissed((prev) => new Set([...prev, recId]));
      try {
        const result = await api.feedback(recId, { status });
        if (status === 'already_read' && result.book) {
          setReviewing(result.book);
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed to save decision.');
        setDismissed((prev) => {
          const next = new Set(prev);
          next.delete(recId);
          return next;
        });
      }
    },
    [toast]
  );

  const toggleReason = useCallback((key: string) => {
    setSelectedReasons((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const handleTasteSignal = useCallback(
    async (rec: Recommendation, direction: 'more' | 'less') => {
      try {
        await recordTasteSignal({
          target_kind: 'rec',
          direction,
          snapshot: {
            title: rec.title,
            author: rec.author,
            subjects: rec.subjects,
            isbn13: rec.isbn13,
          },
        });
        void mutate(PROFILE_STATUS_KEY);
      } catch (e) {
        console.error('taste signal failed', e);
      }
    },
    []
  );

  const submitReject = useCallback(async () => {
    if (pendingRejectId === null) return;
    const recId = pendingRejectId;
    setPendingRejectId(null);
    setDismissed((prev) => new Set([...prev, recId]));
    try {
      await rejectRecWithReasons(recId, [...selectedReasons]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save decision.');
      setDismissed((prev) => {
        const next = new Set(prev);
        next.delete(recId);
        return next;
      });
    }
  }, [pendingRejectId, selectedReasons, toast]);

  if (recsLoading) {
    return (
      <div className='fade-in flex items-center justify-center py-24'>
        <div className='text-center space-y-3'>
          <Spinner size='lg' />
          <p className='text-muted text-sm'>Loading recommendations...</p>
        </div>
      </div>
    );
  }

  if (recsError) {
    return (
      <div className='fade-in py-12 text-center'>
        <p className='text-danger'>Failed to load recommendations.</p>
        <p className='mt-1 text-sm text-faint'>{String(recsError)}</p>
      </div>
    );
  }

  if ((recs ?? []).length === 0) {
    return (
      <div className='fade-in py-20 text-center space-y-4'>
        <Inbox className='mx-auto h-12 w-12 text-faint' />
        <h2 className='text-xl font-display font-semibold text-text'>No recommendations yet</h2>
        <p className='text-muted'>
          Go to the home page and run a recommendation batch first.
        </p>
        <Button onClick={() => router.push('/')}>Back to Home</Button>
      </div>
    );
  }

  if (pending.length === 0) {
    return (
      <>
        <div className='fade-in py-20 text-center space-y-4'>
          <Sparkles className='mx-auto h-12 w-12 text-accent' />
          <h2 className='text-xl font-display font-semibold text-text'>All done!</h2>
          <p className='text-muted'>
            You reviewed all {total.length} recommendations.
          </p>
          <Button onClick={() => router.push('/library?tab=to-read')}>
            View To-Read Shelf
          </Button>
        </div>
        {reviewing && (
          <BookEditModal
            book={reviewing}
            listKey='recommendations'
            onClose={() => setReviewing(null)}
          />
        )}
        {recsModal}
      </>
    );
  }

  const visibleStack = pending.slice(0, 3);

  return (
    <>
      <div className='fade-in flex flex-col items-center gap-6 py-6'>
        {/* Progress */}
        <p className='font-mono text-xs uppercase tracking-widest text-faint'>
          {dismissed.size} / {(recs ?? []).filter((r) => r.status === 'served' || dismissed.has(r.id)).length} reviewed
        </p>

        {/* Card stack */}
        <div className='relative h-[440px] sm:h-[560px] w-full max-w-sm'>
          {visibleStack
            .slice()
            .reverse()
            .map((rec, idx) => {
              const isTop = idx === visibleStack.length - 1;
              return (
                <SwipeCard
                  key={rec.id}
                  rec={rec}
                  traits={traits}
                  onDecide={handleDecide}
                  zIndex={idx + 1}
                  isTop={isTop}
                />
              );
            })}
        </div>

        {/* Button controls */}
        <div className='flex gap-4 items-center'>
          <button
            onClick={() => { const top = pending[0]; if (top) void handleDecide(top.id, 'rejected'); }}
            aria-label='Not interested'
            className={[
              'flex h-14 w-14 items-center justify-center rounded-full',
              'border-2 border-danger bg-surface text-danger shadow',
              'transition hover:bg-danger/10 active:scale-95',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger focus-visible:ring-offset-2 focus-visible:ring-offset-base',
            ].join(' ')}
          >
            <span className='text-xl font-bold' aria-hidden='true'>X</span>
          </button>
          <button
            onClick={() => { const top = pending[0]; if (top) void handleDecide(top.id, 'already_read'); }}
            aria-label='Already read'
            className={[
              'flex h-12 w-12 items-center justify-center self-center rounded-full',
              'border-2 border-warning bg-surface text-warning shadow',
              'transition hover:bg-warning/10 active:scale-95',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning focus-visible:ring-offset-2 focus-visible:ring-offset-base',
            ].join(' ')}
          >
            <span className='text-base font-mono font-bold' aria-hidden='true'>R</span>
          </button>
          <button
            onClick={() => { const top = pending[0]; if (top) void handleDecide(top.id, 'accepted'); }}
            aria-label='Add to to-read list'
            className={[
              'flex h-14 w-14 items-center justify-center rounded-full',
              'border-2 border-success bg-surface text-success shadow',
              'transition hover:bg-success/10 active:scale-95',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success focus-visible:ring-offset-2 focus-visible:ring-offset-base',
            ].join(' ')}
          >
            <span className='text-xl font-bold' aria-hidden='true'>+</span>
          </button>
        </div>

        <p className='font-mono text-xs text-faint'>
          Drag left/right or use the buttons
        </p>

        {/* Taste signal row */}
        {pending[0] && (
          <div className='flex gap-3'>
            <button
              onClick={() => { const top = pending[0]; if (top) void handleTasteSignal(top, 'less'); }}
              aria-label='Less like this'
              className={[
                'rounded-full border border-border bg-surface px-4 py-1.5 text-xs font-medium text-muted',
                'transition hover:border-danger/60 hover:text-danger active:scale-95',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-base',
              ].join(' ')}
            >
              Less like this
            </button>
            <button
              onClick={() => { const top = pending[0]; if (top) void handleTasteSignal(top, 'more'); }}
              aria-label='More like this'
              className={[
                'rounded-full border border-border bg-surface px-4 py-1.5 text-xs font-medium text-muted',
                'transition hover:border-success/60 hover:text-success active:scale-95',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-base',
              ].join(' ')}
            >
              More like this
            </button>
          </div>
        )}
      </div>
      {reviewing && (
        <BookEditModal
          book={reviewing}
          listKey='recommendations'
          onClose={() => setReviewing(null)}
        />
      )}
      {recsModal}
      {pendingRejectId !== null && (
        <div className='fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center'>
          <div className='w-full max-w-sm rounded-t-2xl sm:rounded-2xl bg-surface p-6 shadow-xl'>
            <p className='mb-1 text-sm font-semibold text-text'>Why not interested?</p>
            <p className='mb-4 text-xs text-faint'>Optional -- helps improve recommendations.</p>
            <div className='flex flex-wrap gap-2'>
              {Object.entries(REJECT_REASONS).map(([key, label]) => {
                const active = selectedReasons.has(key);
                return (
                  <button
                    key={key}
                    onClick={() => toggleReason(key)}
                    className={[
                      'rounded-full border px-3 py-1 text-xs font-medium transition',
                      active
                        ? 'border-accent bg-accent/20 text-accent'
                        : 'border-border bg-base text-muted hover:border-accent hover:text-accent',
                    ].join(' ')}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <div className='mt-5 flex gap-3 justify-end'>
              <Button variant='ghost' size='sm' onClick={submitReject}>
                Skip
              </Button>
              <Button size='sm' onClick={submitReject}>
                {selectedReasons.size > 0 ? 'Submit' : 'Confirm'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
