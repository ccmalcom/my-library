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

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .db import Book, Enrichment, Recommendation, init_db, session_scope
from .enrich import _normalize_title, _surname, enrich_library
from .ingest import ingest_csv
from .profile import extract_taste_profile
from .recommend import latest_recommendations, recommend
from .schemas import (
    BookOut,
    EnrichRequest,
    FeedbackRequest,
    IngestRequest,
    RecommendationOut,
    RecommendRequest,
    TraitOut,
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


@app.post("/ingest")
def ingest(req: IngestRequest) -> dict:
    path = req.csv_path or str(get_settings().csv_path)
    try:
        return ingest_csv(path)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


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
            enr = book.enrichment
            out.append(
                BookOut(
                    id=book.id,
                    title=book.title,
                    author=book.author,
                    isbn13=book.isbn13,
                    exclusive_shelf=book.exclusive_shelf,
                    goodreads_rating=book.goodreads_rating,
                    app_rating=book.app_rating,
                    effective_rating=book.effective_rating,
                    year_published=book.year_published,
                    page_count=book.page_count,
                    date_read=book.date_read,
                    date_added=book.date_added,
                    cover_url=enr.cover_url if enr else None,
                    confidence_label=enr.confidence_label if enr else None,
                    resolution_confidence=enr.resolution_confidence if enr else None,
                )
            )
        return out


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


@app.patch("/recommendations/{rec_id}/feedback", response_model=RecommendationOut)
def feedback(rec_id: int, req: FeedbackRequest) -> RecommendationOut:
    """Record a swipe decision on a recommendation.

    accepted → also writes the book to the to-read shelf (idempotent).
    rejected → marks the rec so the recommender won't re-surface it.
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

        if req.status == "accepted":
            # Idempotent: only insert if no matching book already exists.
            norm_title = _normalize_title(rec.title)
            norm_surname = _surname(rec.author)
            existing = (
                session.query(Book)
                .filter(Book.title.isnot(None))
                .all()
            )
            already_present = any(
                _normalize_title(b.title) == norm_title
                and _surname(b.author) == norm_surname
                for b in existing
            )
            if not already_present:
                new_book = Book(
                    title=rec.title,
                    author=rec.author,
                    isbn13=rec.isbn13,
                    year_published=rec.year,
                    exclusive_shelf="to-read",
                    source="recommendation",
                    goodreads_rating=0,
                )
                session.add(new_book)
                session.flush()  # get new_book.id

                # Stub enrichment so the frontend can show cover + subjects.
                session.add(
                    Enrichment(
                        book_id=new_book.id,
                        resolved_source=rec.catalog_source,
                        resolved_id=rec.catalog_id,
                        subjects=rec.subjects,
                        cover_url=rec.cover_url,
                        resolution_confidence=1.0,
                        confidence_label="RECOMMENDATION",
                        match_method="recommendation_accept",
                    )
                )

        return RecommendationOut.model_validate(rec)


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
