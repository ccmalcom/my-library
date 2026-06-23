"use client";

import { useState } from "react";
import { mutate } from "swr";
import {
  api,
  PROFILE_STATUS_KEY,
  type Book,
  type BookFeedbackRequest,
} from "@/lib/api";

interface Props {
  book: Book;
  /** SWR key of the list to revalidate after saving (so the row updates). */
  listKey: string;
  onClose: () => void;
}

/**
 * Re-rate and/or review a single library book.
 *
 * Sends only what changed: a new rating, a new/edited review, or a cleared review.
 * Goodreads is import-once, so the in-app rating/review set here is authoritative.
 * On save it revalidates the book list AND the profile-status query — the latter is
 * what makes the global "re-profile" banner appear once a change is made.
 */
export default function BookEditModal({ book, listKey, onClose }: Props) {
  // The effective rating is the starting point the user sees and edits.
  const initialRating = book.effective_rating ?? 0;
  const initialReview = book.app_review ?? "";

  const [rating, setRating] = useState(initialRating);
  const [hover, setHover] = useState(0);
  const [review, setReview] = useState(initialReview);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ratingChanged = rating !== initialRating;
  const reviewChanged = review.trim() !== initialReview.trim();
  const dirty = ratingChanged || reviewChanged;

  async function handleSave() {
    if (!dirty) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);

    const req: BookFeedbackRequest = {};
    if (ratingChanged) req.rating = rating; // 0 clears the in-app override
    if (reviewChanged) {
      if (review.trim() === "") req.clear_review = true;
      else req.review = review.trim();
    }

    try {
      await api.setBookFeedback(book.id, req);
      // Refresh the list row and flag the profile as possibly stale.
      await Promise.all([mutate(listKey), mutate(PROFILE_STATUS_KEY)]);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save.");
      setSaving(false);
    }
  }

  const shown = hover || rating;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="fade-in w-full max-w-md rounded-2xl border border-slate-700 bg-[#1a1f2e] p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4">
          <h2 className="text-lg font-bold leading-tight text-white">{book.title}</h2>
          <p className="text-sm text-slate-400">
            {book.author ?? "Unknown"}
            {book.year_published ? ` · ${book.year_published}` : ""}
          </p>
        </div>

        {/* Rating */}
        <div className="mb-5">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Your rating
            </span>
            {rating > 0 && (
              <button
                type="button"
                onClick={() => setRating(0)}
                className="text-xs text-slate-500 hover:text-slate-300"
              >
                Clear
              </button>
            )}
          </div>
          <div
            className="flex gap-1"
            onMouseLeave={() => setHover(0)}
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                onMouseEnter={() => setHover(n)}
                onClick={() => setRating(n)}
                className="text-3xl leading-none transition-transform hover:scale-110"
                aria-label={`${n} star${n > 1 ? "s" : ""}`}
              >
                <span className={n <= shown ? "text-amber-400" : "text-slate-600"}>
                  ★
                </span>
              </button>
            ))}
          </div>
          {rating === 0 && (
            <p className="mt-1 text-xs text-slate-500">
              Unrated{book.goodreads_rating > 0 ? " (Goodreads import cleared)" : ""}.
            </p>
          )}
        </div>

        {/* Review */}
        <div className="mb-5">
          <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-400">
            Review
          </label>
          <textarea
            value={review}
            onChange={(e) => setReview(e.target.value)}
            rows={5}
            placeholder="What did you think? Your words feed the taste profile…"
            className="w-full resize-y rounded-lg border border-slate-700 bg-[#0f1117] px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:border-blue-600 focus:outline-none"
          />
        </div>

        {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-lg px-4 py-2 text-sm font-medium text-slate-400 transition hover:bg-slate-800 hover:text-slate-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !dirty}
            className={[
              "rounded-lg px-4 py-2 text-sm font-semibold text-white transition-all",
              saving || !dirty
                ? "cursor-not-allowed bg-blue-700 opacity-60"
                : "bg-blue-600 hover:bg-blue-500 active:scale-95",
            ].join(" ")}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
