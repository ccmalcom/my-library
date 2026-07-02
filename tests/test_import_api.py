"""API tests for multi-format import."""
from __future__ import annotations

import os

from fastapi.testclient import TestClient

from mylibrary.api import app
from mylibrary.db import Book, session_scope

client = TestClient(app)
STORYGRAPH_CSV = os.path.join(os.path.dirname(__file__), "sample_storygraph.csv")
GENERIC_CSV = os.path.join(os.path.dirname(__file__), "sample_generic.csv")


def _upload(path: str, url: str, data: dict | None = None):
    with open(path, "rb") as fh:
        return client.post(
            url,
            files={"file": (os.path.basename(path), fh, "text/csv")},
            data=data or {},
        )


def test_preview_detects_storygraph():
    r = _upload(STORYGRAPH_CSV, "/import/preview")
    assert r.status_code == 200
    body = r.json()
    assert body["format"] == "storygraph"
    assert "Title" in body["headers"]
    assert len(body["sample_rows"]) >= 1


def test_preview_unknown_suggests_mapping():
    r = _upload(GENERIC_CSV, "/import/preview")
    body = r.json()
    assert body["format"] == "unknown"
    assert body["suggested_mapping"]["title"] == "Book Title"


def test_import_storygraph_auto():
    r = _upload(STORYGRAPH_CSV, "/import", {"format": "auto"})
    assert r.status_code == 200
    assert r.json()["inserted"] == 4
    with session_scope() as session:
        assert session.query(Book).count() == 4


def test_import_generic_with_mapping():
    import json
    mapping = json.dumps({"title": "Book Title", "author": "Writer",
                          "rating": "My Stars", "shelf": "Status"})
    r = _upload(GENERIC_CSV, "/import", {"format": "generic", "mapping": mapping})
    assert r.status_code == 200
    assert r.json()["inserted"] == 2


def test_cli_import_storygraph():
    from typer.testing import CliRunner
    from mylibrary.cli import app as cli_app

    result = CliRunner().invoke(cli_app, ["import", STORYGRAPH_CSV, "--format", "auto"])
    assert result.exit_code == 0
    with session_scope() as session:
        assert session.query(Book).count() == 4
