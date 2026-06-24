"""FastAPI service — the Pattern-B HTTP seam.

The same core functions the CLI calls (ingest / enrich / profile) are exposed here as
endpoints. A future Next.js frontend calls these over HTTP; the ANTHROPIC_API_KEY stays
on this server and never reaches the browser.

Run:  uvicorn mylibrary.api:app --reload
Docs: http://127.0.0.1:8000/docs

Note: /enrich and /profile run synchronously and can take a while on a full library.
That's fine for MVP1 / local use; a later phase can move them to a background task.
"""

from __future__ import annotations

import shutil
import tempfile

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from . import catalog
from .config import get_settings
from .db import Book, Enrichment, Recommendation, init_db, session_scope
from .enrich import _normalize_title, _surname, enrich_library
from .ingest import ingest_csv
from .library import (
    BookExistsError,
    BookNotFoundError,
    add_book,
    profile_status,
    remove_book,
    set_book_feedback,
    set_book_shelf,
)
from .profile import extract_taste_profile, update_taste_profile
from .recommend import latest_recommendations, recommend
from .schemas import (
    AddBookRequest,
    BookFeedbackRequest,
    BookOut,
    CatalogResult,
    EnrichRequest,
    FeedbackRequest,
    IngestRequest,
    ProfileStatusOut,
    RecFeedbackResult,
    RecommendationOut,
    RecommendRequest,
    ShelfRequest,
    TraitOut,
    TraitUpdateRequest,
)
from .stats import dataset_stats

