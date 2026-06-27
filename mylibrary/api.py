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

from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import BackgroundTasks, Depends, FastAPI, File, Header, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from . import archetype as archetype_module
from . import catalog
from .auth import AuthError, resolve_user_id
from .config import get_settings
from .db import Book, EnrichJob, Enrichment, ReaderArchetype, Recommendation, init_db, session_scope
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
from .purge import clear_library, clear_profile, delete_account
from .recommend import latest_recommendations, recommend
from .schemas import (
    AddBookRequest,
    ApiKeyRequest,
    ApiKeyStatus,
    ArchetypeAxisOut,
    ArchetypeOut,
    BookFeedbackRequest,
    BookOut,
    CatalogResult,
    EnrichJobOut,
    EnrichRequest,
    EnrichStartRequest,
    FeedbackRequest,
    IngestRequest,
    ProfileStatusOut,
    RecFeedbackResult,
    RecommendationOut,
    RecommendRequest,
    ShelfRequest,
    TraitOut,
    TraitUpdateRequest,
    UserProfileOut,
    UserProfileRequest,
)
from .stats import dataset_stats
from .user_settings import (
    anthropic_key_status,
    clear_anthropic_key,
    get_display_name,
    set_anthropic_key,
    set_display_name,
)
from .worker import create_enrich_job, fail_if_stale, recover_orphaned_jobs, run_enrich_job

def _rate_limit_key(request: Request) -> str:
    """Rate-limit key: the authenticated user_id (stashed on request.state by
    current_user) so limits are per-user, not per-IP. Falls back to client IP
    for unauthenticated requests (health checks, etc.)."""
    return getattr(request.state, "user_id", request.client.host if request.client else "unknown")


limiter = Limiter(key_func=_rate_limit_key)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """App startup: ensure the local schema is current (no-op in hosted/Alembic mode).
    Also initialise the arq Redis pool when REDIS_URL is configured.
    """
    init_db()
    recover_orphaned_jobs()

    # Initialise the arq connection pool so routes can enqueue jobs.
    settings = get_settings()
    if settings.redis_url:
        from arq.connections import RedisSettings as ArqRedisSettings, create_pool
        _app.state.arq_pool = await create_pool(ArqRedisSettings.from_dsn(settings.redis_url))
    else:
        _app.state.arq_pool = None

    yield

    if _app.state.arq_pool is not None:
        await _app.state.arq_pool.aclose()


app = FastAPI(
    title="MyLibrary engine",
    version="0.1.0",
    description="Offline book-analysis pipeline: ingest -> enrich -> taste profile.",
    lifespan=lifespan,
)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(get_settings().cors_origins),
    allow_methods=["*"],
    allow_headers=["*"],
)


def current_user(
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
) -> str:
    """Per-request user id. Verifies the Supabase JWT when configured; otherwise returns
    LOCAL_USER_ID (local single-user mode). Every data route depends on this so all queries
    are scoped to the caller. Until SUPABASE_JWT_SECRET is set this is transparently 'local'.

    Also stashes the resolved user_id on request.state so the SlowAPI rate-limiter key
    function can read it without re-running auth logic.
    """
    try:
        user_id = resolve_user_id(authorization)
        request.state.user_id = user_id
        return user_id
    except AuthError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc


# Annotated dependency alias — add `user_id: UserId` to a route to receive the scoped id.
UserId = Annotated[str, Depends(current_user)]


@app.get("/healthz")
def healthz() -> dict:
    """Unauthenticated liveness probe for the platform healthcheck (Railway, etc.).

    Deliberately does NOT depend on `current_user`: in hosted mode every other route
    requires a Bearer token, but a healthcheck has none, so it must stay public. Does
    not touch the DB so it succeeds even before the first request / during a cold start.
    """
    return {"status": "ok"}


@app.get("/health")
def health(user_id: UserId) -> dict:
    settings = get_settings()
    with session_scope() as session:
        book_count = (
            session.query(Book).filter(Book.user_id == user_id).count()
        )
    return {
        "status": "ok",
        "db": settings.db_path.name,
        "books": book_count,
        "model": settings.model,
        "anthropic_key_set": anthropic_key_status(user_id=user_id)["configured"],
    }


