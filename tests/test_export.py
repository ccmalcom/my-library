"""Export / backup: CSV + JSON, user-scoped, round-trippable."""
from __future__ import annotations

import csv
import io

from mylibrary.db import Book, TasteSignal, session_scope
from mylibrary.exporters import export_csv, export_json
from mylibrary.importers import import_text
from mylibrary.importers.core import ImportRow, import_rows


def _seed():
    import_rows(
        [
            ImportRow(title="Dune", author="Frank Herbert", isbn13="9780441172719",
                      shelf="read", rating=5),
            ImportRow(title="Piranesi", author="Susanna Clarke", shelf="to-read"),
        ],
        source="goodreads_import",
    )
    with session_scope() as session:
        dune = session.query(Book).filter(Book.title == "Dune").one()
        dune.app_rating = 4
        dune.app_review = "Reread it."
        session.add(TasteSignal(user_id="local", direction="more", target_kind="book",
                                target_book_id=dune.id))


def test_export_csv_has_canonical_header_and_effective_values():
    _seed()
    text = export_csv()
    rows = list(csv.DictReader(io.StringIO(text)))
    assert "title" in rows[0] and "review" in rows[0]
    dune = next(r for r in rows if r["title"] == "Dune")
    assert dune["rating"] == "4"          # effective_rating (app_rating wins)
    assert dune["review"] == "Reread it."


def test_export_json_includes_books_and_taste_signals():
    _seed()
    data = export_json()
    assert data["version"] == 1
    titles = {b["title"] for b in data["books"]}
    assert {"Dune", "Piranesi"} <= titles
    assert len(data["taste_signals"]) == 1
    dune = next(b for b in data["books"] if b["title"] == "Dune")
    assert dune["app_rating"] == 4 and dune["app_review"] == "Reread it."
    assert dune["is_favorite"] in (True, False)


def test_csv_export_roundtrips_through_import():
    _seed()
    text = export_csv()
    with session_scope() as session:  # wipe to prove re-import recreates
        session.query(Book).delete()
    out = import_text(text, fmt="canonical")
    assert out["inserted"] == 2
    with session_scope() as session:
        assert session.query(Book).filter(Book.title == "Dune").one().goodreads_rating == 4


def test_export_endpoint_csv_download():
    from fastapi.testclient import TestClient
    from mylibrary.api import app

    _seed()
    client = TestClient(app)
    r = client.get("/export?format=csv")
    assert r.status_code == 200
    assert "attachment" in r.headers["content-disposition"]
    assert r.headers["content-type"].startswith("text/csv")
    assert "title,author" in r.text

    rj = client.get("/export?format=json")
    assert rj.status_code == 200
    assert rj.json()["version"] == 1


def test_export_endpoint_rejects_bad_format():
    from fastapi.testclient import TestClient
    from mylibrary.api import app

    r = TestClient(app).get("/export?format=xml")
    assert r.status_code == 422
