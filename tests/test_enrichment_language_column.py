from mylibrary.db import Enrichment


def test_enrichment_has_language_column():
    assert "language" in Enrichment.__table__.columns
    assert Enrichment.__table__.columns["language"].nullable is True