@app.get("/stats")
def stats(user_id: UserId) -> dict:
    return dataset_stats(user_id=user_id)


@app.put("/settings/api-key", response_model=ApiKeyStatus)
def put_api_key(req: ApiKeyRequest, user_id: UserId) -> ApiKeyStatus:
    """Store the caller's Anthropic API key (encrypted at rest). Never returns the key."""
    try:
        set_anthropic_key(req.api_key, user_id=user_id)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return ApiKeyStatus(configured=True)


@app.get("/settings/api-key/status", response_model=ApiKeyStatus)
def get_api_key_status(user_id: UserId) -> ApiKeyStatus:
    """Whether a usable Anthropic key is configured (stored or env fallback). Not the key."""
    return ApiKeyStatus(**anthropic_key_status(user_id=user_id))


@app.delete("/settings/api-key", response_model=ApiKeyStatus)
def delete_api_key(user_id: UserId) -> ApiKeyStatus:
    """Remove the caller's stored key. `configured` may still be true if an env key exists."""
    clear_anthropic_key(user_id=user_id)
    return ApiKeyStatus(**anthropic_key_status(user_id=user_id))


@app.get("/settings/profile", response_model=UserProfileOut)
def get_profile_settings(user_id: UserId) -> UserProfileOut:
    """Return the user's display name (or null if not yet set)."""
    return UserProfileOut(display_name=get_display_name(user_id=user_id))


@app.put("/settings/profile", response_model=UserProfileOut)
def put_profile_settings(req: UserProfileRequest, user_id: UserId) -> UserProfileOut:
    """Set / update the user's display name."""
    try:
        set_display_name(req.display_name, user_id=user_id)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return UserProfileOut(display_name=get_display_name(user_id=user_id))


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
        description=enr.description if enr else None,
        confidence_label=enr.confidence_label if enr else None,
        resolution_confidence=enr.resolution_confidence if enr else None,
    )


