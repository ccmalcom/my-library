'use client';

import Image from 'next/image';
import { ExternalLink, BookOpen, X } from 'lucide-react';
import { useState } from 'react';
import { Modal } from '@/components/ui';
import { bookLinks } from '@/lib/bookLinks';
import type { Book, Shelf } from '@/lib/api';

interface Props {
  book: Book;
  onClose: () => void;
  onMove: (book: Book, shelf: Shelf, thenReview?: boolean) => void;
  onRemove: (book: Book) => void;
  busy?: boolean;
}

const LABEL_ID = 'book-detail-modal-title';

export default function BookDetailModal({ book, onClose, onMove, onRemove, busy = false }: Props) {
  const [removeArmed, setRemoveArmed] = useState(false);

  const links = bookLinks({ title: book.title, author: book.author, isbn13: book.isbn13 });

  const meta: string[] = [];
  if (book.year_published) meta.push(String(book.year_published));
  if (book.page_count) meta.push(`${book.page_count} pages`);

  function handleMove(shelf: Shelf, thenReview = false) {
    onMove(book, shelf, thenReview);
    onClose();
  }

  function handleRemove() {
    onRemove(book);
    onClose();
  }

  return (
    <Modal
      labelId={LABEL_ID}
      onClose={onClose}
      className={[
        'relative w-full max-w-lg rounded-2xl border border-border bg-surface shadow-xl',
        'flex flex-col max-h-[85vh]',
      ].join(' ')}
    >
      {/* Close button */}
      <button
        type='button'
        onClick={onClose}
        aria-label='Close'
        className={[
          'absolute right-4 top-4 rounded-full p-1 text-faint',
          'hover:bg-elevated hover:text-text',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
        ].join(' ')}
      >
        <X className='h-4 w-4' />
      </button>

      {/* Scrollable body */}
      <div className='overflow-y-auto p-4 sm:p-6'>
        {/* Header: cover + metadata */}
        <div className='flex flex-col items-center gap-4 sm:flex-row sm:items-start'>
          {/* Cover */}
          <div className='relative h-40 w-28 shrink-0 overflow-hidden rounded-lg bg-elevated'>
            {book.cover_url ? (
              <Image
                src={book.cover_url}
                alt={`Cover of ${book.title}`}
                fill
                className='object-cover'
                unoptimized
              />
            ) : (
              <div className='flex h-full items-center justify-center text-faint'>
                <BookOpen className='h-8 w-8' />
              </div>
            )}
          </div>

          {/* Title / author / meta */}
          <div className='min-w-0 text-center sm:text-left'>
            <h2
              id={LABEL_ID}
              className='font-display text-xl font-semibold leading-snug text-text'
            >
              {book.title}
            </h2>
            <p className='mt-1 text-sm text-muted'>
              {book.author ?? 'Unknown author'}
            </p>
            {meta.length > 0 && (
              <p className='mt-1 font-mono text-xs text-faint'>
                {meta.join(' \u00B7 ')}
              </p>
            )}
          </div>
        </div>

        {/* Description */}
        <div className='mt-5'>
          {book.description ? (
            <p className='text-sm leading-relaxed text-muted'>{book.description}</p>
          ) : (
            <p className='text-sm text-faint italic'>No description available.</p>
          )}
        </div>

        {/* External links */}
        <div className='mt-5 flex flex-wrap gap-2'>
          {links.map((link) => (
            <a
              key={link.label}
              href={link.href}
              target='_blank'
              rel='noopener noreferrer'
              className={[
                'inline-flex items-center gap-1.5 rounded-full border border-border',
                'px-3 py-1 text-xs font-medium text-muted',
                'hover:border-muted hover:text-text transition',
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
              ].join(' ')}
            >
              {link.label}
              <ExternalLink className='h-3 w-3' />
            </a>
          ))}
        </div>

        {/* Shelf actions */}
        <div className='mt-6 flex flex-wrap gap-2 border-t border-border pt-5'>
          <button
            type='button'
            disabled={busy}
            onClick={() => handleMove('currently-reading')}
            className={[
              'rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted',
              'transition hover:border-muted hover:text-text disabled:opacity-50',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
            ].join(' ')}
          >
            Start reading
          </button>
          <button
            type='button'
            disabled={busy}
            onClick={() => handleMove('read', true)}
            className={[
              'rounded-md border border-success/40 bg-success/10 px-3 py-1.5 text-xs font-medium text-success',
              'transition hover:bg-success/20 disabled:opacity-50',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-success',
            ].join(' ')}
          >
            Mark finished
          </button>
          <button
            type='button'
            disabled={busy}
            onClick={() => handleMove('did-not-finish')}
            className={[
              'rounded-md border border-border px-3 py-1.5 text-xs font-medium text-faint',
              'transition hover:border-muted hover:text-text disabled:opacity-50',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
            ].join(' ')}
          >
            Did not finish
          </button>
          {removeArmed ? (
            <button
              type='button'
              disabled={busy}
              onClick={handleRemove}
              className={[
                'rounded-md border border-danger/60 bg-danger/10 px-3 py-1.5 text-xs font-semibold text-danger',
                'transition hover:bg-danger/20 disabled:opacity-50',
              ].join(' ')}
            >
              {busy ? 'Removing...' : 'Confirm remove'}
            </button>
          ) : (
            <button
              type='button'
              disabled={busy}
              onClick={() => setRemoveArmed(true)}
              className={[
                'rounded-md border border-border px-3 py-1.5 text-xs font-medium text-faint',
                'transition hover:border-danger/60 hover:text-danger disabled:opacity-50',
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
              ].join(' ')}
            >
              Remove
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
