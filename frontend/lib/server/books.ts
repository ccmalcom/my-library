import type { schema } from './db';
import { effectiveRating } from './serialize';

export type BookRow = typeof schema.books.$inferSelect;
export type EnrichmentRow = typeof schema.enrichment.$inferSelect;

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