def _ensure_library_book(session, rec: Recommendation, shelf: str, user_id: str) -> Book:
    """Idempotently land a recommended book in `user_id`'s library on the given shelf.

    Matches an existing book by normalized title + author surname (the same dedup the
    recommender uses); if found, just returns it. Otherwise creates the book + a stub
    enrichment (so the cover/subjects render). Used by both `accepted` (-> to-read) and
    `already_read` (-> read), so neither can be recommended again. The dedup walk is
    scoped to this user so it never scans another user's library.
    """
    norm_title = _normalize_title(rec.title)
    norm_surname = _surname(rec.author)
    dupe_q = session.query(Book).filter(
        Book.user_id == user_id, Book.title.isnot(None)
    )
    for b in dupe_q.all():
        if _normalize_title(b.title) == norm_title and _surname(b.author) == norm_surname:
            return b

    book = Book(
        user_id=user_id,
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
def ingest(req: IngestRequest, user_id: UserId) -> dict:
    path = req.csv_path or str(get_settings().csv_path)
    try:
        return ingest_csv(path, user_id=user_id)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.post("/ingest/upload")
async def ingest_upload(user_id: UserId, file: UploadFile = File(...)) -> dict:
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
        return ingest_csv(str(dest), user_id=user_id)
    except Exception as e:
        # Clean up temp on failure
        try:
            import os
            os.unlink(tmp_path)
        except OSError:
            pass
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/enrich/start", response_model=EnrichJobOut)
@limiter.limit("5/minute")
async def enrich_start(
    req: EnrichStartRequest,
    request: Request,
    background_tasks: BackgroundTasks,
    user_id: UserId,
) -> EnrichJobOut:
    """Enqueue a library enrichment job and return its job_id for polling.

    By default (REDIS_URL unset) the job runs as a FastAPI BackgroundTask in this web
    process -- the supported production mode. When REDIS_URL is configured it is handed
    off to the arq worker instead. Poll GET /enrich/status/{job_id} until 'done'/'error'.
    """
    job_id = create_enrich_job(user_id)

    arq_pool = request.app.state.arq_pool
    if arq_pool is not None:
        # Hosted mode: hand off to the arq worker
        await arq_pool.enqueue_job(
            "enrich_books",
            job_id=job_id,
            user_id=user_id,
            force=req.force,
            limit=req.limit,
        )
    else:
        # Default mode: run in a BackgroundTask (same blocking function, no Redis).
        # On a mid-job web restart, recover_orphaned_jobs() fails the stranded row at boot.
        background_tasks.add_task(
            run_enrich_job,
            job_id=job_id,
            user_id=user_id,
            force=req.force,
            limit=req.limit,
        )

    with session_scope() as session:
        job = session.query(EnrichJob).filter(EnrichJob.job_id == job_id).first()
        return EnrichJobOut.model_validate(job)


@app.get("/enrich/status/{job_id}", response_model=EnrichJobOut)
def enrich_status(job_id: str, user_id: UserId) -> EnrichJobOut:
    """Poll the status and progress of an enrichment job.

    Returns 404 if job_id is unknown or belongs to a different user.
    """
    with session_scope() as session:
        job = (
            session.query(EnrichJob)
            .filter(EnrichJob.job_id == job_id, EnrichJob.user_id == user_id)
            .first()
        )
        if job is None:
            raise HTTPException(status_code=404, detail=f"Job {job_id!r} not found")
        fail_if_stale(session, job)
        return EnrichJobOut.model_validate(job)


@app.post("/enrich")
def enrich(req: EnrichRequest, user_id: UserId) -> dict:
    """Synchronous enrichment — kept for CLI / local tooling compatibility.

    The web frontend uses POST /enrich/start + GET /enrich/status/{job_id} instead
    (background job that survives cloud HTTP timeouts). This endpoint blocks until
    enrichment finishes; it is NOT rate-limited and is NOT exposed in the hosted UI.
    """
    return enrich_library(
        force=req.force,
        limit=req.limit,
        include_unrated=req.include_unrated,
        user_id=user_id,
    )


@app.post("/profile")
def profile(user_id: UserId) -> dict:
    try:
        return extract_taste_profile(user_id=user_id)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/books", response_model=list[BookOut])
def list_books(
    user_id: UserId,
    rated_only: bool = False,
    shelf: str | None = None,
    limit: int = Query(50, le=500),
    offset: int = 0,
) -> list[BookOut]:
    with session_scope() as session:
        q = session.query(Book).filter(Book.user_id == user_id)
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
@limiter.limit("30/minute")
def search_catalog(
    request: Request,
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
def create_book(req: AddBookRequest, user_id: UserId) -> BookOut:
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
            review=req.review,
            cover_url=req.cover_url,
            subjects=req.subjects,
            catalog_source=req.catalog_source,
            catalog_id=req.catalog_id,
            user_id=user_id,
        )
    except BookExistsError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    with session_scope() as session:
        return _book_out(session.get(Book, book_id))


@app.patch("/books/{book_id}/feedback")
def rate_or_review_book(book_id: int, req: BookFeedbackRequest, user_id: UserId) -> dict:
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
            exclude_from_profile=req.exclude_from_profile,
            user_id=user_id,
        )
    except BookNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


@app.patch("/books/{book_id}/shelf")
def move_book_shelf(book_id: int, req: ShelfRequest, user_id: UserId) -> dict:
    """Move a book to another shelf (e.g. to-read -> currently-reading / read)."""
    try:
        return set_book_shelf(book_id, req.shelf, user_id=user_id)
    except BookNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


@app.delete("/books/{book_id}")
def delete_book(book_id: int, user_id: UserId) -> dict:
    """Permanently remove a book from the library (e.g. off the to-read shelf)."""
    try:
        return remove_book(book_id, user_id=user_id)
    except BookNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


# --- Bulk data removal (scoped to the authenticated user) ------------------
# Each route deletes only the current user's rows. clear_library cascades to the profile;
# delete_account additionally drops the stored Anthropic key. See mylibrary/purge.py.


@app.delete("/library")
def delete_library(user_id: UserId) -> dict:
    """Drop the whole library (books + enrichments) and the derived taste profile/recs."""
    return clear_library(user_id=user_id)


@app.delete("/profile")
def delete_profile(user_id: UserId) -> dict:
    """Reset the taste profile (traits + recommendations + profile bookkeeping); keep books."""
    return clear_profile(user_id=user_id)


