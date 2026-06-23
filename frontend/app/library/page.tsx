"use client";

import { useState } from "react";
import useSWR from "swr";
import { api, type Book } from "@/lib/api";
import BookEditModal from "@/components/BookEditModal";

const STARS = [5, 4, 3, 2, 1] as const;
const LIBRARY_KEY = "books-library";

function StarRating({ rating }: { rating: number | null }) {
  if (!rating) return <span className="text-xs text-slate-600">unrated</span>;
  return (
    <span className="text-sm text-amber-400">
      {"★".repeat(rating)}
      <span className="text-slate-600">{"★".repeat(5 - rating)}</span>
    </span>
  );
}

export default function LibraryPage() {
  const [filterStar, setFilterStar] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Book | null>(null);
  // Step-through queue for read books that still need a rating/review.
  const [queue, setQueue] = useState<Book[] | null>(null);
  const [qIndex, setQIndex] = useState(0);

  const { data: books, isLoading, error } = useSWR<Book[]>(
    LIBRARY_KEY,
    () => api.books({ limit: 500 })
  );

  if (isLoading) {
    return (
      <div className="fade-in space-y-2 py-6">
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="h-14 animate-pulse rounded-lg border border-slate-700 bg-[#1a1f2e]"
          />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-12 text-center text-red-400">
        Failed to load library: {String(error)}
      </div>
    );
  }

  const rated = (books ?? []).filter(
    (b) => b.exclusive_shelf === "read" && b.effective_rating !== null
  );

  // Read books with no rating yet (e.g. landed via "already read" on the swipe screen).
  const unrated = (books ?? []).filter(
    (b) => b.exclusive_shelf === "read" && b.effective_rating === null
  );

  function startReviewQueue() {
    if (unrated.length === 0) return;
    setQIndex(0);
    setQueue(unrated);
  }

  function advanceQueue() {
    setQueue((q) => {
      if (!q) return null;
      const next = qIndex + 1;
      if (next >= q.length) return null; // done
      setQIndex(next);
      return q;
    });
  }

  const filtered = rated
    .filter((b) => (filterStar !== null ? b.effective_rating === filterStar : true))
    .filter((b) => {
      if (!search) return true;
      const q = search.toLowerCase();
      return (
        b.title?.toLowerCase().includes(q) ||
        b.author?.toLowerCase().includes(q)
      );
    })
    .sort((a, b) => (b.effective_rating ?? 0) - (a.effective_rating ?? 0));

  return (
    <div className="fade-in space-y-6 py-6">
      <div>
        <h1 className="text-3xl font-bold text-white">Library</h1>
        <p className="mt-1 text-slate-400">
          {rated.length} rated book{rated.length !== 1 ? "s" : ""}
        </p>
        {unrated.length > 0 && (
          <button
            type="button"
            onClick={startReviewQueue}
            className="mt-3 inline-flex items-center gap-2 rounded-lg border border-blue-700 bg-blue-900/30 px-3.5 py-1.5 text-sm font-semibold text-blue-200 transition hover:bg-blue-900/60 active:scale-95"
          >
            ✎ {unrated.length} book{unrated.length !== 1 ? "s" : ""} missing reviews
          </button>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          placeholder="Search title or author…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 min-w-48 rounded-lg border border-slate-700 bg-[#1a1f2e] px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:border-blue-600 focus:outline-none"
        />
        <div className="flex gap-1">
          {STARS.map((s) => (
            <button
              key={s}
              onClick={() => setFilterStar(filterStar === s ? null : s)}
              className={[
                "rounded-md px-3 py-1.5 text-sm transition",
                filterStar === s
                  ? "bg-amber-500 text-slate-900 font-semibold"
                  : "border border-slate-700 text-slate-400 hover:border-slate-500",
              ].join(" ")}
            >
              {"★".repeat(s)}
            </button>
          ))}
        </div>
      </div>

      {/* Book list */}
      {filtered.length === 0 ? (
        <p className="py-12 text-center text-slate-500">No books match your filters.</p>
      ) : (
        <ul className="divide-y divide-slate-800">
          {filtered.map((book) => (
            <li key={book.id}>
              <button
                type="button"
                onClick={() => setEditing(book)}
                className="flex w-full items-center gap-4 py-3 text-left transition hover:bg-slate-800/40 -mx-2 px-2 rounded-lg"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-white">
                    {book.title}
                    {book.app_review && (
                      <span
                        title="You reviewed this book"
                        className="ml-2 align-middle text-xs text-blue-400"
                      >
                        ✎ reviewed
                      </span>
                    )}
                  </p>
                  <p className="truncate text-sm text-slate-400">
                    {book.author ?? "Unknown"}
                    {book.year_published ? ` · ${book.year_published}` : ""}
                  </p>
                </div>
                <StarRating rating={book.effective_rating} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <BookEditModal
          book={editing}
          listKey={LIBRARY_KEY}
          onClose={() => setEditing(null)}
        />
      )}

      {queue && queue[qIndex] && (
        <BookEditModal
          key={queue[qIndex].id}
          book={queue[qIndex]}
          listKey={LIBRARY_KEY}
          queuePosition={{ index: qIndex, total: queue.length }}
          onClose={advanceQueue}
          onFinishQueue={() => setQueue(null)}
        />
      )}
    </div>
  );
}
