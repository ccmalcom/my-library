"""Pydantic response models for the FastAPI layer.

These define the JSON contract the future TypeScript frontend will consume over HTTP
(the Pattern-B seam). Keep them stable and explicit.
"""

from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel


class IngestRequest(BaseModel):
    csv_path: str | None = None  # defaults to data/goodreads_library_export.csv


class EnrichRequest(BaseModel):
    force: bool = False
    limit: int | None = None
    include_unrated: bool = False


class RecommendRequest(BaseModel):
    n: int = 10
    use_metadata: bool = True
    use_claude_seeds: bool = True


class FeedbackRequest(BaseModel):
    status: str  # "accepted" | "rejected"
    user_note: str | None = None


class BookFeedbackRequest(BaseModel):
    """In-app re-rate / review for a library book (PATCH /books/{id}).

    rating: 1-5 to set, 0 to clear the in-app rating, None to leave unchanged.
    review: text to set, None to leave unchanged; clear_review removes it.
    """

    rating: int | None = None
    review: str | None = None
    clear_review: bool = False


class ProfileStatusOut(BaseModel):
    dirty: bool
    changed_books: int
    changed_book_ids: list[int]
    last_profiled_at: datetime | None
    last_profile_kind: str | None


class BookOut(BaseModel):
    id: int
    title: str
    author: str | None
    isbn13: str | None
    exclusive_shelf: str | None
    goodreads_rating: int
    app_rating: int | None
    app_review: str | None = None
    effective_rating: int | None
    year_published: int | None
    page_count: int | None
    date_read: date | None
    date_added: date | None = None
    cover_url: str | None = None
    confidence_label: str | None = None
    resolution_confidence: float | None = None

    class Config:
        from_attributes = True


class TraitOut(BaseModel):
    id: int
    claim: str
    polarity: str
    exhibits: list[int] | None
    contrasts: list[int] | None
    inference_confidence: float
    status: str
    user_note: str | None
    created_at: datetime

    class Config:
        from_attributes = True


class RecommendationOut(BaseModel):
    id: int
    run_id: str
    rank: int
    title: str
    author: str | None
    year: int | None
    isbn13: str | None
    cover_url: str | None
    subjects: list[str] | None
    catalog_source: str | None
    catalog_id: str | None
    retrieval_pool: str | None
    seed_reason: str | None
    score: float
    rationale: str | None
    grounded_trait_ids: list[int] | None
    grounded_book_ids: list[int] | None
    status: str
    user_note: str | None
    created_at: datetime

    class Config:
        from_attributes = True