@app.delete("/account")
def delete_account_route(user_id: UserId) -> dict:
    """Delete all of the current user's app data (library, profile, recs, stored key)."""
    return delete_account(user_id=user_id)


@app.get("/profile/status", response_model=ProfileStatusOut)
def get_profile_status(user_id: UserId) -> ProfileStatusOut:
    """Whether ratings/reviews have changed since the profile was last built."""
    return ProfileStatusOut.model_validate(profile_status(user_id=user_id))


@app.post("/profile/update")
def update_profile(user_id: UserId) -> dict:
    """Incrementally re-profile from recent edits only (cheaper than a full rebuild)."""
    try:
        return update_taste_profile(user_id=user_id)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/recommend")
def make_recommendations(req: RecommendRequest, user_id: UserId) -> dict:
    """Run the two-stage recommender and persist the served set."""
    try:
        return recommend(
            n=req.n,
            use_metadata=req.use_metadata,
            use_claude_seeds=req.use_claude_seeds,
            user_id=user_id,
        )
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/recommendations", response_model=list[RecommendationOut])
def get_recommendations(user_id: UserId) -> list[RecommendationOut]:
    """The most recent recommend run, in rank order."""
    with session_scope() as session:
        rows = latest_recommendations(session, user_id)
        return [RecommendationOut.model_validate(r) for r in rows]


@app.get("/recommendations/rejected", response_model=list[RecommendationOut])
def get_rejected_recommendations(user_id: UserId) -> list[RecommendationOut]:
    """All recommendations the user has rejected, across all runs, newest first."""
    with session_scope() as session:
        rows = (
            session.query(Recommendation)
            .filter(
                Recommendation.user_id == user_id,
                Recommendation.status == "rejected",
            )
            .order_by(Recommendation.created_at.desc(), Recommendation.id.desc())
            .all()
        )
        return [RecommendationOut.model_validate(r) for r in rows]


@app.patch("/recommendations/{rec_id}/feedback", response_model=RecFeedbackResult)
def feedback(rec_id: int, req: FeedbackRequest, user_id: UserId) -> RecFeedbackResult:
    """Record a swipe decision on a recommendation.

    accepted     -> writes the book to the to-read shelf (idempotent).
    already_read -> writes the book to the read shelf (idempotent) so it's in the library
                   and never recommended again; the returned book lets the UI prompt a review.
    rejected     -> marks the rec so the recommender won't re-surface it.

    Returns the affected library book (None for rejected).
    """
    valid = {"accepted", "rejected", "already_read"}
    if req.status is not None and req.status not in valid:
        raise HTTPException(status_code=422, detail=f"status must be one of {valid}")
    if req.status is None and req.user_note is None:
        raise HTTPException(status_code=422, detail="Provide status and/or user_note")

    with session_scope() as session:
        rec = session.get(Recommendation, rec_id)
        if rec is None or rec.user_id != user_id:
            raise HTTPException(status_code=404, detail=f"Recommendation {rec_id} not found")

        if req.status is not None:
            rec.status = req.status
        if req.user_note is not None:
            rec.user_note = req.user_note

        book_out: BookOut | None = None
        effective_status = req.status or rec.status
        if effective_status == "accepted":
            book_out = _book_out(_ensure_library_book(session, rec, "to-read", user_id))
        elif effective_status == "already_read":
            book_out = _book_out(_ensure_library_book(session, rec, "read", user_id))

        return RecFeedbackResult(
            status=rec.status, user_note=rec.user_note, book=book_out
        )


@app.get("/profile", response_model=list[TraitOut])
def get_profile(user_id: UserId) -> list[TraitOut]:
    from .db import TasteTrait

    with session_scope() as session:
        traits = (
            session.query(TasteTrait)
            .filter(TasteTrait.user_id == user_id)
            .order_by(TasteTrait.inference_confidence.desc())
            .all()
        )
        return [TraitOut.model_validate(t) for t in traits]


