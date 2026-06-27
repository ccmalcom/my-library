"""Database: SQLAlchemy 2.0 models and session management.

The schema follows the build plan (Section 6). MVP1 implements books, enrichment,
and taste_traits. Phase 5 adds recommendations (served two-stage recs); feedback_events
still come in a later phase.

This Python side OWNS the schema/migrations. When the Next.js frontend is added it
should READ this database (or call the API), not run its own migrations against it —
that keeps the cross-language seam clean (one source of truth for the schema).
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import date, datetime, timezone
from typing import Iterator

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    create_engine,
    func,
)
from sqlalchemy.orm import (
    DeclarativeBase,
    Mapped,
    Session,
    mapped_column,
    relationship,
    sessionmaker,
)
from sqlalchemy.types import JSON

from .config import LOCAL_USER_ID, get_settings


def utcnow() -> datetime:
    """Naive UTC timestamp.

    The DateTime columns are naive and SQLite reloads them naive, so we keep app-set
    timestamps naive too (mixing aware + naive would break `>` comparisons). Replaces the
    deprecated `datetime.utcnow()`.
    """
    return datetime.now(timezone.utc).replace(tzinfo=None)


class Base(DeclarativeBase):
    pass


class Book(Base):
    __tablename__ = "books"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # Owner. Defaults to LOCAL_USER_ID so local single-user mode and existing rows (backfilled
    # via server_default on ADD COLUMN) "just work"; hosted mode sets it to the JWT sub.
    user_id: Mapped[str] = mapped_column(
        String, index=True, nullable=False,
        default=LOCAL_USER_ID, server_default=LOCAL_USER_ID,
    )
    # Stable Goodreads key. Uniqueness is now PER USER (see __table_args__) — two different
    # users can each import the same Goodreads book id; re-import within one user still upserts.
    goodreads_book_id: Mapped[str | None] = mapped_column(String, index=True)

    title: Mapped[str] = mapped_column(String, nullable=False)
    author: Mapped[str | None] = mapped_column(String)
    additional_authors: Mapped[str | None] = mapped_column(String)
    isbn13: Mapped[str | None] = mapped_column(String, index=True)

    # read | to-read | currently-reading | did-not-finish
    exclusive_shelf: Mapped[str | None] = mapped_column(String, index=True)

    goodreads_rating: Mapped[int] = mapped_column(Integer, default=0)  # 0 == unrated
    app_rating: Mapped[int | None] = mapped_column(Integer)  # authoritative once set
    # In-app text review. Goodreads exports carry ~no reviews, so once present this is a
    # strong, direct taste signal (the metadata-only profile predates having any).
    app_review: Mapped[str | None] = mapped_column(Text)
    # Bumped whenever the user re-rates or reviews in-app. Compared against
    # ProfileMeta.last_profiled_at to decide whether the taste profile is stale ("dirty").
    # Never set by Goodreads import — only by in-app feedback.
    feedback_updated_at: Mapped[datetime | None] = mapped_column(DateTime)
    exclude_from_profile: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")

    date_read: Mapped[date | None] = mapped_column(Date)
    date_added: Mapped[date | None] = mapped_column(Date)
    page_count: Mapped[int | None] = mapped_column(Integer)
    year_published: Mapped[int | None] = mapped_column(Integer)

    source: Mapped[str] = mapped_column(String, default="goodreads_import")

    enrichment: Mapped["Enrichment | None"] = relationship(
        back_populates="book", uselist=False, cascade="all, delete-orphan"
    )

    # Goodreads id is unique within a user, not globally (multi-tenant). NULLs (manual adds)
    # are treated as distinct by both SQLite and Postgres, so manual books don't collide.
    __table_args__ = (
        UniqueConstraint("user_id", "goodreads_book_id", name="uq_book_user_goodreads"),
    )

    @property
    def effective_rating(self) -> int | None:
        """app_rating wins once set; otherwise the imported Goodreads rating.

        Returns None when the book is unrated (so callers can exclude it from
        taste analysis cleanly).
        """
        if self.app_rating is not None:
            return self.app_rating
        return self.goodreads_rating or None


class Enrichment(Base):
    __tablename__ = "enrichment"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    book_id: Mapped[int] = mapped_column(ForeignKey("books.id"), unique=True, index=True)

    resolved_source: Mapped[str | None] = mapped_column(String)  # openlibrary | googlebooks
    resolved_id: Mapped[str | None] = mapped_column(String)
    subjects: Mapped[list | None] = mapped_column(JSON)
    series: Mapped[str | None] = mapped_column(String)
    series_position: Mapped[str | None] = mapped_column(String)
    description: Mapped[str | None] = mapped_column(Text)
    cover_url: Mapped[str | None] = mapped_column(String)

    resolution_confidence: Mapped[float] = mapped_column(Float, default=0.0)  # 0..1
    confidence_label: Mapped[str | None] = mapped_column(String)  # HIGH | MEDIUM | LOW
    match_method: Mapped[str | None] = mapped_column(String)  # how we matched
    raw_response: Mapped[dict | None] = mapped_column(JSON)
    resolved_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    book: Mapped[Book] = relationship(back_populates="enrichment")


class TasteTrait(Base):
    __tablename__ = "taste_traits"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[str] = mapped_column(
        String, index=True, nullable=False,
        default=LOCAL_USER_ID, server_default=LOCAL_USER_ID,
    )
    claim: Mapped[str] = mapped_column(Text, nullable=False)
    polarity: Mapped[str] = mapped_column(String)  # reward | aversion
    # Books that EXHIBIT the trait (a reward's high-rated examples, an aversion's
    # low-rated ones) vs. the CONTRAST books that anchor the distinction. Keeping them
    # separate is what makes a groundedness eval possible later.
    exhibits: Mapped[list | None] = mapped_column(JSON)
    contrasts: Mapped[list | None] = mapped_column(JSON)
    inference_confidence: Mapped[float] = mapped_column(Float, default=0.0)
    status: Mapped[str] = mapped_column(String, default="proposed")  # proposed|confirmed|rejected|edited
    user_note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    # NB: no explicit UniqueConstraint on `id` — it's already the primary key (unique by
    # definition). A redundant UNIQUE on the PK made `alembic revision --autogenerate` emit a
    # spurious create_unique_constraint into every migration, so it was removed.


class Recommendation(Base):
    """One book served by a recommend run.

    Phase 5 / two-stage recommender. Each row is a *real catalog* candidate that
    survived retrieval + dedupe and was reranked/explained by Claude — never an
    LLM-invented title. Persisting the served set (with its grounding) is what lets the
    later feedback phase manufacture labeled negatives from rejected recs and lets the
    UI show "why this".
    """

    __tablename__ = "recommendations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[str] = mapped_column(
        String, index=True, nullable=False,
        default=LOCAL_USER_ID, server_default=LOCAL_USER_ID,
    )
    # Groups the books served by a single recommend() run, so the latest run is one query.
    run_id: Mapped[str] = mapped_column(String, index=True, nullable=False)
    rank: Mapped[int] = mapped_column(Integer)  # 1-based position within the run

    title: Mapped[str] = mapped_column(String, nullable=False)
    author: Mapped[str | None] = mapped_column(String)
    year: Mapped[int | None] = mapped_column(Integer)
    isbn13: Mapped[str | None] = mapped_column(String)
    cover_url: Mapped[str | None] = mapped_column(String)
    subjects: Mapped[list | None] = mapped_column(JSON)
    description: Mapped[str | None] = mapped_column(Text)

    # Provenance: which catalog the candidate is real in, and how retrieval surfaced it.
    catalog_source: Mapped[str | None] = mapped_column(String)  # openlibrary | googlebooks
    catalog_id: Mapped[str | None] = mapped_column(String)
    retrieval_pool: Mapped[str | None] = mapped_column(String)  # metadata | claude_seed | both
    seed_reason: Mapped[str | None] = mapped_column(String)  # the subject/author/query that hit

    # Stage-2 (Claude rerank/explain) output, grounded in the taste profile.
    score: Mapped[float] = mapped_column(Float, default=0.0)  # 0..1 fit
    rationale: Mapped[str | None] = mapped_column(Text)
    grounded_trait_ids: Mapped[list | None] = mapped_column(JSON)
    grounded_book_ids: Mapped[list | None] = mapped_column(JSON)

    status: Mapped[str] = mapped_column(String, default="served")  # served|accepted|rejected|saved
    user_note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class EnrichJob(Base):
    """Background enrichment job, one row per queued run.

    Tracks the lifecycle of a `POST /enrich/start` request so the frontend can poll
    `GET /enrich/status/{job_id}` for real-time progress. The `progress` and `total`
    fields mirror the `(done, total)` values the `enrich_library` progress callback
    emits per-book — the status endpoint simply reads them.

    status values: pending -> running -> done | error
    """

    __tablename__ = "enrich_jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # Stable UUID returned to the client at enqueue time.
    job_id: Mapped[str] = mapped_column(String, unique=True, index=True, nullable=False)
    user_id: Mapped[str] = mapped_column(
        String, index=True, nullable=False,
        default=LOCAL_USER_ID, server_default=LOCAL_USER_ID,
    )
    status: Mapped[str] = mapped_column(String, default="pending")  # pending|running|done|error
    progress: Mapped[int] = mapped_column(Integer, default=0)   # books processed so far
    total: Mapped[int] = mapped_column(Integer, default=0)      # total books in this run
    started_at: Mapped[datetime | None] = mapped_column(DateTime)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime)
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class ProfileMeta(Base):
    """Per-user bookkeeping for the taste profile.

    Records when a user's profile was last (re)built so the app can tell whether in-app
    rating/review edits since then have left it stale. Previously a singleton (id=1); now
    one row per user, looked up by `user_id` (unique). `get_profile_meta` upserts it.
    """

    __tablename__ = "profile_meta"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[str] = mapped_column(
        String, unique=True, index=True, nullable=False,
        default=LOCAL_USER_ID, server_default=LOCAL_USER_ID,
    )
    last_profiled_at: Mapped[datetime | None] = mapped_column(DateTime)
    last_profile_kind: Mapped[str | None] = mapped_column(String)  # full | update


class UserSettings(Base):
    """Per-user settings — Anthropic API key and display name.

    The key is stored ENCRYPTED (AES-256-GCM via `crypto.py`) and decrypted only
    server-side at Claude-call time; it is never returned to the client. One row per user.
    In local single-user mode this table is usually empty and the engine falls back to the
    `ANTHROPIC_API_KEY` env var (see `user_settings.resolve_anthropic_key`).
    """

    __tablename__ = "user_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[str] = mapped_column(
        String, unique=True, index=True, nullable=False,
        default=LOCAL_USER_ID, server_default=LOCAL_USER_ID,
    )
    anthropic_api_key_encrypted: Mapped[str | None] = mapped_column(Text)
    display_name: Mapped[str | None] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime | None] = mapped_column(DateTime, onupdate=utcnow)


class Feedback(Base):
    """User-submitted feedback (bug reports, ideas, praise, confusing UX).

    Collected via the in-app FeedbackModal. Rows are append-only — no updates.
    `trigger` identifies which prompt surface fired (e.g. 'post-recs'); NULL means
    the user opened the modal manually (general surface). `run_id` is only set for
    post-recs feedback so the run can be cross-referenced later.
    """

    __tablename__ = "feedback"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[str] = mapped_column(
        String, index=True, nullable=False,
        default=LOCAL_USER_ID, server_default=LOCAL_USER_ID,
    )
    # bug | idea | confusing | praise
    category: Mapped[str] = mapped_column(String, nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    # Which prompt surface fired, or NULL for general (user-initiated) submissions.
    trigger: Mapped[str | None] = mapped_column(String, nullable=True)
    # Recommender run_id; only set for post-recs feedback.
    run_id: Mapped[str | None] = mapped_column(String, nullable=True)
    # Route path at submission time (e.g. '/swipe').
    page: Mapped[str | None] = mapped_column(String, nullable=True)
    # Build id or 'unknown'.
    app_version: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class FeedbackPromptState(Base):
    """Tracks whether a targeted feedback prompt has been shown/snoozed/submitted.

    One row per (user, trigger, run_id). `run_id` is '' (empty string, NOT NULL) for
    one-time triggers and the global dont_ask sentinel — using '' avoids the Postgres
    and SQLite gotcha where NULLs are treated as distinct in unique indexes, which would
    allow duplicate (user, trigger) rows to bypass the constraint.

    status values: ask_later | submitted | dont_ask
    """

    __tablename__ = "feedback_prompt_state"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[str] = mapped_column(
        String, nullable=False,
        default=LOCAL_USER_ID, server_default=LOCAL_USER_ID,
    )
    # post-setup | post-first-profile | post-recs
    trigger: Mapped[str] = mapped_column(String, nullable=False)
    # '' for one-time triggers and global dont_ask; run UUID for post-recs.
    # MUST be NOT NULL with default '' — see class docstring.
    run_id: Mapped[str] = mapped_column(String, nullable=False, default="", server_default="")
    # ask_later | submitted | dont_ask
    status: Mapped[str] = mapped_column(String, nullable=False)
    # Set only when status='ask_later'.
    snooze_until: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.now(), onupdate=utcnow)

    __table_args__ = (
        UniqueConstraint("user_id", "trigger", "run_id", name="uq_feedback_prompt_state"),
    )


class ReaderArchetype(Base):
    """Per-user reader personality archetype -- 4-axis code derived from taste traits.

    One row per user (unique on user_id -- upsert pattern same as ProfileMeta).
    Derived by Claude Haiku scoring the user's TasteTrait rows; re-derive any time.
    """

    __tablename__ = "reader_archetypes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[str] = mapped_column(
        String, nullable=False,
        default=LOCAL_USER_ID, server_default=LOCAL_USER_ID,
    )
    code: Mapped[str] = mapped_column(String, nullable=False)  # e.g. "IPBH"
    archetype_name: Mapped[str] = mapped_column(String, nullable=False)
    archetype_tagline: Mapped[str] = mapped_column(Text, nullable=False)
    axis_lens: Mapped[float] = mapped_column(Float, nullable=False)
    axis_engine: Mapped[float] = mapped_column(Float, nullable=False)
    axis_range: Mapped[float] = mapped_column(Float, nullable=False)
    axis_resonance: Mapped[float] = mapped_column(Float, nullable=False)
    lens_rationale: Mapped[str | None] = mapped_column(Text)
    engine_rationale: Mapped[str | None] = mapped_column(Text)
    range_rationale: Mapped[str | None] = mapped_column(Text)
    resonance_rationale: Mapped[str | None] = mapped_column(Text)
    derived_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    __table_args__ = (
        UniqueConstraint("user_id", name="uq_reader_archetype_user"),
    )


# --- engine / session plumbing ---------------------------------------------

_engine = None
_SessionLocal = None


def _ensure_engine():
    global _engine, _SessionLocal
    if _engine is None:
        settings = get_settings()
        _engine = create_engine(settings.db_url, future=True)
        _SessionLocal = sessionmaker(bind=_engine, expire_on_commit=False, future=True)
    return _engine, _SessionLocal


def _ensure_user_id_column(engine, table_name: str) -> None:
    """Add a `user_id` column to a pre-existing local table and backfill it to LOCAL_USER_ID.

    Local-SQLite convenience only (hosted Postgres uses Alembic). `DEFAULT '<local>'` means
    existing rows are backfilled to the local user automatically and new inserts that don't
    specify a user still land under the local tenant — so an old single-user DB keeps working.
    """
    from sqlalchemy import inspect as sa_inspect, text as sa_text

    insp = sa_inspect(engine)
    if table_name not in insp.get_table_names():
        return
    cols = {c["name"] for c in insp.get_columns(table_name)}
    if "user_id" not in cols:
        with engine.begin() as conn:
            conn.execute(
                sa_text(
                    f"ALTER TABLE {table_name} ADD COLUMN user_id VARCHAR "
                    f"NOT NULL DEFAULT '{LOCAL_USER_ID}'"
                )
            )


def init_db() -> None:
    """Ensure the local schema is current. No-op against hosted Postgres (Alembic owns that).

    In local SQLite mode this keeps the lightweight self-migration it always had, plus it
    now backfills a `user_id` column onto pre-existing tables so an old single-user DB is
    transparently upgraded to the multi-tenant shape under the LOCAL_USER_ID tenant.
    """
    from sqlalchemy import inspect as sa_inspect, text as sa_text

    engine, _ = _ensure_engine()

    # Hosted multi-tenant mode: Alembic migrations are the single source of truth for the
    # schema. Never run the drop+recreate / ADD COLUMN heuristics below against prod data.
    if get_settings().is_multi_tenant:
        return

    # Backfill user_id onto any pre-existing tables BEFORE inspecting columns below, so the
    # rest of this function (and the recommendations missing-column loop) sees it present.
    for _tbl in ("books", "taste_traits", "recommendations", "profile_meta", "enrich_jobs"):
        _ensure_user_id_column(engine, _tbl)

    insp = sa_inspect(engine)

    # Lightweight migration: books holds the only irreplaceable data (ratings, reviews),
    # so it is NEVER dropped. New nullable columns are added in place via ADD COLUMN.
    if "books" in insp.get_table_names():
        book_cols = {c["name"] for c in insp.get_columns("books")}
        with engine.begin() as conn:
            if "app_review" not in book_cols:
                conn.execute(sa_text("ALTER TABLE books ADD COLUMN app_review TEXT"))
            if "feedback_updated_at" not in book_cols:
                conn.execute(
                    sa_text("ALTER TABLE books ADD COLUMN feedback_updated_at DATETIME")
                )
            if "exclude_from_profile" not in book_cols:
                conn.execute(
                    sa_text("ALTER TABLE books ADD COLUMN exclude_from_profile BOOLEAN NOT NULL DEFAULT 0")
                )

    # Lightweight migration: taste_traits is fully regenerated by `profile`, so if its
    # columns are out of date (e.g. pre-exhibits/contrasts), drop and recreate it rather
    # than maintaining a migration tool for disposable data. books/enrichment are never
    # touched here.
    if "taste_traits" in insp.get_table_names():
        cols = {c["name"] for c in insp.get_columns("taste_traits")}
        if not {"exhibits", "contrasts"} <= cols:
            TasteTrait.__table__.drop(engine)
    # recommendations holds rejection history (status="rejected") which must survive
    # schema migrations — dropping the table loses the user's "not interested" decisions.
    # Strategy: if the table predates Phase 5 entirely (missing `run_id` or `status`),
    # it has no rejection data worth keeping, so drop and recreate. Otherwise add any
    # missing columns in place so rejection records are preserved.
    if "recommendations" in insp.get_table_names():
        cols = {c["name"] for c in insp.get_columns("recommendations")}
        if not {"run_id", "status"} <= cols:
            # Pre-Phase-5 table — safe to drop; no rejection history.
            Recommendation.__table__.drop(engine)
        else:
            # Modern table — add any missing columns rather than destroying rejection data.
            model_col_names = {c.name for c in Recommendation.__table__.columns}
            missing = model_col_names - cols
            if missing:
                with engine.begin() as conn:
                    for col_name in missing:
                        col = Recommendation.__table__.c[col_name]
                        type_str = col.type.compile(dialect=engine.dialect)
                        conn.execute(
                            sa_text(
                                f"ALTER TABLE recommendations ADD COLUMN {col_name} {type_str}"
                            )
                        )
    # Lightweight migration: user_settings gets new columns added in place.
    if "user_settings" in insp.get_table_names():
        us_cols = {c["name"] for c in insp.get_columns("user_settings")}
        with engine.begin() as conn:
            if "display_name" not in us_cols:
                conn.execute(sa_text("ALTER TABLE user_settings ADD COLUMN display_name VARCHAR"))

    Base.metadata.create_all(engine)


def get_session() -> Session:
    _, session_local = _ensure_engine()
    return session_local()


@contextmanager
def session_scope() -> Iterator[Session]:
    """`with session_scope() as s:` -- commit on success, rollback on error."""
    session = get_session()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
