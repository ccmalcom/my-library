"use client";

import { useState } from "react";
import Image from "next/image";
import useSWR, { mutate } from "swr";
import { api, type Book, type Shelf } from "@/lib/api";
import BookEditModal from "@/components/BookEditModal";

const TO_READ_KEY = "books-to-read";
const LIBRARY_KEY = "books-library";

export default function ToReadPage() {
  const { data: books, isLoading, error } = useSWR<Book[]>(
    TO_READ_KEY,
    () => api.books({ shelf: "to-read", limit: 500 })
  );

  // Book to prompt a review for after it's marked finished.
  const [reviewing, setReviewing] = useState<Book | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function refreshLists() {
    await Promise.all([mutate(TO_READ_KEY), mutate(LIBRARY_KEY)]);
  }

  async function moveTo(book: Book, shelf: Shelf, thenReview = false) {
    setBusyId(book.id);
    setActionError(null);
    try {
      await api.setBookShelf(book.id, shelf);
      await refreshLists();
      if (thenReview) setReviewing(book);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Failed to move book.");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(book: Book) {
    if (!window.confirm(`Remove “${book.title}” from your to-read shelf?`)) return;
    setBusyId(book.id);
    setActionError(null);
    try {
      await api.removeBook(book.id);
      await mutate(TO_READ_KEY);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Failed to remove book.");
    } finally {
      setBusyId(null);
    }
  }

  if (isLoading) {
    return (
      <div className="fade-in grid gap-3 py-6 sm:grid-cols-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="h-24 animate-pulse rounded-xl border border-slate-700 bg-[#1a1f2e]"
          />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-12 text-center text-red-400">
        Failed to load shelf: {String(error)}
      </div>
    );
  }

  const sorted = (books ?? []).slice().sort((a, b) => {
    // Newest added first; fall back to title
    if (a.date_added && b.date_added) return b.date_added.localeCompare(a.date_added);
    if (a.date_added) return -1;
    if (b.date_added) return 1;
    return (a.title ?? "").localeCompare(b.title ?? "");
  });

  return (
    <div className="fade-in space-y-6 py-6">
      <div>
        <h1 className="text-3xl font-bold text-white">To Read</h1>
        <p className="mt-1 text-slate-400">
          {sorted.length} book{sorted.length !== 1 ? "s" : ""} on your shelf
        </p>
      </div>

      {actionError && <p className="text-sm text-red-400">{actionError}</p>}

      {sorted.length === 0 ? (
        <div className="py-16 text-center text-slate-500">
          Your to-read shelf is empty. Accept some recommendations to fill it!
        </div>
      ) : (
        <ul className="space-y-3">
          {sorted.map((book) => {
            const busy = busyId === book.id;
            return (
              <li
                key={book.id}
                className="flex gap-4 rounded-xl border border-slate-700 bg-[#1a1f2e] p-4"
              >
                {/* Cover */}
                <div className="relative h-20 w-14 shrink-0 overflow-hidden rounded-md bg-slate-800">
                  {book.cover_url ? (
                    <Image
                      src={book.cover_url}
                      alt={`Cover of ${book.title}`}
                      fill
                      className="object-cover"
                      unoptimized
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-2xl text-slate-600">
                      📚
                    </div>
                  )}
                </div>

                {/* Info + actions */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-white">{book.title}</p>
                      <p className="text-sm text-slate-400">
                        {book.author ?? "Unknown author"}
                      </p>
                      {book.year_published && (
                        <p className="text-xs text-slate-500">{book.year_published}</p>
                      )}
                    </div>
                    {book.confidence_label === "RECOMMENDATION" && (
                      <span className="shrink-0 rounded-full border border-blue-700 bg-blue-900/50 px-2 py-0.5 text-xs text-blue-300">
                        AI pick
                      </span>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => moveTo(book, "currently-reading")}
                      className="rounded-md border border-slate-600 px-2.5 py-1 text-xs font-medium text-slate-300 transition hover:border-slate-400 hover:text-white disabled:opacity-50"
                    >
                      Start reading
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => moveTo(book, "read", true)}
                      className="rounded-md border border-green-700 bg-green-900/30 px-2.5 py-1 text-xs font-medium text-green-300 transition hover:bg-green-900/60 disabled:opacity-50"
                    >
                      Mark finished
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => remove(book)}
                      className="rounded-md border border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-500 transition hover:border-red-700 hover:text-red-300 disabled:opacity-50"
                    >
                      Remove
                    </button>
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
          listKey={LIBRARY_KEY}
          onClose={() => setReviewing(null)}
        />
      )}
    </div>
  );
}