@app.patch("/profile/traits/{trait_id}", response_model=TraitOut)
def update_trait(trait_id: int, req: TraitUpdateRequest, user_id: UserId) -> TraitOut:
    """Edit a taste trait's claim text and/or attach a user note.

    Editing the claim sets status to 'edited' so it's distinguishable from
    Claude-proposed traits. User notes are stored alongside without changing status.
    """
    from .db import TasteTrait

    with session_scope() as session:
        trait = session.get(TasteTrait, trait_id)
        if trait is None or trait.user_id != user_id:
            raise HTTPException(status_code=404, detail=f"Trait {trait_id} not found")
        if req.claim is not None:
            trait.claim = req.claim.strip()
            trait.status = "edited"
        if req.user_note is not None:
            trait.user_note = req.user_note
        session.flush()
        return TraitOut.model_validate(trait)


@app.get("/profile/subjects")
def get_profile_subjects(user_id: UserId) -> dict:
    """Subject/genre breakdown across rated books, split by star tier.

    Aggregates enrichment subjects for every rated book. Each book contributes
    its subjects to the tier matching its effective_rating. Returns top subjects
    overall and per tier (highest rating first) so the frontend can show which
    genres dominate 5-star reads vs. 1-2-star reads.
    """
    from collections import Counter, defaultdict

    with session_scope() as session:
        rated_books = [
            b
            for b in session.query(Book).filter(Book.user_id == user_id).all()
            if b.effective_rating is not None
        ]

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


def _archetype_out(row: ReaderArchetype, last_profiled_at) -> ArchetypeOut:
    """Map a ReaderArchetype DB row to ArchetypeOut (computes letters + is_stale)."""
    def _axis(axis_key: str, score: float, rationale: str | None) -> ArchetypeAxisOut:
        letter = archetype_module._score_to_letter(axis_key, score)
        return ArchetypeAxisOut(score=score, letter=letter, rationale=rationale or None)

    is_stale = (
        last_profiled_at is not None and row.derived_at < last_profiled_at
    )
    return ArchetypeOut(
        code=row.code,
        name=row.archetype_name,
        tagline=row.archetype_tagline,
        lens=_axis("lens", row.axis_lens, row.lens_rationale),
        engine=_axis("engine", row.axis_engine, row.engine_rationale),
        range=_axis("range", row.axis_range, row.range_rationale),
        resonance=_axis("resonance", row.axis_resonance, row.resonance_rationale),
        derived_at=row.derived_at,
        is_stale=is_stale,
    )


def _get_last_profiled_at(session, user_id: str):
    """Return the user's ProfileMeta.last_profiled_at (or None if no profile)."""
    from .db import ProfileMeta
    meta = session.query(ProfileMeta).filter(ProfileMeta.user_id == user_id).one_or_none()
    return meta.last_profiled_at if meta else None


@app.post("/profile/archetype", response_model=ArchetypeOut)
def post_archetype(user_id: UserId) -> ArchetypeOut:
    """Derive (or re-derive) the reader archetype from the current taste profile.

    Calls Claude Haiku to score 4 axes; upserts the result; returns ArchetypeOut.
    Requires a taste profile and a usable Anthropic API key.
    """
    try:
        result = archetype_module.derive_archetype(user_id=user_id)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))

    with session_scope() as session:
        row = (
            session.query(ReaderArchetype)
            .filter(ReaderArchetype.user_id == user_id)
            .one_or_none()
        )
        if row is None:
            raise HTTPException(status_code=500, detail="Archetype upsert failed")
        last_profiled_at = _get_last_profiled_at(session, user_id)
        return _archetype_out(row, last_profiled_at)


@app.get("/profile/archetype", response_model=ArchetypeOut)
def get_archetype(user_id: UserId) -> ArchetypeOut:
    """Return the stored reader archetype for the current user.

    Returns 404 if no archetype has been derived yet.
    Cross-tenant access returns 404 (the query filters by user_id).
    """
    with session_scope() as session:
        row = (
            session.query(ReaderArchetype)
            .filter(ReaderArchetype.user_id == user_id)
            .one_or_none()
        )
        if row is None:
            raise HTTPException(status_code=404, detail="No archetype derived yet")
        last_profiled_at = _get_last_profiled_at(session, user_id)
        return _archetype_out(row, last_profiled_at)
