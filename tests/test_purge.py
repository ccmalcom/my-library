"""Tests for the bulk data-removal operations (mylibrary/purge.py).

Covers the cascade contract — clear_profile keeps books, clear_library cascades to the
profile, delete_account removes everything incl. the stored key — and the critical
multi-tenant invariant: a purge for one user never touches another user's rows.
"""

from __future__ import annotations

from mylibrary import library, purge
from mylibrary.db import (
    Book,
    EnrichJob,
    Enrichment,
    ProfileMeta,
    Recommendation,
    TasteSignal,
    TasteTrait,
    UsageEvent,
    UserSettings,
    session_scope,
)


def _seed(user_id: str) -> None:
    """Give `user_id` two enriched books plus a trait, rec, profile_meta, stored key,
    taste signal, and enrich job."""
    library.add_book(
        title="Dune", author="Frank Herbert", rating=5,
        subjects=["science fiction"], cover_url="http://x/dune.jpg", user_id=user_id,
    )
    library.add_book(
        title="Hyperion", author="Dan Simmons", rating=4,
        subjects=["science fiction"], cover_url="http://x/hyp.jpg", user_id=user_id,
    )
    with session_scope() as s:
        s.add(TasteTrait(user_id=user_id, claim="rewards big-idea sci-fi", polarity="reward"))
        s.add(Recommendation(user_id=user_id, run_id="run-1", rank=1, title="Foundation"))
        s.add(ProfileMeta(user_id=user_id, last_profile_kind="full"))
        s.add(UserSettings(user_id=user_id, anthropic_api_key_encrypted="enc-blob"))
        s.add(TasteSignal(user_id=user_id, direction="more", target_kind="book", target_book_id=1))
        s.add(EnrichJob(user_id=user_id, job_id=f"job-{user_id}", status="done"))
        s.add(UsageEvent(user_id=user_id, model="claude-sonnet-5", operation="recommend_rerank"))


def _counts(user_id: str) -> dict:
    with session_scope() as s:
        return {
            "books": s.query(Book).filter(Book.user_id == user_id).count(),
            "enrich": (
                s.query(Enrichment)
                .join(Book, Enrichment.book_id == Book.id)
                .filter(Book.user_id == user_id)
                .count()
            ),
            "traits": s.query(TasteTrait).filter(TasteTrait.user_id == user_id).count(),
            "recs": s.query(Recommendation).filter(Recommendation.user_id == user_id).count(),
            "meta": s.query(ProfileMeta).filter(ProfileMeta.user_id == user_id).count(),
            "settings": s.query(UserSettings).filter(UserSettings.user_id == user_id).count(),
            "signals": s.query(TasteSignal).filter(TasteSignal.user_id == user_id).count(),
            "jobs": s.query(EnrichJob).filter(EnrichJob.user_id == user_id).count(),
            "usage_events": s.query(UsageEvent).filter(UsageEvent.user_id == user_id).count(),
        }


def test_seed_is_complete():
    _seed("local")
    c = _counts("local")
    assert c == {
        "books": 2, "enrich": 2, "traits": 1, "recs": 1, "meta": 1, "settings": 1,
        "signals": 1, "jobs": 1, "usage_events": 1,
    }


def test_clear_profile_keeps_books():
    _seed("local")
    result = purge.clear_profile()
    assert result["traits_removed"] == 1
    assert result["recommendations_removed"] == 1
    c = _counts("local")
    assert c["traits"] == 0 and c["recs"] == 0 and c["meta"] == 0
    # Library + settings untouched.
    assert c["books"] == 2 and c["enrich"] == 2 and c["settings"] == 1
    # TasteSignal, EnrichJob, and UsageEvent are durable — clear_profile must not remove them.
    assert c["signals"] == 1 and c["jobs"] == 1 and c["usage_events"] == 1


def test_clear_library_cascades_to_profile():
    _seed("local")
    result = purge.clear_library()
    assert result["books_removed"] == 2
    c = _counts("local")
    # Books, enrichments, and all derived taste data gone…
    assert c["books"] == 0 and c["enrich"] == 0
    assert c["traits"] == 0 and c["recs"] == 0 and c["meta"] == 0
    # …but the stored API key and durable signals/jobs/usage survive a library clear.
    assert c["settings"] == 1
    assert c["signals"] == 1 and c["jobs"] == 1 and c["usage_events"] == 1


def test_clear_library_keeps_taste_signal_and_jobs():
    """TasteSignal, EnrichJob, and UsageEvent are durable — clear_library must not remove them."""
    _seed("local")
    purge.clear_library()
    c = _counts("local")
    assert c["signals"] == 1
    assert c["jobs"] == 1
    assert c["usage_events"] == 1


def test_delete_account_removes_everything():
    _seed("local")
    result = purge.delete_account()
    assert result["settings_removed"] == 1
    assert result["signals_removed"] == 1
    assert result["jobs_removed"] == 1
    assert result["usage_events_removed"] == 1
    assert _counts("local") == {
        "books": 0, "enrich": 0, "traits": 0, "recs": 0, "meta": 0, "settings": 0,
        "signals": 0, "jobs": 0, "usage_events": 0,
    }


def test_purge_is_user_scoped():
    _seed("local")
    _seed("other-user")

    purge.delete_account(user_id="local")

    # Local is wiped; the other tenant is fully intact.
    assert _counts("local")["books"] == 0
    assert _counts("other-user") == {
        "books": 2, "enrich": 2, "traits": 1, "recs": 1, "meta": 1, "settings": 1,
        "signals": 1, "jobs": 1, "usage_events": 1,
    }