app = FastAPI(
    title="MyLibrary engine",
    version="0.1.0",
    description="Offline book-analysis pipeline: ingest -> enrich -> taste profile.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _startup() -> None:
    init_db()


@app.get("/health")
def health() -> dict:
    settings = get_settings()
    with session_scope() as session:
        book_count = session.query(Book).count()
    return {
        "status": "ok",
        "db": settings.db_path.name,
        "books": book_count,
        "model": settings.model,
        "anthropic_key_set": bool(settings.anthropic_api_key),
    }


@app.get("/stats")
def stats() -> dict:
    return dataset_stats()


def _book_out(book: Book) -> BookOut:
    """Build the BookOut response model from a Book ORM row (+ its enrichment)."""
    enr = book.enrichment
    return BookOut(
        id=book.id,
        title=book.title,
        author=book.author,
        isbn13=book.isbn13,
        exclusive_shelf=book.exclusive_shelf,
        goodreads_rating=book.goodreads_rating,
        app_rating=book.app_rating,
        app_review=book.app_review,
        effective_rating=book.effective_rating,
        year_published=book.year_published,
        page_count=book.page_count,
        date_read=book.date_read,
        date_added=book.date_added,
        cover_url=enr.cover_url if enr else None,
        confidence_label=enr.confidence_label if enr else None,
        resolution_confidence=enr.resolution_confidence if enr else None,
    )


def _ensure_library_book(session, rec: Recommendation, shelf: str) -> Book:
    """Idempotently land a recommended book in the library on the given shelf.

    Matches an existing book by normalized title + author surname (the same dedup the
    recommender uses); if found, just returns it. Otherwise creates the book + a stub
    enrichment (so the cover/subjects render). Used by both `accepted` (-> to-read) and
    `already_read` (-> read), so neither can be recommended again.
    """
    norm_title = _normalize_title(rec.title)
    norm_surname = _surname(rec.author)
    for b in session.query(Book).filter(Book.title.isnot(None)).all():
        if _normalize_title(b.title) == norm_title and _surname(b.author) == norm_surname:
            return b

    book = Book(
        title=rec.title,
        author=rec.author,
        isbn13=rec.isbn13,
        year_published=rec.year,
        exclusive_shelf=shelf,
        source="recommendation",
        goodreads_rating=0,
    )
    session.add(book)
    session.flush()  # assign book.id
    session.add(
        Enrichment(
            book_id=book.id,
            resolved_source=rec.catalog_source,
            resolved_id=rec.catalog_id,
            subjects=rec.subjects,
            cover_url=rec.cover_url,
            resolution_confidence=1.0,
            confidence_label="RECOMMENDATION",
            match_method="recommendation_" + shelf,
        )
    )
    return book


@app.post("/ingest")
def ingest(req: IngestRequest) -> dict:
    path = req.csv_path or str(get_settings().csv_path)
    try:
        return ingest_csv(path)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.post("/ingest/upload")
async def ingest_upload(file: UploadFile = File(...)) -> dict:
    """Accept a Goodreads CSV upload, save it to data/, and run ingest.

    This is the first-run path: the user doesn't need to know where data/ lives or how
    to put a file there manually. The frontend setup wizard calls this endpoint.
    """
    if not (file.filename or "").lower().endswith(".csv"):
        raise HTTPException(status_code=422, detail="Uploaded file must be a .csv")

    settings = get_settings()
    settings.csv_path.parent.mkdir(parents=True, exist_ok=True)
    dest = settings.csv_path

    # Stream the upload to a temp file first, then rename atomically so we never leave
    # data/goodreads_library_export.csv in a half-written state.
    with tempfile.NamedTemporaryFile(
        delete=False, dir=dest.parent, suffix=".csv.tmp"
    ) as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = tmp.name

    try:
        import os
        os.replace(tmp_path, dest)
        return ingest_csv(str(dest))
    except Exception as e:
        # Clean up temp on failure
        try:
            import os
            os.unlink(tmp_path)
        except OSError:
            pass
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/enrich")
def enrich(req: EnrichRequest) -> dict:
    return enrich_library(
        force=req.force, limit=req.limit, include_unrated=req.include_unrated
    )


@app.post("/profile")
def profile() -> dict:
    try:
        return extract_taste_profile()
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/books", response_model=list[BookOut])
def list_books(
    rated_only: bool = False,
    shelf: str | None = None,
    limit: int = Query(50, le=500),
    offset: int = 0,
) -> list[BookOut]:
    with session_scope() as session:
        q = session.query(Book)
        if shelf:
            q = q.filter(Book.exclusive_shelf == shelf)
        q = q.order_by(Book.id)
        out: list[BookOut] = []
        for book in q.offset(offset).limit(limit).all():
            if rated_only and book.effective_rating is None:
                continue
            out.append(_book_out(book))
        return out


@app.get("/catalog/search", response_model=list[CatalogResult])
def search_catalog(
    q: str = Query(..., min_length=1, description="Free-text title/author/ISBN query."),
    limit: int = Query(8, ge=1, le=20),
) -> list[CatalogResult]:
    """Search Open Library + Google Books for the manual add-a-book picker."""
    hits = catalog.search_books(q, max_results=limit)
    return [
        CatalogResult(
            source=h.get("source", "unknown"),
            catalog_id=h.get("resolved_id"),
            title=h.get("title") or "",
            author=h.get("author"),
            year=h.get("year"),
            isbn13=h.get("isbn13"),
            cover_url=h.get("cover_url"),
            subjects=h.get("subjects"),
        )
        for h in hits
        if h.get("title")
    ]


@app.post("/books", response_model=BookOut, status_code=201)
def create_book(req: AddBookRequest) -> BookOut:
    """Manually add a book to the library (from a picked catalog result).

    Returns the created book. A rated add marks the taste profile dirty (the client
    revalidates /profile/status so the re-profile banner appears).
    """
    try:
        book_id = add_book(
            title=req.title,
            author=req.author,
            year=req.year,
            isbn13=req.isbn13,
            shelf=req.shelf,
            rating=req.rating,
            cover_url=req.cover_url,
            subjects=req.subjects,
            catalog_source=req.catalog_source,
            catalog_id=req.catalog_id,
        )
    except BookExistsError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    with session_scope() as session:
        return _book_out(session.get(Book, book_id))


@app.patch("/books/{book_id}/feedback")
def rate_or_review_book(book_id: int, req: BookFeedbackRequest) -> dict:
    """Re-rate and/or review a library book.

    Updates the in-app rating/review and marks the taste profile dirty. Does NOT
    re-profile — the client shows a re-profile button when /profile/status reports dirty.
    """
    try:
        return set_book_feedback(
            book_id,
            rating=req.rating,
            review=req.review,
            clear_review=req.clear_review,
            date_read=req.date_read,
        )
    except BookNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


@app.patch("/books/{book_id}/shelf")
def move_book_shelf(book_id: int, req: ShelfRequest) -> dict:
    """Move a book to another shelf (e.g. to-read -> currently-reading / read)."""
    try:
        return set_book_shelf(book_id, req.shelf)
    except BookNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


@app.delete("/books/{book_id}")
def delete_book(book_id: int) -> dict:
    """Permanently remove a book from the library (e.g. off the to-read shelf)."""
    try:
        return remove_book(book_id)
    except BookNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.get("/profile/status", response_model=ProfileStatusOut)
def get_profile_status() -> ProfileStatusOut:
    """Whether ratings/reviews have changed since the profile was last built."""
    return ProfileStatusOut.model_validate(profile_status())


@app.post("/profile/update")
def update_profile() -> dict:
    """Incrementally re-profile from recent edits only (cheaper than a full rebuild)."""
    try:
        return update_taste_profile()
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/recommend")
def make_recommendations(req: RecommendRequest) -> dict:
    """Run the two-stage recommender and persist the served set."""
    try:
        return recommend(
            n=req.n,
            use_metadata=req.use_metadata,
            use_claude_seeds=req.use_claude_seeds,
        )
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/recommendations", response_model=list[RecommendationOut])
def get_recommendations() -> list[RecommendationOut]:
    """The most recent recommend run, in rank order."""
    with session_scope() as session:
        rows = latest_recommendations(session)
        return [RecommendationOut.model_validate(r) for r in rows]


@app.get("/recommendations/rejected", response_model=list[RecommendationOut])
def get_rejected_recommendations() -> list[RecommendationOut]:
    """All recommendations the user has rejected, across all runs, newest first."""
    with session_scope() as session:
        rows = (
            session.query(Recommendation)
            .filter(Recommendation.status == "rejected")
            .order_by(Recommendation.created_at.desc(), Recommendation.id.desc())
            .all()
        )
        return [RecommendationOut.model_validate(r) for r in rows]


@app.patch("/recommendations/{rec_id}/feedback", response_model=RecFeedbackResult)
def feedback(rec_id: int, req: FeedbackRequest) -> RecFeedbackResult:
    """Record a swipe decision on a recommendation.

    accepted     -> writes the book to the to-read shelf (idempotent).
    already_read -> writes the book to the read shelf (idempotent) so it's in the library
                   and never recommended again; the returned book lets the UI prompt a review.
    rejected     -> marks the rec so the recommender won't re-surface it.

    Returns the affected library book (None for rejected).
    """
    valid = {"accepted", "rejected", "already_read"}
    if req.status not in valid:
        raise HTTPException(status_code=422, detail=f"status must be one of {valid}")

    with session_scope() as session:
        rec = session.get(Recommendation, rec_id)
        if rec is None:
            raise HTTPException(status_code=404, detail=f"Recommendation {rec_id} not found")

        rec.status = req.status
        if req.user_note is not None:
            rec.user_note = req.user_note

        book_out: BookOut | None = None
        if req.status == "accepted":
            book_out = _book_out(_ensure_library_book(session, rec, "to-read"))
        elif req.status == "already_read":
            book_out = _book_out(_ensure_library_book(session, rec, "read"))

        return RecFeedbackResult(
            status=rec.status, user_note=rec.user_note, book=book_out
        )


@app.get("/profile", response_model=list[TraitOut])
def get_profile() -> list[TraitOut]:
    from .db import TasteTrait

    with session_scope() as session:
        traits = (
            session.query(TasteTrait)
            .order_by(TasteTrait.inference_confidence.desc())
            .all()
        )
        return [TraitOut.model_validate(t) for t in traits]


@app.patch("/profile/traits/{trait_id}", response_model=TraitOut)
def update_trait(trait_id: int, req: TraitUpdateRequest) -> TraitOut:
    """Edit a taste trait's claim text and/or attach a user note.

    Editing the claim sets status to 'edited' so it's distinguishable from
    Claude-proposed traits. User notes are stored alongside without changing status.
    """
    from .db import TasteTrait

    with session_scope() as session:
        trait = session.get(TasteTrait, trait_id)
        if trait is None:
            raise HTTPException(status_code=404, detail=f"Trait {trait_id} not found")
        if req.claim is not None:
            trait.claim = req.claim.strip()
            trait.status = "edited"
        if req.user_note is not None:
            trait.user_note = req.user_note
        session.flush()
        return TraitOut.model_validate(trait)


@app.get("/profile/subjects")
def get_profile_subjects() -> dict:
    """Subject/genre breakdown across rated books, split by star tier.

    Aggregates enrichment subjects for every rated book. Each book contributes
    its subjects to the tier matching its effective_rating. Returns top subjects
    overall and per tier (highest rating first) so the frontend can show which
    genres dominate 5-star reads vs. 1-2-star reads.
    """
    from collections import Counter, defaultdict

    with session_scope() as session:
        rated_books = [b for b in session.query(Book).all() if b.effective_rating is not None]

        overall: Counter = Counter()
        by_tier: dict[str, Counter] = defaultdict(Counter)

        for book in rated_books:
            enr = book.enrichment
            if not enr or not enr.subjects:
                continue
            rating = str(book.effective_rating)
            seen: set[str] = set()
            for raw in enr.subjects[:15]:
                normalised = raw.strip().title()
                if normalised and normalised not in seen:
                    seen.add(normalised)
                    overall[normalised] += 1
                    by_tier[rating][normalised] += 1
                if len(seen) >= 8:
                    break

        return {
            "overall": [
                {"subject": s, "count": c} for s, c in overall.most_common(25)
            ],
            "by_tier": {
                tier: [{"subject": s, "count": c} for s, c in counter.most_common(12)]
                for tier, counter in sorted(by_tier.items(), key=lambda x: int(x[0]), reverse=True)
            },
        }
