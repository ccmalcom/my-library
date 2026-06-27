"""Unit tests for profile.build_tiers and books_changed_since with DNF books."""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from mylibrary.db import Book, session_scope
from mylibrary.profile import books_changed_since, build_tiers


def _add_book(session, title: str, shelf: str, app_rating: int | None = None, app_review: str | None = None) -> Book:
    book = Book(
        title=title,
        author="Test Author",
        goodreads_rating=0,
        exclusive_shelf=shelf,
        app_rating=app_rating,
        app_review=app_review,
        feedback_updated_at=datetime(2024, 1, 1, tzinfo=timezone.utc) if app_review else None,
    )
    session.add(book)
    session.flush()
    return book


def test_build_tiers_includes_dnf_tier():
    with session_scope() as session:
        _add_book(session, "Loved Book", "read", app_rating=5)
        _add_book(session, "Quit Book", "did-not-finish", app_review="Couldn't get into it.")

    with session_scope() as session:
        tiers = build_tiers(session)

    assert "dnf" in tiers
    assert len(tiers["dnf"]) == 1
    assert tiers["dnf"][0]["title"] == "Quit Book"
    assert tiers["dnf"][0]["review"] == "Couldn't get into it."


def test_build_tiers_dnf_book_without_review_is_included():
    with session_scope() as session:
        _add_book(session, "Silent Quit", "did-not-finish")

    with session_scope() as session:
        tiers = build_tiers(session)

    assert len(tiers["dnf"]) == 1
    assert "review" not in tiers["dnf"][0]


def test_build_tiers_dnf_does_not_appear_in_rated_tiers():
    with session_scope() as session:
        _add_book(session, "Quit Book", "did-not-finish")

    with session_scope() as session:
        tiers = build_tiers(session)

    assert all(len(tiers[k]) == 0 for k in ("5", "4", "3", "<=2"))


def test_books_changed_since_includes_dnf_books():
    with session_scope() as session:
        _add_book(session, "Rated", "read", app_rating=4, app_review="Good.")
        _add_book(session, "Quit", "did-not-finish", app_review="Boring.")

    with session_scope() as session:
        changed = books_changed_since(session, since=None)

    titles = {b.title for b in changed}
    assert "Rated" in titles
    assert "Quit" in titles


def test_books_changed_since_excludes_unreviewed_unrated():
    with session_scope() as session:
        _add_book(session, "Untracked", "to-read")

    with session_scope() as session:
        changed = books_changed_since(session, since=None)

    assert changed == []
