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


class BookOut(BaseModel):
    id: int
    title: str
    author: str | None
    isbn13: str | None
    exclusive_shelf: str | None
    goodreads_rating: int
    app_rating: int | None
    effective_rating: int | None
    year_published: int | None
    page_count: int | None
    date_read: date | None
    confidence_label: str | None = None
    resolution_confidence: float | None = None

    class Config:
        from_attributes = True


class TraitOut(BaseModel):
    id: int
    claim: str
    polarity: str
    supporting_book_ids: list[int] | None
    inference_confidence: float
    status: str
    user_note: str | None
    created_at: datetime

    class Config:
        from_attributes = True
