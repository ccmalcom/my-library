'use client';

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { BookOpen } from 'lucide-react';
import { api, type Book, type CatalogResult, type Shelf } from '@/lib/api';
import { Button, Modal, useToast } from '@/components/ui';

interface Props {
  onAdded: (book: Book) => void;
  onClose: () => void;
  defaultShelf?: Shelf;
}

const SHELF_OPTIONS: { value: Shelf; label: string }[] = [
  { value: 'read', label: 'Read' },
  { value: 'currently-reading', label: 'Reading' },
  { value: 'to-read', label: 'To read' },
  { value: 'did-not-finish', label: 'Did not finish' },
];

const inputClass = [
  'w-full rounded-lg border border-border bg-base px-3 py-2 text-sm text-text',
  'placeholder-faint focus:border-accent focus:outline-none',
  'focus-visible:ring-1 focus-visible:ring-accent',
].join(' ');

export default function AddBookModal({ onAdded, onClose, defaultShelf = 'read' }: Props) {
  const toast = useToast();

  const [query, setQuery]           = useState('');
  const [results, setResults]       = useState<CatalogResult[]>([]);
  const [searching, setSearching]   = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [selected, setSelected]     = useState<CatalogResult | null>(null);
  const [shelf, setShelf]           = useState<Shelf>(defaultShelf);
  const [rating, setRating]         = useState(0);
  const [hover, setHover]           = useState(0);
  const [review, setReview]         = useState('');
  const [saving, setSaving]         = useState(false);

  const reqId = useRef(0);
  useEffect(() => {
    const q = query.trim();
    if (selected) return;
    if (q.length < 2) { setResults([]); setSearching(false); return; }
    setSearching(true);
    setSearchError(null);
    const id = ++reqId.current;
    const t = setTimeout(async () => {
      try {
        const hits = await api.catalogSearch(q);
        if (id === reqId.current) setResults(hits);
      } catch (e) {
        if (id === reqId.current) {
          setSearchError(e instanceof Error ? e.message : 'Search failed.');
          setResults([]);
        }
      } finally {
        if (id === reqId.current) setSearching(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [query, selected]);

  async function handleAdd() {
    if (!selected) return;
    setSaving(true);
    try {
      const book = await api.addBook({
        title: selected.title,
        author: selected.author,
        year: selected.year,
        isbn13: selected.isbn13,
        shelf,
        rating: rating > 0 ? rating : undefined,
        review: review.trim() || undefined,
        cover_url: selected.cover_url,
        subjects: selected.subjects,
        catalog_source: selected.source,
        catalog_id: selected.catalog_id,
      });
      toast.success(`${selected.title} added to library.`);
      onAdded(book);
    } catch (e) {
      const raw = e instanceof Error ? e.message : 'Failed to add book.';
      const msg = raw.includes('409') ? 'That book is already in your library.' : raw;
      toast.error(msg);
      setSaving(false);
    }
  }

  const shownStars = hover || rating;
  const reviewWithoutRating = review.trim() !== '' && rating === 0;

  return (
    <Modal
      labelId='add-book-title'
      onClose={onClose}
      className='fade-in flex max-h-[85vh] w-full max-w-md flex-col rounded-2xl border border-border bg-surface p-6 shadow-2xl'
    >
      <h2 id='add-book-title' className='mb-4 font-display text-lg font-bold text-text'>
        Add a book
      </h2>

      {!selected ? (
        <>
          <input
            autoFocus
            type='search'
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder='Search by title, author, or ISBN...'
            className={inputClass}
          />

          <div className='mt-4 min-h-[120px] flex-1 overflow-y-auto'>
            {searching && (
              <p className='py-8 text-center text-sm text-muted'>Searching...</p>
            )}
            {searchError && <p className='py-4 text-sm text-danger'>{searchError}</p>}
            {!searching && !searchError && query.trim().length >= 2 && results.length === 0 && (
              <p className='py-8 text-center text-sm text-muted'>
                No matches. Try a different spelling.
              </p>
            )}
            {!searching && query.trim().length < 2 && (
              <p className='py-8 text-center text-sm text-faint'>
                Type at least 2 characters to search.
              </p>
            )}
            <ul className='space-y-1'>
              {results.map((r, i) => (
                <li key={`${r.source}-${r.catalog_id ?? i}`}>
                  <button
                    type='button'
                    onClick={() => { setSelected(r); }}
                    className={[
                      'flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition',
                      'hover:bg-elevated',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface',
                    ].join(' ')}
                  >
                    <div className='relative h-14 w-10 shrink-0 overflow-hidden rounded bg-elevated'>
                      {r.cover_url ? (
                        <Image
                          src={r.cover_url}
                          alt={`Cover of ${r.title}`}
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
                      <p className='truncate text-sm font-medium text-text'>{r.title}</p>
                      <p className='truncate text-xs text-faint'>
                        {r.author ?? 'Unknown author'}
                        {r.year ? ` · ${r.year}` : ''}
                      </p>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className='mt-4 flex justify-end'>
            <Button variant='ghost' onClick={onClose}>Cancel</Button>
          </div>
        </>
      ) : (
        <>
          {/* Selected book */}
          <div className='flex items-center gap-3 rounded-xl border border-border bg-elevated p-3'>
            <div className='relative h-16 w-11 shrink-0 overflow-hidden rounded bg-surface'>
              {selected.cover_url ? (
                <Image
                  src={selected.cover_url}
                  alt={`Cover of ${selected.title}`}
                  fill
                  className='object-cover'
                  unoptimized
                />
              ) : (
                <div className='flex h-full items-center justify-center text-faint'>
                  <BookOpen className='h-5 w-5' />
                </div>
              )}
            </div>
            <div className='min-w-0 flex-1'>
              <p className='truncate font-semibold text-text'>{selected.title}</p>
              <p className='truncate text-sm text-muted'>
                {selected.author ?? 'Unknown author'}
                {selected.year ? ` · ${selected.year}` : ''}
              </p>
            </div>
            <button
              type='button'
              onClick={() => { setSelected(null); setRating(0); setReview(''); }}
              className='shrink-0 text-xs text-faint hover:text-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent rounded'
            >
              Change
            </button>
          </div>

          {/* Shelf */}
          <div className='mt-5'>
            <span className='mb-2 block font-mono text-xs font-semibold uppercase tracking-widest text-muted'>
              Shelf
            </span>
            <div className='flex gap-1 rounded-lg border border-border bg-elevated p-1'>
              {SHELF_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type='button'
                  onClick={() => setShelf(o.value)}
                  className={[
                    'flex-1 rounded-md px-2 py-1.5 text-sm font-medium transition',
                    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                    shelf === o.value ? 'bg-surface text-text shadow' : 'text-muted hover:text-text',
                  ].join(' ')}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          {/* Optional rating */}
          <div className='mt-5'>
            <div className='mb-2 flex items-center justify-between'>
              <span className='font-mono text-xs font-semibold uppercase tracking-widest text-muted'>
                Your rating{' '}
                <span className='font-normal normal-case text-faint'>· optional</span>
              </span>
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
                  className='text-3xl leading-none transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent rounded'
                  aria-label={`${n} star${n > 1 ? 's' : ''}`}
                >
                  <span className={n <= shownStars ? 'text-accent' : 'text-faint'} aria-hidden='true'>
                    ★
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Optional review */}
          <div className='mt-5'>
            <label className='mb-2 block font-mono text-xs font-semibold uppercase tracking-widest text-muted'>
              Review{' '}
              <span className='font-normal normal-case text-faint'>· optional</span>
            </label>
            <textarea
              value={review}
              onChange={(e) => setReview(e.target.value)}
              rows={3}
              placeholder='What did you think? Your words feed the taste profile...'
              className={[inputClass, 'resize-y'].join(' ')}
            />
            {reviewWithoutRating && (
              <p className='mt-1 text-xs text-warning'>
                Add a star rating above to save your review.
              </p>
            )}
          </div>

          <div className='mt-6 flex justify-end gap-2'>
            <Button variant='ghost' onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button
              onClick={handleAdd}
              loading={saving}
              disabled={saving || reviewWithoutRating}
            >
              {saving ? 'Adding...' : 'Add to library'}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
