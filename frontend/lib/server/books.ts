import type { schema } from './db';
import { effectiveRating, tsToIso } from './serialize';

export type BookRow = typeof schema.books.$inferSelect;
export type EnrichmentRow = typeof schema.enrichment.$inferSelect;

/** Sorted — this exact order is what Python's sorted(VALID_SHELVES) interpolates into 422s. */
export const VALID_SHELVES = ['currently-reading', 'did-not-finish', 'read', 'to-read'];

/** Port of api.py::_book_out — the BookOut JSON shape. */
export function bookOut(b: BookRow, e: EnrichmentRow | null) {
  return {
    id: b.id,
    title: b.title,
    author: b.author,
    isbn13: b.isbn13,
    exclusive_shelf: b.exclusiveShelf,
    goodreads_rating: b.goodreadsRating,
    app_rating: b.appRating,
    app_review: b.appReview,
    effective_rating: effectiveRating(b.appRating, b.goodreadsRating),
    year_published: b.yearPublished,
    page_count: b.pageCount,
    date_read: b.dateRead,
    date_added: b.dateAdded,
    cover_url: e?.coverUrl ?? null,
    description: e?.description ?? null,
    confidence_label: e?.confidenceLabel ?? null,
    resolution_confidence: e?.resolutionConfidence ?? null,
    exclude_from_profile: b.excludeFromProfile,
    is_favorite: b.isFavorite,
  };
}

/** Port of library.py::_book_summary — the PATCH feedback/shelf response dict. */
export function bookSummary(b: BookRow) {
  return {
    id: b.id,
    title: b.title,
    author: b.author,
    exclusive_shelf: b.exclusiveShelf,
    app_rating: b.appRating,
    goodreads_rating: b.goodreadsRating,
    effective_rating: effectiveRating(b.appRating, b.goodreadsRating),
    app_review: b.appReview,
    date_read: b.dateRead,
    feedback_updated_at: tsToIso(b.feedbackUpdatedAt),
    exclude_from_profile: b.excludeFromProfile,
  };
}
