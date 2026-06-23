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

from .config import get_settings


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
    # Stable Goodreads key; unique so re-import upserts instead of duplicating.
    goodreads_book_id: Mapped[str | None] = mapped_column(String, unique=True, index=True)

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

    date_read: Mapped[date | None] = mapped_column(Date)
    date_added: Mapped[date | None] = mapped_column(Date)
    page_count: Mapped[int | None] = mapped_column(Integer)
    year_published: Mapped[int | None] = mapped_column(Integer)

    source: Mapped[str] = mapped_column(String, default="goodreads_import")

    enrichment: Mapped["Enrichment | None"] = relationship(
        back_populates="book", uselist=False, cascade="all, delete-orphan"
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

    __table_args__ = (UniqueConstraint("id", name="uq_taste_trait_id"),)


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
    # Groups the books served by a single recommend() run, so the latest run is one query.
    run_id: Mapped[str] = mapped_column(String, index=True, nullable=False)
    rank: Mapped[int] = mapped_column(Integer)  # 1-based position within the run

    title: Mapped[str] = mapped_column(String, nullable=False)
    author: Mapped[str | None] = mapped_column(String)
    year: Mapped[int | None] = mapped_column(Integer)
    isbn13: Mapped[str | None] = mapped_column(String)
    cover_url: Mapped[str | None] = mapped_column(String)
    subjects: Mapped[list | None] = mapped_column(JSON)

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


class ProfileMeta(Base):
    """Single-row bookkeeping for the taste profile.

    Records when the profile was last (re)built so the app can tell whether in-app
    rating/review edits since then have left it stale. A row with id=1 is the only one;
    `get_profile_meta` upserts it.
    """

    __tablename__ = "profile_meta"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    last_profiled_at: Mapped[datetime | None] = mapped_column(DateTime)
    last_profile_kind: Mapped[str | None] = mapped_column(String)  # full | update


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


def init_db() -> None:
    """Create tables if they don't exist (and migrate taste_traits if its shape changed)."""
    from sqlalchemy import inspect as sa_inspect, text as sa_text

    engine, _ = _ensure_engine()
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
    Base.metadata.create_all(engine)


def get_session() -> Session:
    _, session_local = _ensure_engine()
    return session_local()


@contextmanager
def session_scope() -> Iterator[Session]:
    """`with session_scope() as s:` — commit on success, rollback on error."""
    session = get_session()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
