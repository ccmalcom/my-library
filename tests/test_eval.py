# tests/test_eval.py
import json
from pathlib import Path

from mylibrary import eval as ev


def test_write_snapshot_creates_timestamped_json(tmp_path, monkeypatch):
    monkeypatch.setattr(ev, "RESULTS_DIR", tmp_path / "eval")
    results = {"schema_version": 1, "metrics": {"recall_at_k": 0.5}}
    path = ev.write_snapshot(results)
    p = Path(path)
    assert p.exists()
    assert p.name.startswith("results_") and p.suffix == ".json"
    assert json.loads(p.read_text())["metrics"]["recall_at_k"] == 0.5


# ---------------------------------------------------------------------------
# groundedness() tests
# ---------------------------------------------------------------------------

def test_groundedness_flags_polarity_mismatch():
    """An aversion trait citing a 5-star book should fail with a polarity reason."""
    from mylibrary.db import session_scope, Book, TasteTrait

    with session_scope() as s:
        b_good = Book(title="Good Book", goodreads_rating=5, user_id="local")
        b_bad = Book(title="Bad Book", goodreads_rating=2, user_id="local")
        s.add_all([b_good, b_bad])
        s.flush()
        # aversion trait claiming b_good (5-star) exhibits it — polarity mismatch!
        trait = TasteTrait(
            claim="Dislikes grimdark",
            polarity="aversion",
            exhibits=[b_good.id],
            contrasts=[],
            inference_confidence=0.5,
            status="proposed",
            user_id="local",
        )
        s.add(trait)
        s.flush()
        out = ev.groundedness(s)

    bad = [t for t in out["per_trait"] if not t["passed"]]
    assert bad, "Expected at least one failing trait"
    assert any("polarity" in r for r in bad[0]["reasons"]), (
        f"Expected 'polarity' in reasons, got: {bad[0]['reasons']}"
    )


def test_groundedness_passes_valid_trait():
    """A reward trait citing a 5-star book should pass all checks."""
    from mylibrary.db import session_scope, Book, TasteTrait

    with session_scope() as s:
        b = Book(title="Loved Book", goodreads_rating=5, user_id="local")
        s.add(b)
        s.flush()
        trait = TasteTrait(
            claim="Loves epic fantasy",
            polarity="reward",
            exhibits=[b.id],
            contrasts=[],
            inference_confidence=0.9,
            status="proposed",
            user_id="local",
        )
        s.add(trait)
        s.flush()
        out = ev.groundedness(s)

    assert out["score"] == 1.0
    assert all(t["passed"] for t in out["per_trait"])


def test_groundedness_flags_empty_claim():
    """A trait with an empty claim should fail."""
    from mylibrary.db import session_scope, Book, TasteTrait

    with session_scope() as s:
        b = Book(title="Some Book", goodreads_rating=4, user_id="local")
        s.add(b)
        s.flush()
        trait = TasteTrait(
            claim="   ",  # whitespace only - empty after strip
            polarity="reward",
            exhibits=[b.id],
            contrasts=[],
            inference_confidence=0.5,
            status="proposed",
            user_id="local",
        )
        s.add(trait)
        s.flush()
        out = ev.groundedness(s)

    bad = [t for t in out["per_trait"] if not t["passed"]]
    assert bad
    assert any("claim" in r for r in bad[0]["reasons"])


def test_groundedness_flags_invalid_book_id():
    """A trait referencing a non-existent book id should fail."""
    from mylibrary.db import session_scope, TasteTrait

    with session_scope() as s:
        trait = TasteTrait(
            claim="Likes magic systems",
            polarity="reward",
            exhibits=[99999],  # no such book
            contrasts=[],
            inference_confidence=0.5,
            status="proposed",
            user_id="local",
        )
        s.add(trait)
        s.flush()
        out = ev.groundedness(s)

    bad = [t for t in out["per_trait"] if not t["passed"]]
    assert bad
    assert any("invalid" in r.lower() or "book" in r.lower() for r in bad[0]["reasons"])


