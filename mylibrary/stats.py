"""Dataset statistics — the numbers you watch while iterating on the loop.

Covers the headline figures from the build plan: rating distribution, shelf
breakdown, enrichment coverage, and resolution-confidence mix. Pure reads.
"""

from __future__ import annotations

from collections import Counter

from .db import Book, Enrichment, TasteTrait, init_db, session_scope


def dataset_stats() -> dict:
    init_db()
    with session_scope() as session:
        books = session.query(Book).all()
        total = len(books)
        rated = [b for b in books if b.effective_rating is not None]

        rating_dist = Counter(b.effective_rating for b in rated)
        shelf_dist = Counter(b.exclusive_shelf or "unknown" for b in books)
        has_isbn = sum(1 for b in books if b.isbn13)

        enr_rows = session.query(Enrichment).all()
        conf_dist = Counter(e.confidence_label or "NONE" for e in enr_rows)
        rated_ids = {b.id for b in rated}
        rated_enriched = sum(1 for e in enr_rows if e.book_id in rated_ids)

        traits = session.query(TasteTrait).all()
        trait_polarity = Counter(t.polarity for t in traits)

        n_rated = len(rated)
        mean_rating = (
            round(sum(b.effective_rating for b in rated) / n_rated, 2)
            if n_rated > 0
            else None
        )

        return {
            # Fields used by the TypeScript Stats interface (home page + My Profile)
            "total": total,
            "rated": n_rated,
            "unrated": total - n_rated,
            "mean_rating": mean_rating,
            "by_star": {str(k): v for k, v in sorted(rating_dist.items(), reverse=True)},
            "shelves": dict(shelf_dist),
            # Extended fields used by the CLI and internal tooling
            "has_isbn13": has_isbn,
            "enrichment": {
                "rows": len(enr_rows),
                "rated_books_enriched": rated_enriched,
                "confidence": dict(conf_dist),
            },
            "taste_traits": {
                "total": len(traits),
                "by_polarity": dict(trait_polarity),
            },
        }
