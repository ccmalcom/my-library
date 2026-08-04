import type { schema } from './db';
import { tsToIso } from './serialize';

/** Port of schemas.py::RecommendationOut (note: no reject_reasons field). */
export function recOut(r: typeof schema.recommendations.$inferSelect) {
  return {
    id: r.id,
    run_id: r.runId,
    rank: r.rank,
    title: r.title,
    author: r.author,
    year: r.year,
    isbn13: r.isbn13,
    cover_url: r.coverUrl,
    subjects: r.subjects,
    description: r.description,
    catalog_source: r.catalogSource,
    catalog_id: r.catalogId,
    retrieval_pool: r.retrievalPool,
    seed_reason: r.seedReason,
    score: r.score,
    rationale: r.rationale,
    grounded_trait_ids: r.groundedTraitIds,
    grounded_book_ids: r.groundedBookIds,
    status: r.status,
    user_note: r.userNote,
    created_at: tsToIso(r.createdAt),
  };
}