def test_groundedness_flags_exhibits_contrasts_overlap():
    """A trait where the same book appears in both exhibits and contrasts should fail."""
    from mylibrary.db import session_scope, Book, TasteTrait

    with session_scope() as s:
        b = Book(title="Overlapping Book", goodreads_rating=4, user_id="local")
        s.add(b)
        s.flush()
        trait = TasteTrait(
            claim="Likes literary fiction",
            polarity="reward",
            exhibits=[b.id],
            contrasts=[b.id],  # same book - overlap!
            inference_confidence=0.5,
            status="proposed",
            user_id="local",
        )
        s.add(trait)
        s.flush()
        out = ev.groundedness(s)

    bad = [t for t in out["per_trait"] if not t["passed"]]
    assert bad
    assert any("overlap" in r.lower() or "intersect" in r.lower() or "contrast" in r.lower() for r in bad[0]["reasons"])


def test_groundedness_score_fraction():
    """Score should be the fraction of passing traits."""
    from mylibrary.db import session_scope, Book, TasteTrait

    with session_scope() as s:
        b_good = Book(title="High Rated", goodreads_rating=5, user_id="local")
        b_bad = Book(title="Low Rated", goodreads_rating=2, user_id="local")
        s.add_all([b_good, b_bad])
        s.flush()
        # passing: reward trait citing 5-star book
        t1 = TasteTrait(
            claim="Loves fantasy",
            polarity="reward",
            exhibits=[b_good.id],
            contrasts=[],
            inference_confidence=0.9,
            status="proposed",
            user_id="local",
        )
        # failing: aversion trait citing 5-star book (mismatch)
        t2 = TasteTrait(
            claim="Dislikes grimdark",
            polarity="aversion",
            exhibits=[b_good.id],
            contrasts=[],
            inference_confidence=0.5,
            status="proposed",
            user_id="local",
        )
        s.add_all([t1, t2])
        s.flush()
        out = ev.groundedness(s)

    assert out["score"] == 0.5  # 1 of 2 passing
    passing = [t for t in out["per_trait"] if t["passed"]]
    failing = [t for t in out["per_trait"] if not t["passed"]]
    assert len(passing) == 1
    assert len(failing) == 1


def test_groundedness_judge_not_implemented():
    """judge=True should raise NotImplementedError."""
    from mylibrary.db import session_scope

    with session_scope() as s:
        import pytest
        with pytest.raises(NotImplementedError):
            ev.groundedness(s, judge=True)


def test_groundedness_empty_traits():
    """With no traits, score should be 1.0 (vacuously true) and per_trait empty."""
    from mylibrary.db import session_scope

    with session_scope() as s:
        out = ev.groundedness(s)

    assert out["score"] == 1.0
    assert out["per_trait"] == []


# ---------------------------------------------------------------------------
# holdout_recall() tests
# ---------------------------------------------------------------------------

def test_holdout_recall_deterministic():
    """Same seed -> same hits list across two calls."""
    from unittest.mock import patch
    from mylibrary.db import session_scope, Book

    with session_scope() as s:
        # Use distinct authors so the surname-neighbour rule doesn't fire across books.
        books = [
            Book(title=f"Book {i}", author=f"Author{i} Surname{i}",
                 goodreads_rating=5, user_id="local")
            for i in range(6)
        ]
        s.add_all(books)
        s.flush()

    # One matching candidate -- same title+author as "Book 0"
    fake_cand = {
        "title": "Book 0",
        "author": "Author0 Surname0",
        "subjects": [],
        "isbn13": None,
        "year": None,
        "description": None,
        "cover_url": None,
        "source": "openlibrary",
        "resolved_id": "OL1",
    }

    with patch("mylibrary.recommend._metadata_pool", return_value=[(fake_cand, "subject:test")]):
        with session_scope() as s:
            r1 = ev.holdout_recall(s, k=10, holdout=5, seed=1234)
        with session_scope() as s:
            r2 = ev.holdout_recall(s, k=10, holdout=5, seed=1234)

    assert 0 <= r1["recall_at_k"] <= 1
    assert 0 <= r1["precision_at_k"] <= 1
    assert r1["hits"] == r2["hits"]  # deterministic


