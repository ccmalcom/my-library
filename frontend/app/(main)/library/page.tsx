'use client';

import { useState, Suspense } from 'react';
import Image from 'next/image';
import { useRouter, useSearchParams } from 'next/navigation';
import useSWR, { mutate } from 'swr';
import { BookOpen } from 'lucide-react';
import {
  api,
  PROFILE_STATUS_KEY,
  type Book,
  type Recommendation,
  type Shelf,
} from '@/lib/api';
import { Button, Badge, Card, Modal } from '@/components/ui';
import BookEditModal from '@/components/BookEditModal';
import AddBookModal from '@/components/AddBookModal';

const READ_KEY              = 'books-read';
const TO_READ_KEY           = 'books-to-read';
const CURRENTLY_READING_KEY = 'books-currently-reading';
const REJECTED_KEY          = 'recs-rejected';
const DNF_KEY               = 'books-dnf';

const STARS = [5, 4, 3, 2, 1] as const;
type Tab = 'read' | 'to-read' | 'currently-reading' | 'did-not-finish' | 'rejected';

// ── Shared helpers ─────────────────────────────────────────────────────────────

function StarDisplay({ rating }: { rating: number | null }) {
  if (!rating) return <span className='font-mono text-xs text-faint'>unrated</span>;
  return (
    <span className='font-mono text-sm text-accent' aria-label={`${rating} stars`}>
      {'\u2605'.repeat(rating)}
      <span className='text-faint' aria-hidden='true'>{'\u2605'.repeat(5 - rating)}</span>
    </span>
  );
}

function CoverThumb({ book, size = 'sm' }: { book: Book | { cover_url?: string | null; title?: string }; size?: 'sm' | 'md' }) {
  const dims = size === 'sm' ? 'h-14 w-10' : 'h-20 w-14';
  const src = 'cover_url' in book ? book.cover_url : null;
  const title = 'title' in book ? (book as Book).title : '';
  return (
    <div className={`relative ${dims} shrink-0 overflow-hidden rounded bg-elevated`}>
      {src ? (
        <Image
          src={src}
          alt={`Cover of ${title}`}
          fill
          className='object-cover'
          unoptimized
        />
      ) : (
        <div className='flex h-full items-center justify-center text-faint'>
          <BookOpen className='h-4 w-4' />
        </div>
      )}
    </div>
  );
}

function SearchInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <input
      type='search'
      placeholder='Search title or author...'
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={[
        'flex-1 min-w-0 rounded-lg border border-border bg-elevated px-3 py-2',
        'text-sm text-text placeholder-faint',
        'focus:border-accent focus:outline-none focus-visible:ring-1 focus-visible:ring-accent',
      ].join(' ')}
    />
  );
}

function SortSelect<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className={[
        'rounded-lg border border-border bg-elevated px-3 py-2',
        'text-sm text-muted focus:border-accent focus:outline-none focus-visible:ring-1 focus-visible:ring-accent',
      ].join(' ')}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

// ── Read tab ──────────────────────────────────────────────────────────────────

type ReadSort = 'rating-desc' | 'rating-asc' | 'title-asc' | 'date-desc';

const READ_SORT_OPTIONS: { value: ReadSort; label: string }[] = [
  { value: 'rating-desc', label: 'Rating \u2193' },
  { value: 'rating-asc',  label: 'Rating \u2191' },
  { value: 'title-asc',   label: 'Title A\u2013Z' },
  { value: 'date-desc',   label: 'Date read \u2193' },
];

