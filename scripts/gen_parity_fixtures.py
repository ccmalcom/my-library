#!/usr/bin/env python3
"""Generate wave-1 parity fixtures: seed an ISOLATED SQLite library, record real
FastAPI responses for every read-only route, and write both files for vitest.

Run from the repo root:  python scripts/gen_parity_fixtures.py

Isolation: env overrides are set to EMPTY STRINGS before importing mylibrary
(python-dotenv only respects already-set vars — `unset` would be backfilled
from .env and hit the real dev Postgres). ANTHROPIC_API_KEY is popped AFTER
import so the empty stage reports configured=false.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from datetime import date, datetime, timedelta
from pathlib import Path

# Running as `python scripts/gen_parity_fixtures.py` puts this file's own directory
# (scripts/) on sys.path[0], not the repo root — so a bare `import mylibrary` fails
# even when invoked from the repo root as documented. Put the repo root on sys.path
# before anything below tries to import mylibrary. (Same gap pre-existing in
# scripts/gen_crypto_fixture.py; fixed here, not touching that file.)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

FIXED_TEST_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="

os.environ["DATABASE_URL"] = ""
os.environ["SUPABASE_URL"] = ""
os.environ["SUPABASE_JWKS_URL"] = ""
os.environ["SUPABASE_JWT_SECRET"] = ""
os.environ["REDIS_URL"] = ""
os.environ["ENCRYPTION_KEY"] = FIXED_TEST_KEY
os.environ["MYLIBRARY_MONTHLY_SOFT_CAP_USD"] = "5.0"
os.environ["MYLIBRARY_USAGE_WARN_THRESHOLD"] = "0.8"
os.environ["ANTHROPIC_API_KEY"] = "placeholder-cleared-below"
os.environ["MYLIBRARY_DATA_DIR"] = tempfile.mkdtemp(prefix="parity-fixtures-")

from mylibrary import config as _config  # noqa: E402

os.environ.pop("ANTHROPIC_API_KEY", None)
if hasattr(_config.get_settings, "cache_clear"):
    _config.get_settings.cache_clear()

settings = _config.get_settings()
assert not settings.is_multi_tenant and not settings.auth_enabled, (
    f"NOT ISOLATED — refusing to run: {settings.db_url}"
)
assert settings.db_url.startswith("sqlite"), f"expected sqlite, got {settings.db_url}"

from fastapi.testclient import TestClient  # noqa: E402

from mylibrary import crypto  # noqa: E402
from mylibrary.api import app  # noqa: E402
from mylibrary.db import (  # noqa: E402
    Book,
    Enrichment,
    Feedback,
    FeedbackPromptState,
    ProfileMeta,
    ReaderArchetype,
    Recommendation,
    TasteSignal,
    TasteTrait,
    UsageEvent,
    UserDirective,
    UserSettings,
    init_db,
    session_scope,
)

OUT_DIR = Path("frontend/lib/server/__tests__/fixtures/parity")

REQUESTS = [
    "GET /stats",
    "GET /books",
    "GET /books?rated_only=true",
    "GET /books?shelf=read",
    "GET /books?limit=3&offset=2",
    "GET /profile",
    "GET /profile/status",
    "GET /profile/subjects",
    "GET /profile/highlights",
    "GET /profile/archetype",
    "GET /recommendations",
    "GET /recommendations/rejected",
    "GET /settings/api-key/status",
    "GET /settings/profile",
    "GET /settings/usage",
    "GET /directive",
]

# --- the deterministic dataset -------------------------------------------------
# Timestamps are fixed strings EXCEPT usage_events.created_at, which uses the
# {"$hoursAgo": N} sentinel so month-to-date math holds whenever tests run.
# All ids are explicit so cross-references (enrichment.book_id, exhibits) are stable.

SEED: dict = {
    "books": [
        {"id": 1, "user_id": "local", "title": "Dune", "author": "Frank Herbert", "isbn13": "9780441013593", "exclusive_shelf": "read", "goodreads_rating": 5, "app_rating": None, "app_review": None, "feedback_updated_at": None, "date_read": "2025-11-02", "date_added": "2025-10-01", "page_count": 412, "year_published": 1965, "source": "goodreads", "exclude_from_profile": False, "is_favorite": False, "goodreads_book_id": "gr-1"},
        {"id": 2, "user_id": "local", "title": "The Dispossessed", "author": "Ursula K. Le Guin", "isbn13": "9780061054884", "exclusive_shelf": "read", "goodreads_rating": 5, "app_rating": None, "app_review": None, "feedback_updated_at": "2026-07-15T10:00:00", "date_read": None, "date_added": None, "page_count": 387, "year_published": 1974, "source": "goodreads", "exclude_from_profile": False, "is_favorite": True, "goodreads_book_id": "gr-2"},
        {"id": 3, "user_id": "local", "title": "Project Hail Mary", "author": "Andy Weir", "isbn13": "9780593135204", "exclusive_shelf": "read", "goodreads_rating": 4, "app_rating": 5, "app_review": "Loved the problem-solving.", "feedback_updated_at": "2026-07-20T09:30:00", "date_read": None, "date_added": None, "page_count": 476, "year_published": 2021, "source": "goodreads", "exclude_from_profile": False, "is_favorite": False, "goodreads_book_id": "gr-3"},
        {"id": 4, "user_id": "local", "title": "The Left Hand of Darkness", "author": "Ursula K. Le Guin", "isbn13": None, "exclusive_shelf": "read", "goodreads_rating": 4, "app_rating": None, "app_review": None, "feedback_updated_at": None, "date_read": None, "date_added": None, "page_count": 304, "year_published": 1969, "source": "goodreads", "exclude_from_profile": False, "is_favorite": False, "goodreads_book_id": "gr-4"},
        {"id": 5, "user_id": "local", "title": "Foundation", "author": "Isaac Asimov", "isbn13": None, "exclusive_shelf": "read", "goodreads_rating": 3, "app_rating": None, "app_review": None, "feedback_updated_at": None, "date_read": None, "date_added": None, "page_count": 244, "year_published": 1951, "source": "goodreads", "exclude_from_profile": False, "is_favorite": False, "goodreads_book_id": "gr-5"},
        {"id": 6, "user_id": "local", "title": "Gideon the Ninth", "author": "Tamsyn Muir", "isbn13": None, "exclusive_shelf": "read", "goodreads_rating": 2, "app_rating": None, "app_review": None, "feedback_updated_at": None, "date_read": None, "date_added": None, "page_count": 448, "year_published": 2019, "source": "goodreads", "exclude_from_profile": False, "is_favorite": False, "goodreads_book_id": "gr-6"},
        {"id": 7, "user_id": "local", "title": "The Hobbit", "author": "J.R.R. Tolkien", "isbn13": None, "exclusive_shelf": "read", "goodreads_rating": 0, "app_rating": 5, "app_review": None, "feedback_updated_at": "2026-06-01T08:00:00", "date_read": None, "date_added": None, "page_count": 310, "year_published": 1937, "source": "goodreads", "exclude_from_profile": False, "is_favorite": False, "goodreads_book_id": "gr-7"},
        {"id": 8, "user_id": "local", "title": "Piranesi", "author": "Susanna Clarke", "isbn13": None, "exclusive_shelf": "to-read", "goodreads_rating": 0, "app_rating": None, "app_review": None, "feedback_updated_at": None, "date_read": None, "date_added": None, "page_count": 272, "year_published": 2020, "source": "goodreads", "exclude_from_profile": False, "is_favorite": False, "goodreads_book_id": "gr-8"},
        {"id": 9, "user_id": "local", "title": "Too Like the Lightning", "author": "Ada Palmer", "isbn13": None, "exclusive_shelf": "did-not-finish", "goodreads_rating": 0, "app_rating": None, "app_review": None, "feedback_updated_at": "2026-07-18T14:00:00", "date_read": None, "date_added": None, "page_count": 432, "year_published": 2016, "source": "goodreads", "exclude_from_profile": False, "is_favorite": False, "goodreads_book_id": "gr-9"},
        {"id": 10, "user_id": "local", "title": "The Emperor's Soul", "author": "Brandon Sanderson", "isbn13": None, "exclusive_shelf": "read", "goodreads_rating": 4, "app_rating": None, "app_review": None, "feedback_updated_at": None, "date_read": None, "date_added": None, "page_count": 96, "year_published": 2012, "source": "goodreads", "exclude_from_profile": False, "is_favorite": False, "goodreads_book_id": "gr-10"},
        {"id": 11, "user_id": "local", "title": "Exhalation", "author": "Ted Chiang", "isbn13": None, "exclusive_shelf": "read", "goodreads_rating": 5, "app_rating": None, "app_review": None, "feedback_updated_at": None, "date_read": None, "date_added": None, "page_count": 368, "year_published": 2019, "source": "goodreads", "exclude_from_profile": False, "is_favorite": False, "goodreads_book_id": "gr-11"},
        {"id": 12, "user_id": "local", "title": "The Fifth Season", "author": "N.K. Jemisin", "isbn13": None, "exclusive_shelf": "read", "goodreads_rating": 5, "app_rating": None, "app_review": None, "feedback_updated_at": None, "date_read": None, "date_added": None, "page_count": 468, "year_published": 2015, "source": "goodreads", "exclude_from_profile": False, "is_favorite": False, "goodreads_book_id": "gr-12"},
        {"id": 13, "user_id": "local", "title": "Kindred", "author": "Octavia E. Butler", "isbn13": None, "exclusive_shelf": "read", "goodreads_rating": 5, "app_rating": None, "app_review": None, "feedback_updated_at": None, "date_read": None, "date_added": None, "page_count": None, "year_published": 1979, "source": "goodreads", "exclude_from_profile": False, "is_favorite": False, "goodreads_book_id": "gr-13"},
        {"id": 14, "user_id": "local", "title": "Small Gods", "author": "Terry Pratchett", "isbn13": None, "exclusive_shelf": "read", "goodreads_rating": 4, "app_rating": None, "app_review": None, "feedback_updated_at": None, "date_read": None, "date_added": None, "page_count": 389, "year_published": 1992, "source": "goodreads", "exclude_from_profile": False, "is_favorite": False, "goodreads_book_id": "gr-14"},
        # --- second tenant ("other") --------------------------------------------
        # Exists purely to prove wave-1 Node routes scope every query by userId: the
        # Python backend only ever authenticates as 'local' in local mode, so none of
        # this should ever appear in a recorded response — see gen_parity_fixtures.py
        # module docstring / CLAUDE.md fix log. IDs use a 100+ offset so they can never
        # collide with the 'local' tenant's rows above.
        {"id": 101, "user_id": "other", "title": "Someone Else's Book", "author": "Other Author", "isbn13": None, "exclusive_shelf": "read", "goodreads_rating": 5, "app_rating": None, "app_review": None, "feedback_updated_at": None, "date_read": None, "date_added": None, "page_count": 300, "year_published": 2000, "source": "goodreads", "exclude_from_profile": False, "is_favorite": False, "goodreads_book_id": "gr-other-1"},
        {"id": 102, "user_id": "other", "title": "Another Tenant's Book", "author": "Other Author Two", "isbn13": None, "exclusive_shelf": "read", "goodreads_rating": 4, "app_rating": None, "app_review": None, "feedback_updated_at": None, "date_read": None, "date_added": None, "page_count": 250, "year_published": 2005, "source": "goodreads", "exclude_from_profile": False, "is_favorite": False, "goodreads_book_id": "gr-other-2"},
    ],
    # Book 9 (DNF) and book 14 deliberately have NO enrichment row.
    "enrichment": [
        {"id": 1, "book_id": 1, "resolved_source": "openlibrary", "resolved_id": "/works/OL893415W", "subjects": ["science fiction", "space opera", "politics"], "series": None, "series_position": None, "description": "Melange, sandworms, prophecy.", "cover_url": "https://covers.example/dune.jpg", "resolution_confidence": 0.95, "confidence_label": "HIGH", "match_method": "isbn:openlibrary", "resolved_at": "2026-05-01T12:00:00"},
        {"id": 2, "book_id": 2, "resolved_source": "openlibrary", "resolved_id": "/works/OL59711W", "subjects": ["science fiction", "utopian fiction", "anarchism"], "series": None, "series_position": None, "description": "An ambiguous utopia.", "cover_url": "https://covers.example/dispossessed.jpg", "resolution_confidence": 0.95, "confidence_label": "HIGH", "match_method": "isbn:openlibrary", "resolved_at": "2026-05-01T12:00:00"},
        {"id": 3, "book_id": 3, "resolved_source": "googlebooks", "resolved_id": "gb-phm", "subjects": ["science fiction", "space", "survival"], "series": None, "series_position": None, "description": "An amnesiac astronaut saves the world.", "cover_url": "https://covers.example/phm.jpg", "resolution_confidence": 0.70, "confidence_label": "MEDIUM", "match_method": "search:googlebooks", "resolved_at": "2026-05-01T12:00:00"},
        {"id": 4, "book_id": 4, "resolved_source": "openlibrary", "resolved_id": "/works/OL4614903W", "subjects": ["science fiction", "gender", "anthropological sf"], "series": None, "series_position": None, "description": None, "cover_url": None, "resolution_confidence": 0.95, "confidence_label": "HIGH", "match_method": "isbn:openlibrary", "resolved_at": "2026-05-01T12:00:00"},
        {"id": 5, "book_id": 5, "resolved_source": "openlibrary", "resolved_id": "/works/OL46125W", "subjects": ["science fiction", "empires"], "series": None, "series_position": None, "description": None, "cover_url": None, "resolution_confidence": 0.30, "confidence_label": "LOW", "match_method": "search:openlibrary", "resolved_at": "2026-05-01T12:00:00"},
        {"id": 6, "book_id": 6, "resolved_source": "googlebooks", "resolved_id": "gb-gtn", "subjects": ["fantasy", "necromancy"], "series": None, "series_position": None, "description": None, "cover_url": None, "resolution_confidence": 0.70, "confidence_label": "MEDIUM", "match_method": "search:googlebooks", "resolved_at": "2026-05-01T12:00:00"},
        {"id": 7, "book_id": 7, "resolved_source": "openlibrary", "resolved_id": "/works/OL262758W", "subjects": ["fantasy", "adventure"], "series": None, "series_position": None, "description": None, "cover_url": None, "resolution_confidence": 0.95, "confidence_label": "HIGH", "match_method": "isbn:openlibrary", "resolved_at": "2026-05-01T12:00:00"},
        {"id": 8, "book_id": 8, "resolved_source": "openlibrary", "resolved_id": "/works/OL20126317W", "subjects": ["fantasy", "mystery"], "series": None, "series_position": None, "description": None, "cover_url": None, "resolution_confidence": 0.70, "confidence_label": "MEDIUM", "match_method": "search:openlibrary", "resolved_at": "2026-05-01T12:00:00"},
        {"id": 10, "book_id": 10, "resolved_source": "openlibrary", "resolved_id": "/works/OL16806568W", "subjects": ["fantasy", "novellas"], "series": None, "series_position": None, "description": None, "cover_url": None, "resolution_confidence": 0.95, "confidence_label": "HIGH", "match_method": "isbn:openlibrary", "resolved_at": "2026-05-01T12:00:00"},
        {"id": 11, "book_id": 11, "resolved_source": "openlibrary", "resolved_id": "/works/OL17607870W", "subjects": ["science fiction", "short stories"], "series": None, "series_position": None, "description": None, "cover_url": None, "resolution_confidence": 0.95, "confidence_label": "HIGH", "match_method": "isbn:openlibrary", "resolved_at": "2026-05-01T12:00:00"},
        {"id": 12, "book_id": 12, "resolved_source": "openlibrary", "resolved_id": "/works/OL17352669W", "subjects": ["fantasy", "apocalyptic fiction"], "series": "The Broken Earth", "series_position": "1", "description": None, "cover_url": None, "resolution_confidence": 0.95, "confidence_label": "HIGH", "match_method": "isbn:openlibrary", "resolved_at": "2026-05-01T12:00:00"},
        {"id": 13, "book_id": 13, "resolved_source": "openlibrary", "resolved_id": "/works/OL893184W", "subjects": ["science fiction", "time travel"], "series": None, "series_position": None, "description": None, "cover_url": None, "resolution_confidence": 0.70, "confidence_label": "MEDIUM", "match_method": "search:openlibrary", "resolved_at": "2026-05-01T12:00:00"},
        {"id": 101, "book_id": 101, "resolved_source": "openlibrary", "resolved_id": "/works/OL_OTHER1", "subjects": ["mystery"], "series": None, "series_position": None, "description": "Other tenant's book — must never leak into local's /profile/subjects.", "cover_url": None, "resolution_confidence": 0.90, "confidence_label": "HIGH", "match_method": "isbn:openlibrary", "resolved_at": "2026-05-01T12:00:00"},
    ],
    "taste_traits": [
        {"id": 1, "user_id": "local", "claim": "Drawn to idea-driven science fiction that interrogates political systems.", "polarity": "positive", "exhibits": [1, 2], "contrasts": None, "inference_confidence": 0.95, "status": "proposed", "user_note": None, "created_at": "2026-07-01T12:00:00", "user_weight": 1.0, "verdict_updated_at": None, "reveal_line": "You read to argue with civilizations."},
        {"id": 2, "user_id": "local", "claim": "Values competence and problem-solving protagonists.", "polarity": "positive", "exhibits": [3], "contrasts": None, "inference_confidence": 0.90, "status": "confirmed", "user_note": None, "created_at": "2026-07-01T12:00:00", "user_weight": 1.0, "verdict_updated_at": "2026-07-16T09:00:00", "reveal_line": "Give you a problem and a wrench."},
        {"id": 3, "user_id": "local", "claim": "Prefers standalone novels over long series commitments.", "polarity": "positive", "exhibits": [2, 13], "contrasts": [12], "inference_confidence": 0.80, "status": "proposed", "user_note": None, "created_at": "2026-07-01T12:00:00", "user_weight": 1.0, "verdict_updated_at": None, "reveal_line": None},
        {"id": 4, "user_id": "local", "claim": "Avoids grimdark tone.", "polarity": "negative", "exhibits": [6], "contrasts": None, "inference_confidence": 0.60, "status": "rejected", "user_note": "Not true, I just disliked that one book.", "created_at": "2026-07-01T12:00:00", "user_weight": 0.0, "verdict_updated_at": "2026-06-15T12:00:00", "reveal_line": None},
        {"id": 101, "user_id": "other", "claim": "Other tenant's trait — must never appear in local's /profile.", "polarity": "positive", "exhibits": [101], "contrasts": None, "inference_confidence": 0.90, "status": "confirmed", "user_note": None, "created_at": "2026-07-01T12:00:00", "user_weight": 1.0, "verdict_updated_at": None, "reveal_line": None},
    ],
    "recommendations": [
        {"id": 1, "user_id": "local", "run_id": "runA", "rank": 1, "title": "Blindsight", "author": "Peter Watts", "year": 2006, "isbn13": None, "cover_url": None, "subjects": ["science fiction", "first contact"], "catalog_source": "openlibrary", "catalog_id": "/works/OL5714058W", "retrieval_pool": "metadata", "seed_reason": "hard sf affinity", "score": 0.81, "rationale": "Idea-dense first contact.", "grounded_trait_ids": [1], "grounded_book_ids": [1], "status": "rejected", "user_note": "not for me", "created_at": "2026-07-05T12:00:00", "description": "Vampires in space, consciousness as bug.", "reject_reasons": ["too-grim"]},
        {"id": 2, "user_id": "local", "run_id": "runA", "rank": 2, "title": "A Fire Upon the Deep", "author": "Vernor Vinge", "year": 1992, "isbn13": None, "cover_url": None, "subjects": ["science fiction", "space opera"], "catalog_source": "openlibrary", "catalog_id": "/works/OL2172527W", "retrieval_pool": "metadata", "seed_reason": "space opera affinity", "score": 0.78, "rationale": "Zones of thought.", "grounded_trait_ids": [1], "grounded_book_ids": [1], "status": "accepted", "user_note": None, "created_at": "2026-07-05T12:00:00", "description": "Galaxy-spanning intelligence gradients.", "reject_reasons": None},
        {"id": 3, "user_id": "local", "run_id": "runB", "rank": 1, "title": "Ancillary Justice", "author": "Ann Leckie", "year": 2013, "isbn13": "9780316246620", "cover_url": "https://covers.example/aj.jpg", "subjects": ["science fiction", "space opera", "artificial intelligence"], "catalog_source": "openlibrary", "catalog_id": "/works/OL16813953W", "retrieval_pool": "claude_seed", "seed_reason": "political sf", "score": 0.92, "rationale": "Empire, identity, and tea.", "grounded_trait_ids": [1, 3], "grounded_book_ids": [2, 4], "status": "served", "user_note": None, "created_at": "2026-07-19T12:00:00", "description": "A ship's AI seeks revenge.", "reject_reasons": None},
        {"id": 4, "user_id": "local", "run_id": "runB", "rank": 2, "title": "Children of Time", "author": "Adrian Tchaikovsky", "year": 2015, "isbn13": None, "cover_url": None, "subjects": ["science fiction", "evolution"], "catalog_source": "googlebooks", "catalog_id": "gb-cot", "retrieval_pool": "metadata", "seed_reason": "idea-driven sf", "score": 0.87, "rationale": "Uplifted spiders, deep time.", "grounded_trait_ids": [1], "grounded_book_ids": [1, 3], "status": "served", "user_note": None, "created_at": "2026-07-19T12:00:00", "description": "Terraforming gone sideways.", "reject_reasons": None},
        {"id": 5, "user_id": "local", "run_id": "runB", "rank": 3, "title": "Consider Phlebas", "author": "Iain M. Banks", "year": 1987, "isbn13": None, "cover_url": None, "subjects": ["science fiction", "space opera"], "catalog_source": "openlibrary", "catalog_id": "/works/OL2603721W", "retrieval_pool": "metadata", "seed_reason": "space opera affinity", "score": 0.74, "rationale": "The Culture, from outside.", "grounded_trait_ids": [1], "grounded_book_ids": [1], "status": "rejected", "user_note": None, "created_at": "2026-07-19T12:00:00", "description": "A shapeshifter picks the wrong side.", "reject_reasons": ["pacing"]},
        {"id": 101, "user_id": "other", "run_id": "runOther", "rank": 1, "title": "Other Tenant Rec", "author": "Other Author", "year": 2010, "isbn13": None, "cover_url": None, "subjects": ["mystery"], "catalog_source": "openlibrary", "catalog_id": "/works/OL_OTHERREC", "retrieval_pool": "metadata", "seed_reason": "other tenant affinity", "score": 0.50, "rationale": "Must never leak into local's /recommendations.", "grounded_trait_ids": [101], "grounded_book_ids": [101], "status": "served", "user_note": None, "created_at": "2026-07-05T12:00:00", "description": "Other tenant only.", "reject_reasons": None},
        {"id": 102, "user_id": "other", "run_id": "runOther", "rank": 2, "title": "Other Tenant Rejected Rec", "author": "Other Author", "year": 2011, "isbn13": None, "cover_url": None, "subjects": ["mystery"], "catalog_source": "openlibrary", "catalog_id": "/works/OL_OTHERREC2", "retrieval_pool": "metadata", "seed_reason": "other tenant affinity", "score": 0.40, "rationale": "Must never leak into local's /recommendations/rejected.", "grounded_trait_ids": [101], "grounded_book_ids": [101], "status": "rejected", "user_note": None, "created_at": "2026-07-05T12:00:00", "description": "Other tenant only.", "reject_reasons": ["not-interested"]},
    ],
    "profile_meta": [
        {"id": 1, "user_id": "local", "last_profiled_at": "2026-07-01T12:00:00", "last_profile_kind": "full", "rec_feedback_updated_at": "2026-07-10T12:00:00", "enrichment_corrected_at": None},
        {"id": 101, "user_id": "other", "last_profiled_at": "2026-07-01T12:00:00", "last_profile_kind": "full", "rec_feedback_updated_at": None, "enrichment_corrected_at": None},
    ],
    "user_settings": [
        # anthropic_api_key_encrypted is injected at generation time (see below).
        {"id": 1, "user_id": "local", "display_name": "Chase Test", "created_at": "2026-06-01T12:00:00", "updated_at": None},
        {"id": 101, "user_id": "other", "display_name": "Other Tenant", "anthropic_api_key_encrypted": None, "created_at": "2026-06-01T12:00:00", "updated_at": None},
    ],
    "reader_archetypes": [
        {"id": 1, "user_id": "local", "code": "RCBH", "archetype_name": "The Literary Wanderer", "archetype_tagline": "Voice and feeling, across every genre.", "axis_lens": 0.4, "axis_engine": 0.2, "axis_range": -0.6, "axis_resonance": -0.1, "lens_rationale": "Reads for ideas and craft.", "engine_rationale": "", "range_rationale": "Roams across genres.", "resonance_rationale": "Feeling over structure.", "derived_at": "2026-06-20T12:00:00"},
        {"id": 101, "user_id": "other", "code": "XXXX", "archetype_name": "Other Archetype", "archetype_tagline": "Must never leak into local's /profile/archetype.", "axis_lens": 0.0, "axis_engine": 0.0, "axis_range": 0.0, "axis_resonance": 0.0, "lens_rationale": "", "engine_rationale": "", "range_rationale": "", "resonance_rationale": "", "derived_at": "2026-06-20T12:00:00"},
    ],
    "user_directive": [
        {"id": 1, "user_id": "local", "nl_text": "More literary sci-fi, no grimdark.", "constraints": {"exclude_authors": ["john ringo"]}, "created_at": "2026-07-12T12:00:00", "updated_at": "2026-07-12T12:00:00"},
        {"id": 101, "user_id": "other", "nl_text": "Other tenant directive — must never leak into local's /directive.", "constraints": {"exclude_authors": ["someone else"]}, "created_at": "2026-07-12T12:00:00", "updated_at": "2026-07-12T12:00:00"},
    ],
    "usage_events": [
        {"id": 1, "user_id": "local", "model": "claude-sonnet-5", "operation": "profile", "input_tokens": 1000, "output_tokens": 2000, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0, "cost_usd": 0.022, "created_at": {"$hoursAgo": 0}},
        {"id": 2, "user_id": "local", "model": "claude-haiku-4-5-20251001", "operation": "recommend", "input_tokens": 500, "output_tokens": 400, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0, "cost_usd": 0.003, "created_at": {"$hoursAgo": 0}},
        # 45 days ago — always in a previous UTC month; must NOT count toward spent_usd.
        {"id": 3, "user_id": "local", "model": "claude-sonnet-5", "operation": "profile", "input_tokens": 9000, "output_tokens": 9000, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0, "cost_usd": 1.0, "created_at": {"$hoursAgo": 1080}},
        # Deliberately large + this-month so a userId-scoping regression on /settings/usage
        # would be obvious (spent_usd/pct would blow way past local's expected values).
        {"id": 101, "user_id": "other", "model": "claude-sonnet-5", "operation": "profile", "input_tokens": 100, "output_tokens": 100, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0, "cost_usd": 5.55, "created_at": {"$hoursAgo": 0}},
    ],
}

WRITE_SCENARIOS: dict[str, list[dict]] = {
    "add-book-basic": [
        {"req": "POST /books", "json": {
            "title": "Ancillary Justice", "author": "Ann Leckie", "year": 2013,
            "isbn13": "9780316246620", "shelf": "to-read",
            "cover_url": "https://covers.example/aj.jpg",
            "subjects": ["science fiction", "space opera"],
            "catalog_source": "openlibrary", "catalog_id": "/works/OL16813953W"}},
        {"req": "GET /books?shelf=to-read"},
    ],
    "add-book-rated-review": [
        {"req": "POST /books", "json": {
            "title": "The Player of Games", "author": "Iain M. Banks",
            "shelf": "read", "rating": 5, "review": "The Culture at its best."}},
        {"req": "GET /profile/status"},
    ],
    "add-book-duplicate": [
        {"req": "POST /books", "json": {"title": "DUNE: Special Edition", "author": "Herbert"}},
    ],
    "add-book-sibling-subtitle": [
        {"req": "POST /books", "json": {"title": "Exodus: The Archimedes Engine", "author": "Peter F. Hamilton"}},
        {"req": "POST /books", "json": {"title": "Exodus: The Helium Sea", "author": "Peter F. Hamilton"}},
    ],
    "add-book-invalid": [
        {"req": "POST /books", "json": {"title": "X", "shelf": "nonsense"}},
        {"req": "POST /books", "json": {"title": "X", "rating": 9}},
        {"req": "POST /books", "json": {"title": "X", "review": "no rating"}},
        {"req": "POST /books", "json": {"title": "   "}},
    ],
    "book-feedback": [
        {"req": "PATCH /books/1/feedback", "json": {"rating": 4, "review": "Rereads well."}},
        {"req": "PATCH /books/3/feedback", "json": {"rating": 0}},
        {"req": "PATCH /books/1/feedback", "json": {"date_read": "2026-01-15", "is_favorite": True}},
        {"req": "PATCH /books/5/feedback", "json": {"exclude_from_profile": True}},
        {"req": "GET /books?rated_only=true"},
    ],
    "book-feedback-invalid": [
        {"req": "PATCH /books/8/feedback", "json": {"review": "unrated review"}},
        {"req": "PATCH /books/1/feedback", "json": {}},
        {"req": "PATCH /books/1/feedback", "json": {"rating": 7}},
        {"req": "PATCH /books/101/feedback", "json": {"rating": 3}},
        {"req": "PATCH /books/999/feedback", "json": {"rating": 3}},
    ],
    "book-shelf": [
        {"req": "PATCH /books/8/shelf", "json": {"shelf": "currently-reading"}},
        {"req": "PATCH /books/8/shelf", "json": {"shelf": "bogus"}},
        {"req": "PATCH /books/101/shelf", "json": {"shelf": "read"}},
    ],
    "enrichment-correction": [
        {"req": "PATCH /books/5/enrichment", "json": {
            "catalog_source": "openlibrary", "catalog_id": "/works/OL46125W-fixed",
            "cover_url": "https://covers.example/foundation-fixed.jpg",
            "subjects": ["science fiction", "psychohistory"],
            "description": "The right Foundation."}},
        {"req": "GET /profile/status"},
        {"req": "PATCH /books/14/enrichment", "json": {
            "catalog_source": "googlebooks", "catalog_id": "gb-smallgods"}},
        {"req": "PATCH /books/1/enrichment", "json": {"catalog_source": "", "catalog_id": ""}},
        {"req": "PATCH /books/101/enrichment", "json": {"catalog_source": "x", "catalog_id": "y"}},
    ],
    "delete-book": [
        {"req": "DELETE /books/8"},
        {"req": "GET /books?shelf=to-read"},
        {"req": "DELETE /books/8"},
        {"req": "DELETE /books/101"},
    ],
    "rec-feedback-accept": [
        {"req": "PATCH /recommendations/3/feedback", "json": {"status": "accepted"}},
        {"req": "PATCH /recommendations/3/feedback", "json": {"status": "accepted"}},
        {"req": "GET /books?shelf=to-read"},
    ],
    "rec-feedback-already-read": [
        {"req": "PATCH /recommendations/4/feedback", "json": {"status": "already_read"}},
    ],
    "rec-feedback-note-on-accepted": [
        {"req": "PATCH /recommendations/2/feedback", "json": {"user_note": "started it"}},
    ],
    "rec-feedback-reject-reasons": [
        {"req": "PATCH /recommendations/3/feedback",
         "json": {"status": "rejected", "reject_reasons": ["too_long", "not_now"]}},
        {"req": "GET /recommendations/rejected"},
    ],
    "rec-feedback-invalid": [
        {"req": "PATCH /recommendations/3/feedback", "json": {}},
        {"req": "PATCH /recommendations/3/feedback", "json": {"status": "meh"}, "maskDetail": True},
        {"req": "PATCH /recommendations/3/feedback",
         "json": {"status": "accepted", "reject_reasons": ["too_long"]}},
        {"req": "PATCH /recommendations/3/feedback",
         "json": {"status": "rejected", "reject_reasons": []}},
        {"req": "PATCH /recommendations/3/feedback",
         "json": {"status": "rejected", "reject_reasons": ["bogus_reason"]}},
        {"req": "PATCH /recommendations/101/feedback", "json": {"status": "accepted"}},
    ],
    "api-key": [
        {"req": "PUT /settings/api-key", "json": {"api_key": "sk-ant-test-wave2-key"}},
        {"req": "GET /settings/api-key/status"},
        {"req": "DELETE /settings/api-key"},
        {"req": "PUT /settings/api-key", "json": {"api_key": "   "}},
    ],
    "display-name": [
        {"req": "PUT /settings/profile", "json": {"display_name": "Wave Two"}},
        {"req": "PUT /settings/profile", "json": {"display_name": "  "}},
    ],
    "directive": [
        {"req": "PUT /directive", "json": {
            "nl_text": "  Standalone literary sci-fi.  ",
            "constraints": {"languages": ["EN", " fr "], "min_year": "1990",
                             "max_year": 2020, "page_max": 400,
                             "exclude_subjects": ["Grimdark "],
                             "exclude_authors": ["Ringo"]}}},
        {"req": "GET /directive"},
        {"req": "PUT /directive", "json": {"nl_text": "  ", "constraints": {}}},
        {"req": "DELETE /directive"},
        {"req": "GET /directive"},
    ],
    "trait-patch": [
        {"req": "PATCH /profile/traits/1", "json": {"status": "confirmed"}},
        {"req": "PATCH /profile/traits/1", "json": {"claim": "  Edited claim.  "}},
        {"req": "PATCH /profile/traits/3", "json": {"user_weight": 0.5, "user_note": "sort of"}},
        {"req": "GET /profile/status"},
        {"req": "PATCH /profile/traits/1", "json": {}},
        {"req": "PATCH /profile/traits/101", "json": {"status": "confirmed"}},
    ],
    "feedback-flow": [
        {"req": "GET /feedback/prompt?trigger=post-setup"},
        {"req": "POST /feedback", "json": {"category": "Bug", "body": "It broke.",
                                            "trigger": "post-setup", "page": "/setup"}},
        {"req": "GET /feedback/prompt?trigger=post-setup"},
        {"req": "POST /feedback/dismiss", "json": {"trigger": "post-first-profile", "mode": "dont_ask"}},
        {"req": "GET /feedback/prompt?trigger=post-first-profile"},
        {"req": "POST /feedback/dismiss", "json": {"trigger": "post-recs", "run_id": "runB", "mode": "ask_later"}},
        {"req": "GET /feedback/prompt?trigger=post-recs&run_id=runB"},
        {"req": "GET /feedback/prompt?trigger=post-recs&run_id=runC"},
    ],
    "feedback-invalid": [
        {"req": "POST /feedback", "json": {"category": "nonsense", "body": "x"}},
        {"req": "POST /feedback", "json": {"category": "bug", "body": "   "}},
        {"req": "POST /feedback", "json": {"category": "bug", "body": "x", "trigger": "post-recs"}},
        {"req": "GET /feedback/prompt?trigger=post-recs"},
        {"req": "POST /feedback/dismiss", "json": {"trigger": "post-setup", "mode": "whenever"}},
        {"req": "POST /feedback/dismiss", "json": {"trigger": "post-recs", "mode": "ask_later"}},
    ],
    "taste-signal": [
        {"req": "POST /taste-signal", "json": {"direction": "more", "target_kind": "book", "target_book_id": 1}},
        {"req": "POST /taste-signal", "json": {"direction": "less", "target_kind": "rec",
            "snapshot": {"title": "Blindsight", "author": "Peter Watts", "subjects": ["science fiction"]}}},
        {"req": "POST /taste-signal", "json": {"direction": "more", "target_kind": "book"}},
        {"req": "POST /taste-signal", "json": {"direction": "more", "target_kind": "book", "target_book_id": 101}},
        {"req": "POST /taste-signal", "json": {"direction": "more", "target_kind": "rec"}},
    ],
}

_TS_FIELDS = {
    "feedback_updated_at", "created_at", "updated_at", "verdict_updated_at",
    "last_profiled_at", "rec_feedback_updated_at", "enrichment_corrected_at",
    "derived_at", "resolved_at",
}
_DATE_FIELDS = {"date_read", "date_added"}


def _coerce(field: str, value):
    if value is None:
        return None
    if field in _TS_FIELDS:
        if isinstance(value, dict):
            return datetime.utcnow() - timedelta(hours=value["$hoursAgo"])
        return datetime.fromisoformat(value)
    if field in _DATE_FIELDS:
        return date.fromisoformat(value)
    return value


_MODELS = {
    "books": Book, "enrichment": Enrichment, "taste_traits": TasteTrait,
    "recommendations": Recommendation, "profile_meta": ProfileMeta,
    "user_settings": UserSettings, "reader_archetypes": ReaderArchetype,
    "user_directive": UserDirective, "usage_events": UsageEvent,
}


def load_seed() -> None:
    with session_scope() as session:
        # The empty-stage GET /profile/status auto-creates a profile_meta row for
        # 'local' (Python side effect); delete it so the seeded explicit row can insert.
        session.query(ProfileMeta).delete()
        for table, model in _MODELS.items():
            for row in SEED.get(table, []):
                session.add(model(**{k: _coerce(k, v) for k, v in row.items()}))


def record(client: TestClient) -> dict:
    out = {}
    for key in REQUESTS:
        method, path = key.split(" ", 1)
        r = client.request(method, path)
        out[key] = {"status": r.status_code, "body": r.json()}
    return out


def reset_db() -> None:
    """Wipe every table and reload SEED — fresh state per write scenario."""
    with session_scope() as session:
        for model in (Enrichment, TasteTrait, Recommendation, ProfileMeta,
                      UserSettings, ReaderArchetype, UserDirective, UsageEvent,
                      TasteSignal, Feedback, FeedbackPromptState, Book):
            session.query(model).delete()
    load_seed()


def run_scenarios(client: TestClient) -> dict:
    out: dict = {}
    for name, steps in WRITE_SCENARIOS.items():
        reset_db()
        recorded = []
        for step in steps:
            method, path = step["req"].split(" ", 1)
            r = client.request(method, path, json=step.get("json"))
            body = r.json() if r.status_code != 204 and r.content else None
            recorded.append({
                "req": step["req"],
                "json": step.get("json"),
                "status": r.status_code,
                "body": body,
                "maskDetail": step.get("maskDetail", False),
            })
        out[name] = recorded
    return out


def main() -> None:
    init_db()
    fixtures = {}
    with TestClient(app) as client:
        fixtures["empty"] = record(client)
        # Inject the encrypted key now (crypto.encrypt uses ENCRYPTION_KEY set above);
        # checked into seed.json so the Node test decrypts the same token.
        SEED["user_settings"][0]["anthropic_api_key_encrypted"] = crypto.encrypt(
            "sk-ant-test-0123456789-fixture"
        )
        load_seed()
        fixtures["seeded"] = record(client)

        # reset_db() re-reads the SAME module-level SEED dict via load_seed(), and the
        # encrypted-key mutation above already happened in-place on
        # SEED["user_settings"][0] — so every scenario reset below still seeds the
        # encrypted key without any extra plumbing.
        fixtures_writes = run_scenarios(client)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "seed.json").write_text(json.dumps(SEED, indent=1))
    (OUT_DIR / "python-responses.json").write_text(json.dumps(fixtures, indent=1))
    (OUT_DIR / "write-scenarios.json").write_text(json.dumps(fixtures_writes, indent=1))
    print(f"wrote {OUT_DIR}/seed.json and python-responses.json")
    print("empty-stage statuses:", {k: v["status"] for k, v in fixtures["empty"].items()})


if __name__ == "__main__":
    main()