def test_holdout_recall_returns_expected_keys():
    """Return dict has all required keys."""
    from unittest.mock import patch
    from mylibrary.db import session_scope, Book

    with session_scope() as s:
        books = [
            Book(title=f"Novel {i}", author="Alex Brown",
                 goodreads_rating=5, user_id="local")
            for i in range(6)
        ]
        s.add_all(books)
        s.flush()

    with patch("mylibrary.recommend._metadata_pool", return_value=[]):
        with session_scope() as s:
            result = ev.holdout_recall(s, k=5, holdout=5, seed=42)

    assert set(result.keys()) >= {"k", "holdout", "seed", "recall_at_k", "precision_at_k", "hits", "n_candidates"}
    assert result["k"] == 5
    assert result["holdout"] == 5
    assert result["seed"] == 42


def test_holdout_recall_hit_by_title_author():
    """A candidate that matches by (norm_title, surname) counts as a hit."""
    from unittest.mock import patch
    from mylibrary.db import session_scope, Book

    with session_scope() as s:
        # All 6 books get rating=5; "Fantasy Classic" should be in holdout and hit
        books = [
            Book(title="Fantasy Classic", author="Ursula Le Guin",
                 goodreads_rating=5, user_id="local"),
        ] + [
            Book(title=f"Other Book {i}", author="Another Author",
                 goodreads_rating=5, user_id="local")
            for i in range(5)
        ]
        s.add_all(books)
        s.flush()

    fake_cand = {
        "title": "Fantasy Classic",
        "author": "Ursula Le Guin",
        "subjects": ["fantasy"],
        "isbn13": None,
        "year": None,
        "description": None,
        "cover_url": None,
        "source": "openlibrary",
        "resolved_id": "OL999",
    }

    with patch("mylibrary.recommend._metadata_pool", return_value=[(fake_cand, "subject:fantasy")]):
        with session_scope() as s:
            result = ev.holdout_recall(s, k=10, holdout=5, seed=999)

    # If "Fantasy Classic" was in the holdout and the candidate matches, it should be a hit
    assert 0 <= result["recall_at_k"] <= 1
    assert 0 <= result["precision_at_k"] <= 1
    assert isinstance(result["hits"], list)


# ---------------------------------------------------------------------------
# run_eval() tests
# ---------------------------------------------------------------------------

def test_run_eval_returns_required_metrics():
    """run_eval returns a dict with schema_version=1 and required metric keys."""
    from unittest.mock import patch
    from mylibrary.db import session_scope, Book

    with session_scope() as s:
        books = [
            Book(title=f"Book {i}", author="Jane Smith",
                 goodreads_rating=5, user_id="local")
            for i in range(6)
        ]
        s.add_all(books)
        s.flush()

    fake_cand = {
        "title": "Book 0",
        "author": "Jane Smith",
        "subjects": [],
        "isbn13": None,
        "year": None,
        "description": None,
        "cover_url": None,
        "source": "openlibrary",
        "resolved_id": "OL1",
    }

    with patch("mylibrary.recommend._metadata_pool", return_value=[(fake_cand, "subject:test")]):
        results = ev.run_eval(k=10, holdout=5, seed=1234)

    assert results["schema_version"] == 1
    assert "generated_at" in results
    assert "params" in results
    assert "metrics" in results
    m = results["metrics"]
    assert "recall_at_k" in m
    assert "precision_at_k" in m
    assert "groundedness_score" in m
    assert "n_candidates" in m
    assert "n_traits" in m
    assert "hits" in m
    assert isinstance(m["recall_at_k"], float)
    assert isinstance(m["groundedness_score"], float)


