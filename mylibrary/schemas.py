"""Pydantic response models for the FastAPI layer.

These define the JSON contract the future TypeScript frontend will consume over HTTP
(the Pattern-B seam). Keep them stable and explicit.
"""

from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel, ConfigDict


class IngestRequest(BaseModel):
    csv_path: str | None = None  # defaults to data/goodreads_library_export.csv


class EnrichRequest(BaseModel):
    force: bool = False
    limit: int | None = None
    include_unrated: bool = False


class EnrichStartRequest(BaseModel):
    """Body for POST /enrich/start — enqueues an enrichment background job."""

    force: bool = False
    limit: int | None = None


class EnrichJobOut(BaseModel):
    """Status of a background enrichment job (GET /enrich/status/{job_id}).

    status: pending -> running -> done | error
    progress: books resolved so far in this run (0 while pending).
    total: books scheduled for this run (0 until the job starts and announces it).
    """

    job_id: str
    status: str
    progress: int
    total: int
    error: str | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None

    model_config = ConfigDict(from_attributes=True)


class RecommendRequest(BaseModel):
    n: int = 10
    use_metadata: bool = True
    use_claude_seeds: bool = True


class FeedbackRequest(BaseModel):
    status: str | None = None  # "accepted" | "rejected" | "already_read"; omit to update only user_note
    user_note: str | None = None


class RecFeedbackResult(BaseModel):
    """Result of a swipe decision (PATCH /recommendations/{id}/feedback).

    `book` is the library book the decision created or matched: the to-read book for
    `accepted`, the read book for `already_read` (so the UI can prompt a review), and
    None for `rejected`.
    """

    status: str
    user_note: str | None = None
    book: "BookOut | None" = None


class BookFeedbackRequest(BaseModel):
    """In-app re-rate / review for a library book (PATCH /books/{id}).

    rating: 1-5 to set, 0 to clear the in-app rating, None to leave unchanged.
    review: text to set, None to leave unchanged; clear_review removes it.
    date_read: ISO date the book was read (optional), None to leave unchanged.
    """

    rating: int | None = None
    review: str | None = None
    clear_review: bool = False
    date_read: date | None = None
    exclude_from_profile: bool | None = None  # None = leave unchanged


class ShelfRequest(BaseModel):
    """Move a book to a different shelf (PATCH /books/{id}/shelf)."""

    shelf: str  # to-read | currently-reading | read | did-not-finish


class CatalogResult(BaseModel):
    """One hit from the manual add-a-book search (GET /catalog/search).

    A real catalog candidate the user can pick; its fields are passed straight back into
    POST /books so the added book carries the cover/subjects/isbn from the chosen result.
    """

    source: str  # openlibrary | googlebooks
    catalog_id: str | None = None
    title: str
    author: str | None = None
    year: int | None = None
    isbn13: str | None = None
    cover_url: str | None = None
    subjects: list[str] | None = None


class AddBookRequest(BaseModel):
    """Manually add a book to the library (POST /books).

    title is required; the rest typically come from the picked CatalogResult. rating is
    1-5 (or omitted/0 for unrated); review is optional free text; shelf defaults to the
    read shelf.
    """

    title: str
    author: str | None = None
    year: int | None = None
    isbn13: str | None = None
    shelf: str = "read"
    rating: int | None = None
    review: str | None = None
    cover_url: str | None = None
    subjects: list[str] | None = None
    catalog_source: str | None = None
    catalog_id: str | None = None


class TraitUpdateRequest(BaseModel):
    """Update a taste trait's claim text and/or user note (PATCH /profile/traits/{id})."""

    claim: str | None = None
    user_note: str | None = None


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
    description: str | None = None
    confidence_label: str | None = None
    resolution_confidence: float | None = None
    exclude_from_profile: bool = False

    model_config = ConfigDict(from_attributes=True)


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

    model_config = ConfigDict(from_attributes=True)


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
    description: str | None
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

    model_config = ConfigDict(from_attributes=True)


class ApiKeyRequest(BaseModel):
    """Body for setting the per-user Anthropic key. The key is encrypted at rest and
    never read back — there is no field that returns it."""

    api_key: str


class ApiKeyStatus(BaseModel):
    """Whether the user has a usable Anthropic key (stored or env fallback). Never the key."""

    configured: bool


class UserProfileRequest(BaseModel):
    """Body for updating the user's display name."""

    display_name: str


class UserProfileOut(BaseModel):
    """User profile info returned to the client."""

    display_name: str | None


class ArchetypeAxisOut(BaseModel):
    """One axis score for the reader archetype (lens / engine / range / resonance)."""

    score: float
    letter: str          # winning pole letter, e.g. "I" or "R"
    rationale: str | None


class ArchetypeOut(BaseModel):
    """Reader archetype result returned by GET/POST /profile/archetype."""

    code: str            # e.g. "IPBH"
    name: str            # e.g. "The Wandering Escapist"
    tagline: str
    lens: ArchetypeAxisOut
    engine: ArchetypeAxisOut
    range: ArchetypeAxisOut
    resonance: ArchetypeAxisOut
    derived_at: datetime
    is_stale: bool       # True when derived_at < ProfileMeta.last_profiled_at


class FeedbackSubmit(BaseModel):
    """Body for POST /feedback -- user-submitted bug/idea/confusing/praise."""

    category: str
    body: str
    trigger: str | None = None
    run_id: str | None = None
    page: str | None = None
    app_version: str | None = None


class FeedbackDismiss(BaseModel):
    """Body for POST /feedback/dismiss -- snooze or permanently silence a prompt."""

    trigger: str
    run_id: str | None = None
    mode: str  # "ask_later" | "dont_ask"


# RecFeedbackResult forward-references BookOut (defined above); resolve it now.
RecFeedbackResult.model_rebuild()
