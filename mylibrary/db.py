"""Database: SQLAlchemy 2.0 models and session management.

The schema follows the build plan (Section 6). MVP1 implements books, enrichment,
and taste_traits. recommendations / feedback_events come in a later phase.

This Python side OWNS the schema/migrations. When the Next.js frontend is added it
should READ this database (or call the API), not run its own migrations against it —
that keeps the cross-language seam clean (one source of truth for the schema).
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import date, datetime
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
    supporting_book_ids: Mapped[list | None] = mapped_column(JSON)
    inference_confidence: Mapped[float] = mapped_column(Float, default=0.0)
    status: Mapped[str] = mapped_column(String, default="proposed")  # proposed|confirmed|rejected|edited
    user_note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    __table_args__ = (UniqueConstraint("id", name="uq_taste_trait_id"),)


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
    """Create tables if they don't exist."""
    engine, _ = _ensure_engine()
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