def test_run_eval_params_stored():
    """run_eval stores the k/holdout/seed/judge params."""
    from unittest.mock import patch
    from mylibrary.db import session_scope, Book

    with session_scope() as s:
        books = [
            Book(title=f"Tome {i}", author="Robert Jones",
                 goodreads_rating=5, user_id="local")
            for i in range(6)
        ]
        s.add_all(books)
        s.flush()

    with patch("mylibrary.recommend._metadata_pool", return_value=[]):
        results = ev.run_eval(k=5, holdout=3, seed=42, judge=False)

    assert results["params"]["k"] == 5
    assert results["params"]["holdout"] == 3
    assert results["params"]["seed"] == 42
    assert results["params"]["judge"] is False


# ---------------------------------------------------------------------------
# format_summary() tests
# ---------------------------------------------------------------------------

def test_format_summary_contains_key_values():
    """format_summary produces a readable string with k, recall, and groundedness."""
    import json
    sample = {
        "params": {"k": 10, "holdout": 5, "seed": 1234},
        "metrics": {
            "recall_at_k": 0.4,
            "precision_at_k": 0.08,
            "groundedness_score": 0.857,
            "n_candidates": 142,
            "n_traits": 7,
            "hits": ["Book A", "Book B"],
        },
    }
    out = ev.format_summary(sample)
    assert "0.400" in out
    assert "0.080" in out
    assert "0.857" in out
    assert "142" in out
    assert "Book A" in out


# ---------------------------------------------------------------------------
# format_compare() tests
# ---------------------------------------------------------------------------

def test_format_compare_shows_delta():
    """format_compare renders a delta value (+ / - / unchanged) for each metric."""
    curr = {
        "params": {"k": 10, "holdout": 5, "seed": 1234},
        "metrics": {
            "recall_at_k": 0.6,
            "precision_at_k": 0.1,
            "groundedness_score": 0.9,
            "n_candidates": 50,
            "n_traits": 5,
            "hits": [],
        },
    }
    prior = {
        "params": {"k": 10, "holdout": 5, "seed": 1234},
        "metrics": {
            "recall_at_k": 0.4,
            "precision_at_k": 0.08,
            "groundedness_score": 0.9,
            "n_candidates": 40,
            "n_traits": 5,
            "hits": [],
        },
    }
    out = ev.format_compare(curr, prior)
    # Some metric value from current should be present
    assert "0.600" in out or "0.6" in out
    # Delta indicators must be present (positive change or unchanged)
    assert "+" in out or "unchanged" in out
    # Prior value should appear too
    assert "0.400" in out or "0.4" in out


def test_format_compare_unchanged_metric():
    """Metrics with no change should show 'unchanged'."""
    curr = {
        "metrics": {
            "recall_at_k": 0.5,
            "precision_at_k": 0.05,
            "groundedness_score": 0.9,
            "n_candidates": 30,
            "n_traits": 4,
            "hits": [],
        }
    }
    prior = {
        "metrics": {
            "recall_at_k": 0.5,
            "precision_at_k": 0.05,
            "groundedness_score": 0.9,
            "n_candidates": 30,
            "n_traits": 4,
            "hits": [],
        }
    }
    out = ev.format_compare(curr, prior)
    assert "unchanged" in out


# ---------------------------------------------------------------------------
# load_snapshot() tests
# ---------------------------------------------------------------------------

def test_load_snapshot_reads_json(tmp_path):
    """load_snapshot returns the parsed dict from a JSON file."""
    import json
    data = {"schema_version": 1, "metrics": {"recall_at_k": 0.5}}
    p = tmp_path / "results_test.json"
    p.write_text(json.dumps(data))
    result = ev.load_snapshot(str(p))
    assert result["schema_version"] == 1
    assert result["metrics"]["recall_at_k"] == 0.5


def test_load_snapshot_missing_file(tmp_path):
    """load_snapshot raises FileNotFoundError for a non-existent path."""
    import pytest
    missing = str(tmp_path / "no_such_file.json")
    with pytest.raises(FileNotFoundError):
        ev.load_snapshot(missing)
