"""profile_highlights — a pure computation over enriched library metadata.

Backs Beat 5 ("Your shelves in numbers") of the Wrapped reveal. No external calls
(locked decision: respects enrichment as the foundation, makes no new catalog/Claude
requests). Weights genres by rating so the result reflects taste, not acquisition.
"""

from __future__ import annotations

from collections import Counter, defaultdict

from .config import LOCAL_USER_ID
from .db import Book
from .recommend import _COLD_START_LOVED, _COLD_START_RATED, _LOVED_MIN

_NOVELLA_MAX_PAGES = 120
_COLLECTION_TOKENS = ("short stor", "story collection", "collections", "anthology")
_MIN_AUTHOR_BOOKS = 2


def _classify_format(book: Book) -> tuple[str, bool]:
    """Return (format_bucket, is_low_confidence) for one book.

    Priority: series installment > novella (by page count) > collection > novel. A
    short book with a "short stories" subject tag (e.g. a slim Chekhov volume) reads
    as a novella first — page count is the stronger, more concrete signal. low_confidence
    is True when we could not distinguish a novella because the page count is missing.
    """
    enr = book.enrichment
    if enr and (enr.series or enr.series_position):
        return "series", False
    pages = book.page_count
    if pages is not None and pages < _NOVELLA_MAX_PAGES:
        return "novella", False
    subjects = [s.lower() for s in (enr.subjects if enr else []) or []]
    if any(any(tok in s for tok in _COLLECTION_TOKENS) for s in subjects):
        return "collection", False
    # Default to novel; flag low-confidence when we lacked the page signal to rule out novella.
    return "novel", pages is None


def compute_highlights(session, user_id: str = LOCAL_USER_ID) -> dict:
    rated = [
        b
        for b in session.query(Book).filter(Book.user_id == user_id).all()
        if b.effective_rating is not None
    ]

    loved = [b for b in rated if b.effective_rating >= _LOVED_MIN]
    thin = len(loved) < _COLD_START_LOVED or len(rated) < _COLD_START_RATED

    authors = [b.author for b in rated if b.author]
    n_authors = len(set(authors))

    # top_genres: rating-weighted subject scores; share = fraction of enriched-rated
    # books that list the subject (what the copy's "80%+ one genre" branch needs).
    genre_score: Counter = Counter()
    genre_books: Counter = Counter()
    enriched_rated = 0
    for book in rated:
        enr = book.enrichment
        if not enr or not enr.subjects:
            continue
        enriched_rated += 1
        seen: set[str] = set()
        for raw in enr.subjects[:8]:
            subject = raw.strip().title()
            if not subject or subject in seen:
                continue
            seen.add(subject)
            genre_score[subject] += book.effective_rating
            genre_books[subject] += 1
    top_genres = [
        {
            "subject": subject,
            "share": round(genre_books[subject] / enriched_rated, 4) if enriched_rated else 0.0,
        }
        for subject, _ in genre_score.most_common(3)
    ]

    # top_authors: books_read * avg_rating, min 2 books.
    by_author: dict[str, list[int]] = defaultdict(list)
    for book in rated:
        if book.author:
            by_author[book.author].append(book.effective_rating)
    author_scores: list[tuple[str, float]] = []
    for author, ratings in by_author.items():
        if len(ratings) < _MIN_AUTHOR_BOOKS:
            continue
        avg = sum(ratings) / len(ratings)
        author_scores.append((author, len(ratings) * avg))
    author_scores.sort(key=lambda x: x[1], reverse=True)
    top_authors = [a for a, _ in author_scores[:3]]

    # format_mix
    buckets = {"novel": 0, "novella": 0, "collection": 0, "series": 0}
    low_conf = False
    for book in rated:
        fmt, book_low = _classify_format(book)
        buckets[fmt] += 1
        low_conf = low_conf or book_low
    dominant = max(buckets, key=lambda k: buckets[k]) if rated else None
    if dominant is not None and buckets[dominant] == 0:
        dominant = None
    format_mix = {**buckets, "dominant": dominant, "low_confidence": low_conf}

    # era_split
    years = [b.year_published for b in rated if b.year_published]
    era_split = None
    if years:
        era_split = {
            "pre_2000": sum(1 for y in years if y < 2000),
            "post_2000": sum(1 for y in years if y >= 2000),
        }

    return {
        "thin": thin,
        "n_authors": n_authors,
        "top_genres": top_genres,
        "top_authors": top_authors,
        "format_mix": format_mix,
        "era_split": era_split,
    }
