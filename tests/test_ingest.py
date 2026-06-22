"""Tests for Phase 1 ingest — the boring-but-critical foundation.

Covers the documented CSV quirks and the locked idempotency requirement.
"""

from __future__ import annotations

from mylibrary.db import Book, session_scope
from mylibrary.ingest import clean_isbn, ingest_csv

from .conftest import SAMPLE_CSV


def test_clean_isbn_strips_excel_escape():
    assert clean_isbn('="9780441172719"') == "9780441172719"
    assert clean_isbn('="0441172717"') == "0441172717"
    assert clean_isbn('=""') is None
    assert clean_isbn("") is None
    assert clean_isbn(None) is None
    assert clean_isbn("9780441172719") == "9780441172719"


def test_ingest_loads_expected_rows():
    summary = ingest_csv(SAMPLE_CSV)
    assert summary["total_rows"] == 6
    assert summary["inserted"] == 6
    assert summary["updated"] == 0
    # 5 books have My Rating > 0; one is to-read with rating 0.
    assert summary["rated"] == 5


def test_ingest_is_idempotent():
    ingest_csv(SAMPLE_CSV)
    summary = ingest_csv(SAMPLE_CSV)  # second pass
    assert summary["inserted"] == 0
    assert summary["updated"] == 6
    with session_scope() as session:
        assert session.query(Book).count() == 6  # not 12


def test_rating_zero_means_unrated():
    ingest_csv(SAMPLE_CSV)
    with session_scope() as session:
        phm = session.query(Book).filter(Book.title == "Project Hail Mary").one()
        assert phm.goodreads_rating == 0
        assert phm.effective_rating is None
        assert phm.exclusive_shelf == "to-read"


def test_isbn_is_cleaned_on_ingest():
    ingest_csv(SAMPLE_CSV)
    with session_scope() as session:
        dune = session.query(Book).filter(Book.title == "Dune").one()
        assert dune.isbn13 == "9780441172719"
        assert dune.year_published == 1965  # original publication year preferred


def test_app_rating_survives_reimport():
    ingest_csv(SAMPLE_CSV)
    with session_scope() as session:
        dune = session.query(Book).filter(Book.title == "Dune").one()
        dune.app_rating = 3  # user re-rates in-app
    # Re-import the Goodreads seed; app_rating must not be clobbered.
    ingest_csv(SAMPLE_CSV)
    with session_scope() as session:
        dune = session.query(Book).filter(Book.title == "Dune").one()
        assert dune.app_rating == 3
        assert dune.effective_rating == 3  # app_rating wins over goodreads_rating 5