function ReadTab({ books }: { books: Book[] }) {
  const [filterStar, setFilterStar] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<ReadSort>('rating-desc');
  const [editing, setEditing] = useState<Book | null>(null);
  const [queue, setQueue] = useState<Book[] | null>(null);
  const [qIndex, setQIndex] = useState(0);

  const rated   = books.filter((b) => b.effective_rating !== null);
  const unrated = books.filter((b) => b.effective_rating === null);

  function startReviewQueue() {
    if (unrated.length === 0) return;
    setQIndex(0);
    setQueue(unrated);
  }

  function advanceQueue() {
    setQueue((q) => {
      if (!q) return null;
      const next = qIndex + 1;
      if (next >= q.length) return null;
      setQIndex(next);
      return q;
    });
  }

  const filtered = rated
    .filter((b) => (filterStar !== null ? b.effective_rating === filterStar : true))
    .filter((b) => {
      if (!search) return true;
      const q = search.toLowerCase();
      return b.title?.toLowerCase().includes(q) || b.author?.toLowerCase().includes(q);
    })
    .slice()
    .sort((a, b) => {
      switch (sort) {
        case 'rating-desc': return (b.effective_rating ?? 0) - (a.effective_rating ?? 0);
        case 'rating-asc':  return (a.effective_rating ?? 0) - (b.effective_rating ?? 0);
        case 'title-asc':   return (a.title ?? '').localeCompare(b.title ?? '');
        case 'date-desc': {
          if (a.date_read && b.date_read) return b.date_read.localeCompare(a.date_read);
          if (a.date_read) return -1;
          if (b.date_read) return 1;
          return 0;
        }
      }
    });

  return (
    <div className='space-y-5'>
      <div>
        <p className='text-sm text-muted'>
          {rated.length} rated book{rated.length !== 1 ? 's' : ''}
          {unrated.length > 0 && ` · ${unrated.length} unrated`}
        </p>
        {unrated.length > 0 && (
          <Button
            variant='secondary'
            size='sm'
            onClick={startReviewQueue}
            className='mt-3'
          >
            {unrated.length} book{unrated.length !== 1 ? 's' : ''} missing reviews
          </Button>
        )}
      </div>

      {/* Controls row */}
      <div className='flex flex-wrap items-center gap-2'>
        <SearchInput value={search} onChange={setSearch} />
        <SortSelect value={sort} onChange={setSort} options={READ_SORT_OPTIONS} />
        <div className='flex gap-1'>
          {STARS.map((s) => (
            <button
              key={s}
              onClick={() => setFilterStar(filterStar === s ? null : s)}
              aria-label={`Filter by ${s} stars`}
              className={[
                'rounded-md px-3 py-1.5 font-mono text-sm transition',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-base',
                filterStar === s
                  ? 'bg-accent text-base font-semibold'
                  : 'border border-border text-muted hover:border-muted',
              ].join(' ')}
            >
              {'\u2605'.repeat(s)}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className='py-12 text-center text-faint'>No books match your filters.</p>
      ) : (
        <ul className='divide-y divide-hairline'>
          {filtered.map((book) => (
            <li key={book.id}>
              <button
                type='button'
                onClick={() => setEditing(book)}
                className={[
                  'flex w-full items-center gap-4 px-2 py-3 rounded-lg text-left transition',
                  'hover:bg-elevated',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-base',
                ].join(' ')}
              >
                <CoverThumb book={book} size='sm' />
                <div className='min-w-0 flex-1'>
                  <p className='truncate font-medium text-text'>{book.title}</p>
                  <p className='truncate text-sm text-faint'>{book.author}</p>
                </div>
                <div className='shrink-0'>
                  <StarDisplay rating={book.effective_rating} />
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <BookEditModal
          book={editing}
          listKey={READ_KEY}
          allowRemove
          onClose={() => { setEditing(null); void mutate(READ_KEY); }}
        />
      )}

      {queue && queue[qIndex] && (
        <BookEditModal
          book={queue[qIndex]!}
          listKey={READ_KEY}
          queuePosition={{ index: qIndex, total: queue.length }}
          onFinishQueue={advanceQueue}
          onClose={() => { setQueue(null); void mutate(READ_KEY); }}
        />
      )}
    </div>
  );
}

// ── To Read tab ───────────────────────────────────────────────────────────────

type ToReadSort = 'date-desc' | 'date-asc' | 'title-asc';

const TO_READ_SORT_OPTIONS: { value: ToReadSort; label: string }[] = [
  { value: 'date-desc', label: 'Date added \u2193' },
  { value: 'date-asc',  label: 'Date added \u2191' },
  { value: 'title-asc', label: 'Title A\u2013Z' },
];

function ToReadTab({ books }: { books: Book[] }) {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<ToReadSort>('date-desc');
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<Book | null>(null);
  const [removeArmed, setRemoveArmed] = useState<number | null>(null);

  const filtered = books
    .filter((b) => {
      if (!search) return true;
      const q = search.toLowerCase();
      return b.title?.toLowerCase().includes(q) || b.author?.toLowerCase().includes(q);
    })
    .slice()
    .sort((a, b) => {
      switch (sort) {
        case 'date-desc': {
          if (a.date_added && b.date_added) return b.date_added.localeCompare(a.date_added);
          if (a.date_added) return -1;
          if (b.date_added) return 1;
          return (a.title ?? '').localeCompare(b.title ?? '');
        }
        case 'date-asc': {
          if (a.date_added && b.date_added) return a.date_added.localeCompare(b.date_added);
          if (a.date_added) return 1;
          if (b.date_added) return -1;
          return (a.title ?? '').localeCompare(b.title ?? '');
        }
        case 'title-asc': return (a.title ?? '').localeCompare(b.title ?? '');
      }
    });

  async function moveTo(book: Book, shelf: Shelf, thenReview = false) {
    setBusyId(book.id);
    setActionError(null);
    try {
      await api.setBookShelf(book.id, shelf);
      await Promise.all([mutate(TO_READ_KEY), mutate(READ_KEY), mutate(CURRENTLY_READING_KEY), mutate(DNF_KEY)]);
      if (thenReview) setReviewing(book);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to move book.');
    } finally {
      setBusyId(null);
    }
  }

  async function remove(book: Book) {
    setBusyId(book.id);
    setActionError(null);
    try {
      await api.removeBook(book.id);
      await mutate(TO_READ_KEY);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to remove book.');
    } finally {
      setBusyId(null);
      setRemoveArmed(null);
    }
  }

  if (books.length === 0) {
    return (
      <div className='py-16 text-center text-faint'>
        Your to-read shelf is empty. Accept some recommendations to fill it!
      </div>
    );
  }

  return (
    <div className='space-y-5'>
      <div className='flex flex-wrap items-center gap-2'>
        <SearchInput value={search} onChange={setSearch} />
        <SortSelect value={sort} onChange={setSort} options={TO_READ_SORT_OPTIONS} />
      </div>

      {actionError && <p className='text-sm text-danger'>{actionError}</p>}

      {filtered.length === 0 ? (
        <p className='py-12 text-center text-faint'>No books match your search.</p>
      ) : (
        <ul className='space-y-3'>
          {filtered.map((book) => {
            const busy = busyId === book.id;
            const armed = removeArmed === book.id;
            return (
              <li
                key={book.id}
                className='flex gap-4 rounded-xl border border-border bg-surface p-4'
              >
                <CoverThumb book={book} size='md' />
                <div className='min-w-0 flex-1'>
                  <p className='truncate font-semibold text-text'>{book.title}</p>
                  <p className='text-sm text-muted'>{book.author ?? 'Unknown author'}</p>
                  {book.year_published && (
                    <p className='font-mono text-xs text-faint'>{book.year_published}</p>
                  )}
                  <div className='mt-3 flex flex-wrap gap-2'>
                    <button
                      type='button'
                      disabled={busy}
                      onClick={() => moveTo(book, 'currently-reading')}
                      className={[
                        'rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted',
                        'transition hover:border-muted hover:text-text disabled:opacity-50',
                        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                      ].join(' ')}
                    >
                      Start reading
                    </button>
                    <button
                      type='button'
                      disabled={busy}
                      onClick={() => moveTo(book, 'read', true)}
                      className={[
                        'rounded-md border border-success/40 bg-success/10 px-2.5 py-1 text-xs font-medium text-success',
                        'transition hover:bg-success/20 disabled:opacity-50',
                        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-success',
                      ].join(' ')}
                    >
                      Mark finished
                    </button>
                    <button
                      type='button'
                      disabled={busy}
                      onClick={() => moveTo(book, 'did-not-finish')}
                      className={[
                        'rounded-md border border-border px-2.5 py-1 text-xs font-medium text-faint',
                        'transition hover:border-muted hover:text-text disabled:opacity-50',
                        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                      ].join(' ')}
                    >
                      Did not finish
                    </button>
                    {armed ? (
                      <button
                        type='button'
                        disabled={busy}
                        onClick={() => remove(book)}
                        className={[
                          'rounded-md border border-danger/60 bg-danger/10 px-2.5 py-1 text-xs font-semibold text-danger',
                          'transition hover:bg-danger/20 disabled:opacity-50',
                        ].join(' ')}
                      >
                        {busy ? 'Removing...' : 'Confirm remove'}
                      </button>
                    ) : (
                      <button
                        type='button'
                        disabled={busy}
                        onClick={() => setRemoveArmed(book.id)}
                        className={[
                          'rounded-md border border-border px-2.5 py-1 text-xs font-medium text-faint',
                          'transition hover:border-danger/60 hover:text-danger disabled:opacity-50',
                        ].join(' ')}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {reviewing && (
        <BookEditModal
          book={reviewing}
          listKey={READ_KEY}
          onClose={() => { setReviewing(null); void Promise.all([mutate(TO_READ_KEY), mutate(READ_KEY)]); }}
        />
      )}
    </div>
  );
}

// ── Currently Reading tab ─────────────────────────────────────────────────────

type CurrentlyReadingSort = 'date-desc' | 'date-asc' | 'title-asc';

const CURRENTLY_READING_SORT_OPTIONS: { value: CurrentlyReadingSort; label: string }[] = [
  { value: 'date-desc', label: 'Date added \u2193' },
  { value: 'date-asc',  label: 'Date added \u2191' },
  { value: 'title-asc', label: 'Title A\u2013Z' },
];

function CurrentlyReadingTab({ books }: { books: Book[] }) {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<CurrentlyReadingSort>('date-desc');
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<Book | null>(null);

  const filtered = books
    .filter((b) => {
      if (!search) return true;
      const q = search.toLowerCase();
      return b.title?.toLowerCase().includes(q) || b.author?.toLowerCase().includes(q);
    })
    .slice()
    .sort((a, b) => {
      switch (sort) {
        case 'date-desc': {
          if (a.date_added && b.date_added) return b.date_added.localeCompare(a.date_added);
          if (a.date_added) return -1;
          if (b.date_added) return 1;
          return (a.title ?? '').localeCompare(b.title ?? '');
        }
        case 'date-asc': {
          if (a.date_added && b.date_added) return a.date_added.localeCompare(b.date_added);
          if (a.date_added) return 1;
          if (b.date_added) return -1;
          return (a.title ?? '').localeCompare(b.title ?? '');
        }
        case 'title-asc': return (a.title ?? '').localeCompare(b.title ?? '');
      }
    });

  async function moveTo(book: Book, shelf: Shelf, thenReview = false) {
    setBusyId(book.id);
    setActionError(null);
    try {
      await api.setBookShelf(book.id, shelf);
      await Promise.all([mutate(CURRENTLY_READING_KEY), mutate(TO_READ_KEY), mutate(READ_KEY), mutate(DNF_KEY)]);
      if (thenReview) setReviewing(book);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to move book.');
    } finally {
      setBusyId(null);
    }
  }

  if (books.length === 0) {
    return (
      <div className='py-16 text-center text-faint'>
        Nothing in progress. Hit &ldquo;Start reading&rdquo; on a to-read book to track it here.
      </div>
    );
  }

  return (
    <div className='space-y-5'>
      <div className='flex flex-wrap items-center gap-2'>
        <SearchInput value={search} onChange={setSearch} />
        <SortSelect value={sort} onChange={setSort} options={CURRENTLY_READING_SORT_OPTIONS} />
      </div>

      {actionError && <p className='text-sm text-danger'>{actionError}</p>}

      {filtered.length === 0 ? (
        <p className='py-12 text-center text-faint'>No books match your search.</p>
      ) : (
        <ul className='space-y-3'>
          {filtered.map((book) => {
            const busy = busyId === book.id;
            return (
              <li
                key={book.id}
                className='flex gap-4 rounded-xl border border-accent/20 bg-surface p-4'
              >
                <CoverThumb book={book} size='md' />
                <div className='min-w-0 flex-1'>
                  <p className='truncate font-semibold text-text'>{book.title}</p>
                  <p className='text-sm text-muted'>{book.author ?? 'Unknown author'}</p>
                  {book.year_published && (
                    <p className='font-mono text-xs text-faint'>{book.year_published}</p>
                  )}
                  <div className='mt-3 flex flex-wrap gap-2'>
                    <button
                      type='button'
                      disabled={busy}
                      onClick={() => moveTo(book, 'read', true)}
                      className={[
                        'rounded-md border border-success/40 bg-success/10 px-2.5 py-1 text-xs font-medium text-success',
                        'transition hover:bg-success/20 disabled:opacity-50',
                      ].join(' ')}
                    >
                      Mark finished
                    </button>
                    <button
                      type='button'
                      disabled={busy}
                      onClick={() => moveTo(book, 'to-read')}
                      className={[
                        'rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted',
                        'transition hover:border-muted hover:text-text disabled:opacity-50',
                      ].join(' ')}
                    >
                      Put back
                    </button>
                    <button
                      type='button'
                      disabled={busy}
                      onClick={() => moveTo(book, 'did-not-finish')}
                      className={[
                        'rounded-md border border-border px-2.5 py-1 text-xs font-medium text-faint',
                        'transition hover:border-muted hover:text-text disabled:opacity-50',
                        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                      ].join(' ')}
                    >
                      Did not finish
                    </button>
                  </div>
                </div>
                <Badge variant='accent'>reading</Badge>
              </li>
            );
          })}
        </ul>
      )}

      {reviewing && (
        <BookEditModal
          book={reviewing}
          listKey={READ_KEY}
          onClose={() => { setReviewing(null); void Promise.all([mutate(CURRENTLY_READING_KEY), mutate(READ_KEY)]); }}
        />
      )}
    </div>
  );
}

// ── Did Not Finish tab ────────────────────────────────────────────────────────

type DnfSort = 'date-desc' | 'title-asc';

const DNF_SORT_OPTIONS: { value: DnfSort; label: string }[] = [
  { value: 'date-desc', label: 'Date added \u2193' },
  { value: 'title-asc', label: 'Title A\u2013Z' },
];

function DnfTab({ books }: { books: Book[] }) {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<DnfSort>('date-desc');
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [addingNote, setAddingNote] = useState<Book | null>(null);
  const [reviewing, setReviewing] = useState<Book | null>(null);
  const [removeArmed, setRemoveArmed] = useState<number | null>(null);

  const filtered = books
    .filter((b) => {
      if (!search) return true;
      const q = search.toLowerCase();
      return b.title?.toLowerCase().includes(q) || b.author?.toLowerCase().includes(q);
    })
    .slice()
    .sort((a, b) => {
      switch (sort) {
        case 'date-desc': {
          if (a.date_added && b.date_added) return b.date_added.localeCompare(a.date_added);
          if (a.date_added) return -1;
          if (b.date_added) return 1;
          return (a.title ?? '').localeCompare(b.title ?? '');
        }
        case 'title-asc': return (a.title ?? '').localeCompare(b.title ?? '');
      }
    });

  async function moveTo(book: Book, shelf: Shelf, thenReview = false) {
    setBusyId(book.id);
    setActionError(null);
    try {
      await api.setBookShelf(book.id, shelf);
      await Promise.all([mutate(DNF_KEY), mutate(TO_READ_KEY), mutate(READ_KEY), mutate(CURRENTLY_READING_KEY)]);
      if (thenReview) setReviewing(book);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to move book.');
    } finally {
      setBusyId(null);
    }
  }

  async function remove(book: Book) {
    setBusyId(book.id);
    setActionError(null);
    try {
      await api.removeBook(book.id);
      await mutate(DNF_KEY);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to remove book.');
    } finally {
      setBusyId(null);
      setRemoveArmed(null);
    }
  }

  if (books.length === 0) {
    return (
      <div className='py-16 text-center text-faint'>
        No abandoned books yet. Move a book here from Currently Reading or To Read.
      </div>
    );
  }

  return (
    <div className='space-y-5'>
      <div className='flex flex-wrap items-center gap-2'>
        <SearchInput value={search} onChange={setSearch} />
        <SortSelect value={sort} onChange={setSort} options={DNF_SORT_OPTIONS} />
      </div>

      {actionError && <p className='text-sm text-danger'>{actionError}</p>}

      {filtered.length === 0 ? (
        <p className='py-12 text-center text-faint'>No books match your search.</p>
      ) : (
        <ul className='space-y-3'>
          {filtered.map((book) => {
            const busy = busyId === book.id;
            const armed = removeArmed === book.id;
            return (
              <li
                key={book.id}
                className='flex gap-4 rounded-xl border border-border bg-surface p-4'
              >
                <CoverThumb book={book} size='md' />
                <div className='min-w-0 flex-1'>
                  <p className='truncate font-semibold text-text'>{book.title}</p>
                  <p className='text-sm text-muted'>{book.author ?? 'Unknown author'}</p>
                  {book.app_review && (
                    <p className='mt-1 text-xs text-faint line-clamp-2 italic'>{book.app_review}</p>
                  )}
                  <div className='mt-3 flex flex-wrap gap-2'>
                    <button
                      type='button'
                      disabled={busy}
                      onClick={() => moveTo(book, 'to-read')}
                      className={[
                        'rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted',
                        'transition hover:border-muted hover:text-text disabled:opacity-50',
                        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                      ].join(' ')}
                    >
                      Try again
                    </button>
                    <button
                      type='button'
                      disabled={busy}
                      onClick={() => moveTo(book, 'read', true)}
                      className={[
                        'rounded-md border border-success/40 bg-success/10 px-2.5 py-1 text-xs font-medium text-success',
                        'transition hover:bg-success/20 disabled:opacity-50',
                        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-success',
                      ].join(' ')}
                    >
                      Finished it
                    </button>
                    <button
                      type='button'
                      disabled={busy}
                      onClick={() => setAddingNote(book)}
                      className={[
                        'rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted',
                        'transition hover:border-muted hover:text-text disabled:opacity-50',
                        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                      ].join(' ')}
                    >
                      {book.app_review ? 'Edit note' : 'Add note'}
                    </button>
                    {armed ? (
                      <button
                        type='button'
                        disabled={busy}
                        onClick={() => remove(book)}
                        className={[
                          'rounded-md border border-danger/60 bg-danger/10 px-2.5 py-1 text-xs font-semibold text-danger',
                          'transition hover:bg-danger/20 disabled:opacity-50',
                        ].join(' ')}
                      >
                        {busy ? 'Removing...' : 'Confirm remove'}
                      </button>
                    ) : (
                      <button
                        type='button'
                        disabled={busy}
                        onClick={() => setRemoveArmed(book.id)}
                        className={[
                          'rounded-md border border-border px-2.5 py-1 text-xs font-medium text-faint',
                          'transition hover:border-danger/60 hover:text-danger disabled:opacity-50',
                        ].join(' ')}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {addingNote && (
        <BookEditModal
          book={addingNote}
          listKey={DNF_KEY}
          allowReviewWithoutRating
          onClose={() => { setAddingNote(null); void mutate(DNF_KEY); }}
        />
      )}

      {reviewing && (
        <BookEditModal
          book={reviewing}
          listKey={READ_KEY}
          onClose={() => { setReviewing(null); void Promise.all([mutate(DNF_KEY), mutate(READ_KEY)]); }}
        />
      )}
    </div>
  );
}

// ── Rejected tab ──────────────────────────────────────────────────────────────

type RejectedSort = 'date-desc' | 'title-asc';

const REJECTED_SORT_OPTIONS: { value: RejectedSort; label: string }[] = [
  { value: 'date-desc', label: 'Date skipped \u2193' },
  { value: 'title-asc', label: 'Title A\u2013Z' },
];

function RejectedTab({ recs }: { recs: Recommendation[] }) {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<RejectedSort>('date-desc');
  const [editingNote, setEditingNote] = useState<Recommendation | null>(null);
  const [noteText, setNoteText] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);

  function openNoteModal(rec: Recommendation) {
    setEditingNote(rec);
    setNoteText(rec.user_note ?? '');
    setNoteError(null);
  }

  async function saveNote() {
    if (!editingNote) return;
    setSavingNote(true);
    setNoteError(null);
    try {
      await api.feedback(editingNote.id, { user_note: noteText.trim() || null });
      await mutate(REJECTED_KEY);
      setEditingNote(null);
    } catch (e) {
      setNoteError(e instanceof Error ? e.message : 'Failed to save note.');
    } finally {
      setSavingNote(false);
    }
  }

  const filtered = recs
    .filter((r) => {
      if (!search) return true;
      const q = search.toLowerCase();
      return r.title?.toLowerCase().includes(q) || r.author?.toLowerCase().includes(q);
    })
    .slice()
    .sort((a, b) => {
      switch (sort) {
        case 'date-desc': return b.created_at.localeCompare(a.created_at);
        case 'title-asc': return (a.title ?? '').localeCompare(b.title ?? '');
      }
    });

  if (recs.length === 0) {
    return (
      <div className='py-16 text-center text-faint'>
        No rejected recommendations yet.
      </div>
    );
  }

  return (
    <div className='space-y-5'>
      <div className='flex flex-wrap items-center gap-2'>
        <SearchInput value={search} onChange={setSearch} />
        <SortSelect value={sort} onChange={setSort} options={REJECTED_SORT_OPTIONS} />
      </div>

      {filtered.length === 0 ? (
        <p className='py-12 text-center text-faint'>No results match your search.</p>
      ) : (
        <ul className='space-y-3'>
          {filtered.map((rec) => (
            <li
              key={rec.id}
              className='flex gap-4 rounded-xl border border-border bg-surface p-4'
            >
              <div className='relative h-16 w-11 shrink-0 overflow-hidden rounded-md bg-elevated'>
                {rec.cover_url ? (
                  <Image
                    src={rec.cover_url}
                    alt={`Cover of ${rec.title}`}
                    fill
                    className='object-cover'
                    unoptimized
                  />
                ) : (
                  <div className='flex h-full items-center justify-center text-faint'>
                    <BookOpen className='h-4 w-4' />
                  </div>
                )}
              </div>
              <div className='min-w-0 flex-1'>
                <p className='truncate font-semibold text-text'>{rec.title}</p>
                <p className='text-sm text-muted'>
                  {rec.author ?? 'Unknown author'}
                  {rec.year ? ` · ${rec.year}` : ''}
                </p>
                {rec.user_note && (
                  <p className='mt-1 text-xs text-faint line-clamp-2 italic'>{rec.user_note}</p>
                )}
                {!rec.user_note && rec.rationale && (
                  <p className='mt-1 text-xs text-faint line-clamp-2'>{rec.rationale}</p>
                )}
                <div className='mt-3'>
                  <button
                    type='button'
                    onClick={() => openNoteModal(rec)}
                    className={[
                      'rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted',
                      'transition hover:border-muted hover:text-text',
                      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                    ].join(' ')}
                  >
                    {rec.user_note ? 'Edit note' : 'Add note'}
                  </button>
                </div>
              </div>
              <Badge variant='danger'>skipped</Badge>
            </li>
          ))}
        </ul>
      )}

      {editingNote && (
        <Modal
          labelId='rejection-note-title'
          onClose={() => setEditingNote(null)}
          className='w-full max-w-md rounded-2xl border border-border bg-surface p-6'
        >
          <div className='space-y-4'>
            <h2 id='rejection-note-title' className='text-base font-semibold text-text'>
              {editingNote.user_note ? 'Edit rejection note' : 'Add rejection note'}
            </h2>
            <p className='text-sm text-muted'>
              Why did you skip <span className='font-semibold text-text'>{editingNote.title}</span>? This helps the recommender learn your taste.
            </p>
            <textarea
              className={[
                'w-full rounded-lg border border-border bg-elevated px-3 py-2',
                'text-sm text-text placeholder:text-faint',
                'focus:outline-none focus:ring-1 focus:ring-accent',
                'resize-none',
              ].join(' ')}
              rows={3}
              placeholder='e.g. Not a fan of this genre, already read something similar...'
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              autoFocus
            />
            {noteError && <p className='text-xs text-danger'>{noteError}</p>}
            <div className='flex justify-end gap-2'>
              <Button variant='ghost' size='sm' onClick={() => setEditingNote(null)}>
                Cancel
              </Button>
              <Button size='sm' loading={savingNote} onClick={saveNote}>
                Save
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Inner page (reads searchParams) ──────────────────────────────────────────

function LibraryInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const rawTab = searchParams.get('tab') ?? 'read';
  const activeTab: Tab = (
    ['read', 'to-read', 'currently-reading', 'did-not-finish', 'rejected'] as const
  ).includes(rawTab as Tab)
    ? (rawTab as Tab)
    : 'read';

  const [adding, setAdding] = useState(false);

  function setTab(tab: Tab) {
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', tab);
    router.replace(`/library?${params.toString()}`);
  }

  async function handleAdded(book: Book) {
    setAdding(false);
    setTab((book.exclusive_shelf as Tab) ?? 'read');
    await Promise.all([
      mutate(READ_KEY),
      mutate(TO_READ_KEY),
      mutate(CURRENTLY_READING_KEY),
      mutate(DNF_KEY),
      mutate(PROFILE_STATUS_KEY),
      mutate('stats', api.stats(), { revalidate: false }),
    ]);
  }

  const { data: readBooks = [], isLoading: readLoading } = useSWR<Book[]>(
    READ_KEY,
    () => api.books({ shelf: 'read', limit: 500 })
  );
  const { data: toReadBooks = [], isLoading: toReadLoading } = useSWR<Book[]>(
    TO_READ_KEY,
    () => api.books({ shelf: 'to-read', limit: 500 })
  );
  const { data: currentlyReadingBooks = [], isLoading: currentlyReadingLoading } = useSWR<Book[]>(
    CURRENTLY_READING_KEY,
    () => api.books({ shelf: 'currently-reading', limit: 500 })
  );
  const { data: dnfBooks = [], isLoading: dnfLoading } = useSWR<Book[]>(
    DNF_KEY,
    () => api.books({ shelf: 'did-not-finish', limit: 500 })
  );
  const { data: rejectedRecs = [], isLoading: recsLoading } = useSWR<Recommendation[]>(
    REJECTED_KEY,
    () => api.rejectedRecs()
  );

  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: 'read',              label: 'Read',              count: readBooks.length },
    { id: 'currently-reading', label: 'Currently Reading', count: currentlyReadingBooks.length },
    { id: 'to-read',           label: 'To Read',           count: toReadBooks.length },
    { id: 'did-not-finish',    label: 'Did Not Finish',    count: dnfBooks.length },
    { id: 'rejected',          label: 'Rejected',          count: rejectedRecs.length },
  ];

  const isLoading =
    readLoading ||
    toReadLoading ||
    currentlyReadingLoading ||
    (activeTab === 'did-not-finish' && dnfLoading) ||
    (activeTab === 'rejected' && recsLoading);

  return (
    <div className='fade-in space-y-6 py-6'>
      <div className='flex items-center justify-between gap-3'>
        <h1 className='font-display text-3xl font-bold tracking-tight text-text'>My Library</h1>
        <Button onClick={() => setAdding(true)}>+ Add book</Button>
      </div>

      {adding && (
        <AddBookModal onAdded={handleAdded} onClose={() => setAdding(false)} />
      )}

      {/* Tab bar */}
      <div className='flex gap-1 rounded-xl border border-border bg-elevated p-1'>
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            aria-current={activeTab === t.id ? 'true' : undefined}
            className={[
              'flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-elevated',
              activeTab === t.id
                ? 'bg-surface text-text shadow'
                : 'text-muted hover:text-text',
            ].join(' ')}
          >
            {t.label}
            {t.count > 0 && (
              <span
                className={[
                  'rounded-full px-1.5 py-0.5 font-mono text-xs',
                  activeTab === t.id ? 'bg-elevated text-muted' : 'bg-surface text-faint',
                ].join(' ')}
              >
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className='space-y-3'>
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className='h-20 rounded-xl border border-border bg-surface motion-safe:animate-pulse'
            />
          ))}
        </div>
      ) : (
        <>
          {activeTab === 'read'              && <ReadTab              books={readBooks} />}
          {activeTab === 'currently-reading' && <CurrentlyReadingTab  books={currentlyReadingBooks} />}
          {activeTab === 'to-read'           && <ToReadTab            books={toReadBooks} />}
          {activeTab === 'did-not-finish'    && <DnfTab               books={dnfBooks} />}
          {activeTab === 'rejected'          && <RejectedTab          recs={rejectedRecs} />}
        </>
      )}
    </div>
  );
}

// ── Page export (Suspense wraps useSearchParams) ──────────────────────────────

export default function LibraryPage() {
  return (
    <Suspense
      fallback={
        <div className='fade-in space-y-6 py-6'>
          <h1 className='font-display text-3xl font-bold tracking-tight text-text'>My Library</h1>
          <div className='space-y-3'>
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className='h-20 rounded-xl border border-border bg-surface motion-safe:animate-pulse'
              />
            ))}
          </div>
        </div>
      }
    >
      <LibraryInner />
    </Suspense>
  );
}
