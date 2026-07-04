"""Pydantic response models for the FastAPI layer.

These define the JSON contract the future TypeScript frontend will consume over HTTP
(the Pattern-B seam). Keep them stable and explicit.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


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
    reject_reasons: list[str] | None = None


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
    is_favorite: bool | None = None  # None = leave unchanged


class ShelfRequest(BaseModel):
    """Move a book to a different shelf (PATCH /books/{id}/shelf)."""

    shelf: str  # to-read | currently-reading | read | did-not-finish


class CatalogResult(BaseModel):
    """One hit from the manual add-a-book search (GET /catalog/search).

    A real catalog candidate the user can pick; its fields are passed straight back into
    POST /books so the added book carries the cover/subjects/isbn from the chosen result,
    or into PATCH /books/{id}/enrichment to fix a mis-resolved match (Wave 3c).
    """

    source: str  # openlibrary | googlebooks
    catalog_id: str | None = None
    title: str
    author: str | None = None
    year: int | None = None
    isbn13: str | None = None
    cover_url: str | None = None
    subjects: list[str] | None = None
    description: str | None = None


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


class EnrichmentCorrectionRequest(BaseModel):
    """Body for PATCH /books/{book_id}/enrichment — re-point a mis-resolved
    enrichment at a user-picked catalog match (Wave 3c "fix match" queue).

    catalog_source/catalog_id must come from a real GET /catalog/search hit
    (locked decision: no invented titles) — both are required. The book's own
    title/author/rating/review are untouched; only catalog-derived enrichment
    fields are replaced. description is always applied, even None, so a stale
    wrong synopsis never survives a correction.
    """

    catalog_source: str
    catalog_id: str
    cover_url: str | None = None
    subjects: list[str] | None = None
    description: str | None = None


class TraitUpdateRequest(BaseModel):
    """Update a taste trait's claim text, user note, status, or weight (PATCH /profile/traits/{id})."""

    claim: str | None = None
    user_note: str | None = None
    status: Literal["confirmed", "rejected"] | None = None
    user_weight: float | None = Field(default=None, ge=0.0, le=1.0)


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
    is_favorite: bool = False

    model_config = ConfigDict(from_attributes=True)


class TraitOut(BaseModel):
    id: int
    claim: str
    reveal_line: str | None = None
    polarity: str
    exhibits: list[int] | None
    contrasts: list[int] | None
    inference_confidence: float
    status: str
    user_note: str | None
    user_weight: float | None
    verdict_updated_at: datetime | None
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


class SimilarRequest(BaseModel):
    """Body for POST /books/{book_id}/similar."""

    n: int = Field(default=8, ge=1, le=20)


class SimilarBookOut(BaseModel):
    """One ephemeral 'more like this' result (not persisted)."""

    rank: int
    title: str
    author: str | None = None
    year: int | None = None
    isbn13: str | None = None
    cover_url: str | None = None
    subjects: list[str] | None = None
    description: str | None = None
    catalog_source: str | None = None
    catalog_id: str | None = None
    retrieval_pool: str | None = None
    seed_reason: str | None = None
    score: float
    rationale: str | None = None


class SimilarBooksOut(BaseModel):
    """Response for POST /books/{book_id}/similar — an ephemeral ranked list."""

    anchor_book_id: int
    anchor_title: str
    count: int
    model: str
    seed_queries: list[str]
    recommendations: list[SimilarBookOut]


class DiscoverRequest(BaseModel):
    """Body for POST /discover — a natural-language book request."""

    query: str = Field(min_length=1, max_length=500)
    n: int = Field(default=10, ge=1, le=20)


class DiscoverBookOut(BaseModel):
    """One ephemeral NL-discovery result (not persisted)."""

    rank: int
    title: str
    author: str | None = None
    year: int | None = None
    isbn13: str | None = None
    cover_url: str | None = None
    subjects: list[str] | None = None
    description: str | None = None
    catalog_source: str | None = None
    catalog_id: str | None = None
    retrieval_pool: str | None = None
    seed_reason: str | None = None
    score: float
    rationale: str | None = None


class DiscoverResult(BaseModel):
    """Response for POST /discover — an ephemeral ranked list answering the request."""

    query: str
    interpretation: str
    count: int
    model: str
    queries: list[str]
    recommendations: list[DiscoverBookOut]


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


class UsageOut(BaseModel):
    """Month-to-date Anthropic spend for the caller + a soft-warn flag. Read-only; never blocks."""

    spent_usd: float
    cap_usd: float
    pct: float
    warn: bool
    by_operation: dict[str, float]


class FormatMixOut(BaseModel):
    novel: int
    novella: int
    collection: int
    series: int
    dominant: str | None
    low_confidence: bool


class GenreHighlightOut(BaseModel):
    subject: str
    share: float


class EraSplitOut(BaseModel):
    pre_2000: int
    post_2000: int


class ProfileHighlightsOut(BaseModel):
    """Computed shelf highlights for the reveal's Beat 5 (no external calls)."""

    thin: bool
    n_authors: int
    top_genres: list[GenreHighlightOut]
    top_authors: list[str]
    format_mix: FormatMixOut
    era_split: EraSplitOut | None


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
    hook: str            # extends the tagline for Beat 7: "You're the one who {hook}."
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


class TasteSignalRequest(BaseModel):
    """Body for POST /taste-signal — record a more/less-like-this preference.

    direction: "more" to want more like this, "less" to want fewer like this.
    target_kind: "book" for a library book (requires target_book_id), "rec" for a
      served recommendation (requires snapshot with at least title/author).
    target_book_id: id of the user's own Book row (required for book kind).
    snapshot: JSON snapshot of the rec's title/author/subjects (required for rec kind).
    """

    direction: Literal["more", "less"]
    target_kind: Literal["book", "rec"]
    target_book_id: int | None = None
    snapshot: dict | None = None


class TasteSignalOut(BaseModel):
    """Response for POST /taste-signal."""

    id: int
    direction: str
    target_kind: str
    target_book_id: int | None
    snapshot: dict | None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ImportPreviewOut(BaseModel):
    """Detected format + headers + sample rows for the import mapping UI."""

    format: str  # goodreads | storygraph | canonical | unknown
    headers: list[str]
    sample_rows: list[dict[str, str]]
    suggested_mapping: dict[str, str | None]


class ImportSummaryOut(BaseModel):
    format: str
    total_rows: int
    skipped: int
    inserted: int
    updated: int
    rated: int


class InviteRequest(BaseModel):
    email: str
    # Beta launch: the admin supplies the Anthropic key, so it's convenient to pre-provision it
    # (and the user's display name) at invite time rather than making them do it in setup.
    display_name: str | None = None
    anthropic_api_key: str | None = Field(default=None, repr=False)


class InviteOut(BaseModel):
    id: int
    email: str
    status: str
    supabase_user_id: str | None = None
    invited_by: str | None = None
    created_at: datetime | None = None
    revoked_at: datetime | None = None


class AdminUserOut(InviteOut):
    book_count: int = 0


class RevokeRequest(BaseModel):
    supabase_user_id: str


class AdminMeOut(BaseModel):
    is_admin: bool


# RecFeedbackResult forward-references BookOut (defined above); resolve it now.
RecFeedbackResult.model_rebuild()
