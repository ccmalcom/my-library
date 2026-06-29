"""Tests for CLI commands: `trait` and `like` (Task 3.4)."""

from __future__ import annotations

import pytest
from typer.testing import CliRunner

from mylibrary.cli import app
from mylibrary.db import Book, TasteTrait, session_scope, LOCAL_USER_ID

runner = CliRunner()


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _insert_trait(claim: str = "I enjoy epic fantasy") -> int:
    with session_scope() as s:
        t = TasteTrait(
            user_id=LOCAL_USER_ID,
            claim=claim,
            polarity="positive",
            inference_confidence=0.8,
            status="proposed",
            exhibits=[],
            contrasts=[],
        )
        s.add(t)
        s.flush()
        return t.id


def _insert_book(title: str = "Dune") -> int:
    with session_scope() as s:
        b = Book(
            user_id=LOCAL_USER_ID,
            title=title,
            author="Frank Herbert",
        )
        s.add(b)
        s.flush()
        return b.id


# ---------------------------------------------------------------------------
# trait --confirm
# ---------------------------------------------------------------------------

def test_trait_confirm():
    trait_id = _insert_trait()
    result = runner.invoke(app, ["trait", str(trait_id), "--confirm"])
    assert result.exit_code == 0, result.output
    assert "confirmed" in result.output

    from mylibrary.db import TasteTrait
    with session_scope() as s:
        t = s.get(TasteTrait, trait_id)
        assert t.status == "confirmed"
        assert t.verdict_updated_at is not None


# ---------------------------------------------------------------------------
# trait --reject
# ---------------------------------------------------------------------------

def test_trait_reject():
    trait_id = _insert_trait("I dislike short stories")
    result = runner.invoke(app, ["trait", str(trait_id), "--reject"])
    assert result.exit_code == 0, result.output
    assert "rejected" in result.output

    with session_scope() as s:
        t = s.get(TasteTrait, trait_id)
        assert t.status == "rejected"


# ---------------------------------------------------------------------------
# trait --weight
# ---------------------------------------------------------------------------

def test_trait_weight():
    trait_id = _insert_trait("I prefer long books")
    result = runner.invoke(app, ["trait", str(trait_id), "--weight", "0.5"])
    assert result.exit_code == 0, result.output
    assert "0.5" in result.output

    with session_scope() as s:
        t = s.get(TasteTrait, trait_id)
        assert abs(t.user_weight - 0.5) < 1e-6
        assert t.verdict_updated_at is not None


# ---------------------------------------------------------------------------
# trait: no flags → error
# ---------------------------------------------------------------------------

def test_trait_no_flags_errors():
    trait_id = _insert_trait()
    result = runner.invoke(app, ["trait", str(trait_id)])
    assert result.exit_code != 0
    assert "At least one" in result.output


# ---------------------------------------------------------------------------
# trait: --confirm and --reject mutually exclusive
# ---------------------------------------------------------------------------

def test_trait_confirm_and_reject_mutually_exclusive():
    trait_id = _insert_trait()
    result = runner.invoke(app, ["trait", str(trait_id), "--confirm", "--reject"])
    assert result.exit_code != 0
    assert "mutually exclusive" in result.output


# ---------------------------------------------------------------------------
# trait: bad id → error
# ---------------------------------------------------------------------------

def test_trait_bad_id_errors():
    result = runner.invoke(app, ["trait", "999999", "--confirm"])
    assert result.exit_code != 0


# ---------------------------------------------------------------------------
# like --more
# ---------------------------------------------------------------------------

def test_like_more():
    book_id = _insert_book("Foundation")
    result = runner.invoke(app, ["like", str(book_id), "--more"])
    assert result.exit_code == 0, result.output
    assert "more" in result.output.lower()

    from mylibrary.db import TasteSignal
    with session_scope() as s:
        sig = s.query(TasteSignal).filter_by(target_book_id=book_id, direction="more").first()
        assert sig is not None


# ---------------------------------------------------------------------------
# like --less
# ---------------------------------------------------------------------------

def test_like_less():
    book_id = _insert_book("Twilight")
    result = runner.invoke(app, ["like", str(book_id), "--less"])
    assert result.exit_code == 0, result.output
    assert "less" in result.output.lower()

    from mylibrary.db import TasteSignal
    with session_scope() as s:
        sig = s.query(TasteSignal).filter_by(target_book_id=book_id, direction="less").first()
        assert sig is not None


# ---------------------------------------------------------------------------
# like: no flags → error
# ---------------------------------------------------------------------------

def test_like_no_flags_errors():
    book_id = _insert_book("Eragon")
    result = runner.invoke(app, ["like", str(book_id)])
    assert result.exit_code != 0
    assert "At least one" in result.output


# ---------------------------------------------------------------------------
# like: --more and --less mutually exclusive
# ---------------------------------------------------------------------------

def test_like_more_and_less_mutually_exclusive():
    book_id = _insert_book("The Hobbit")
    result = runner.invoke(app, ["like", str(book_id), "--more", "--less"])
    assert result.exit_code != 0
    assert "mutually exclusive" in result.output


# ---------------------------------------------------------------------------
# like: bad book id → error
# ---------------------------------------------------------------------------

def test_like_bad_book_id_errors():
    result = runner.invoke(app, ["like", "999999", "--more"])
    assert result.exit_code != 0
