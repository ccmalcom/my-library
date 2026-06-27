'use client';

import { useState } from 'react';
import { mutate } from 'swr';
import { api, PROFILE_STATUS_KEY, type Book, type BookFeedbackRequest } from '@/lib/api';
import { Button, Modal, useToast } from '@/components/ui';

interface Props {
  book: Book;
  listKey: string;
  onClose: () => void;
  queuePosition?: { index: number; total: number };
  onFinishQueue?: () => void;
  allowRemove?: boolean;
  allowReviewWithoutRating?: boolean;
}

const inputClass = [
  'w-full rounded-lg border border-border bg-base px-3 py-2 text-sm text-text',
  'placeholder-faint focus:border-accent focus:outline-none',
  'focus-visible:ring-1 focus-visible:ring-accent',
].join(' ');

const labelClass = 'mb-2 block font-mono text-xs font-semibold uppercase tracking-widest text-muted';

export default function BookEditModal({
  book,
  listKey,
  onClose,
  queuePosition,
  onFinishQueue,
  allowRemove,
  allowReviewWithoutRating = false,
}: Props) {
  const toast = useToast();

  const initialRating   = book.effective_rating ?? 0;
  const initialReview   = book.app_review ?? '';
  const initialDate     = book.date_read ?? '';
  const initialExclude  = book.exclude_from_profile ?? false;

  const [rating, setRating]         = useState(initialRating);
  const [hover, setHover]           = useState(0);
  const [review, setReview]         = useState(initialReview);
  const [dateRead, setDateRead]     = useState(initialDate);
  const [exclude, setExclude]       = useState(initialExclude);
  const [saving, setSaving]         = useState(false);
  const [removeArmed, setRemoveArmed] = useState(false);
  const [removing, setRemoving]     = useState(false);
  const [descExpanded, setDescExpanded] = useState(false);

  const ratingChanged       = rating !== initialRating;
  const reviewChanged       = review.trim() !== initialReview.trim();
  const dateChanged         = dateRead !== '' && dateRead !== initialDate;
  const excludeChanged      = exclude !== initialExclude;
  const dirty               = ratingChanged || reviewChanged || dateChanged || excludeChanged;
  const reviewWithoutRating = !allowReviewWithoutRating && review.trim() !== '' && rating === 0;
  const canSave             = dirty && !reviewWithoutRating;

  const desc = book.description ?? null;
  const DESC_CUTOFF = 200;
  const descShort = desc && desc.length > DESC_CUTOFF
    ? desc.slice(0, DESC_CUTOFF - 3) + '...'
    : desc;

  async function handleSave() {
    if (!dirty) { onClose(); return; }
    setSaving(true);
    const req: BookFeedbackRequest = {};
    if (ratingChanged) req.rating = rating;
    if (reviewChanged) {
      if (review.trim() === '') req.clear_review = true;
      else req.review = review.trim();
    }
    if (dateChanged) req.date_read = dateRead;
    if (excludeChanged) req.exclude_from_profile = exclude;
    try {
      await api.setBookFeedback(book.id, req);
      await Promise.all([mutate(listKey), mutate(PROFILE_STATUS_KEY)]);
      toast.success('Saved.');
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save.');
      setSaving(false);
    }
  }

  async function handleRemove() {
    setRemoving(true);
    try {
      await api.removeBook(book.id);
      await Promise.all([mutate(listKey), mutate('stats'), mutate(PROFILE_STATUS_KEY)]);
      toast.success(`${book.title} removed.`);
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to remove.');
      setRemoving(false);
      setRemoveArmed(false);
    }
  }

  const shown = hover || rating;
  const busy  = saving || removing;

  return (
    <Modal
      labelId='book-edit-title'
      onClose={onClose}
      className='fade-in flex max-h-[90vh] w-full max-w-md flex-col overflow-y-auto rounded-2xl border border-border bg-surface p-6 shadow-2xl'
    >
      {/* Header */}
      <div className='mb-4'>
        {queuePosition && (
          <p className='mb-1 font-mono text-xs font-semibold uppercase tracking-widest text-accent'>
            Missing reviews · {queuePosition.index + 1} of {queuePosition.total}
          </p>
        )}
        <h2 id='book-edit-title' className='text-lg font-bold leading-tight text-text'>
          {book.title}
        </h2>
        <p className='text-sm text-muted'>
          {book.author ?? 'Unknown'}
          {book.year_published ? ` · ${book.year_published}` : ''}
        </p>
      </div>

      {/* Description */}
      {desc && (
        <div className='mb-5'>
          <p className={labelClass}>About</p>
          <p className='text-sm leading-relaxed text-muted'>
            {descExpanded ? desc : descShort}
          </p>
          {desc.length > DESC_CUTOFF && (
            <button
              type='button'
              onClick={() => setDescExpanded((v) => !v)}
              className='mt-1 text-xs text-accent hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent rounded'
            >
              {descExpanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      )}

      {/* Rating */}
      <div className='mb-5'>
        <div className='mb-2 flex items-center justify-between'>
          <span className={labelClass}>Your rating</span>
          {rating > 0 && (
            <button
              type='button'
              onClick={() => setRating(0)}
              className='text-xs text-faint hover:text-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent rounded'
            >
              Clear
            </button>
          )}
        </div>
        <div className='flex gap-1' onMouseLeave={() => setHover(0)}>
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type='button'
              onMouseEnter={() => setHover(n)}
              onClick={() => setRating(n)}
              className='rounded text-3xl leading-none transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent'
              aria-label={`${n} star${n > 1 ? 's' : ''}`}
            >
              <span className={n <= shown ? 'text-accent' : 'text-faint'} aria-hidden='true'>
                ★
              </span>
            </button>
          ))}
        </div>
        {rating === 0 && (
          <p className='mt-1 text-xs text-faint'>
            {book.goodreads_rating > 0 ? 'Unrated (Goodreads import cleared).' : 'Unrated.'}
          </p>
        )}
      </div>

      {/* Review */}
      <div className='mb-5'>
        <label className={labelClass}>Review</label>
        <textarea
          value={review}
          onChange={(e) => setReview(e.target.value)}
          rows={5}
          placeholder='What did you think? Your words feed the taste profile...'
          className={[inputClass, 'resize-y'].join(' ')}
        />
        {reviewWithoutRating && (
          <p className='mt-1 text-xs text-warning'>
            Add a star rating above to save your review.
          </p>
        )}
      </div>

      {/* Date read */}
      <div className='mb-5'>
        <label className={labelClass}>
          Date read{' '}
          <span className='font-normal normal-case text-faint'>· optional, if you remember</span>
        </label>
        <input
          type='date'
          value={dateRead}
          max={new Date().toISOString().slice(0, 10)}
          onChange={(e) => setDateRead(e.target.value)}
          className='rounded-lg border border-border bg-base px-3 py-2 text-sm text-text focus:border-accent focus:outline-none focus-visible:ring-1 focus-visible:ring-accent [color-scheme:dark]'
        />
      </div>

      {/* Exclude from profile toggle */}
      <div className='mb-5 flex items-start gap-3'>
        <button
          type='button'
          role='switch'
          aria-checked={exclude}
          onClick={() => setExclude(!exclude)}
          className={[
            'relative mt-0.5 h-5 w-9 flex-shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
            exclude ? 'bg-accent' : 'bg-border',
          ].join(' ')}
        >
          <span
            className={[
              'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform',
              exclude ? 'translate-x-4' : 'translate-x-0.5',
            ].join(' ')}
          />
        </button>
        <div>
          <p className='text-sm font-medium text-text'>Exclude from taste profile</p>
          <p className='text-xs text-faint'>Track this book without letting it influence your recommendations or reader archetype.</p>
        </div>
      </div>

      {/* Footer actions */}
      <div className='flex items-center justify-between gap-2'>
        {/* Left side: queue finish-later / remove */}
        {queuePosition ? (
          <button
            type='button'
            onClick={onFinishQueue}
            disabled={busy}
            className='text-sm font-medium text-faint transition hover:text-muted disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent rounded'
          >
            Finish later
          </button>
        ) : allowRemove ? (
          removeArmed ? (
            <button
              type='button'
              onClick={handleRemove}
              disabled={busy}
              className='text-sm font-semibold text-danger transition hover:opacity-80 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-danger rounded'
            >
              {removing ? 'Removing...' : 'Confirm remove'}
            </button>
          ) : (
            <button
              type='button'
              onClick={() => setRemoveArmed(true)}
              disabled={busy}
              className='text-sm font-medium text-faint transition hover:text-danger disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-danger rounded'
            >
              Remove
            </button>
          )
        ) : (
          <span />
        )}

        {/* Right side: cancel + save */}
        <div className='flex gap-2'>
          <Button variant='ghost' onClick={onClose} disabled={busy}>
            {queuePosition ? 'Skip' : 'Cancel'}
          </Button>
          <Button
            onClick={handleSave}
            loading={saving}
            disabled={busy || !canSave}
          >
            {saving ? 'Saving...' : queuePosition ? 'Save & next' : 'Save'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
