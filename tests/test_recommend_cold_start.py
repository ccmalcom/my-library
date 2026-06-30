from mylibrary import recommend


def test_is_cold_start_thresholds():
    assert recommend._is_cold_start({"loved": [1] * 3, "rated_count": 3}) is True
    assert recommend._is_cold_start({"loved": [1] * 20, "rated_count": 5}) is True   # rated < 12
    assert recommend._is_cold_start({"loved": [1] * 20, "rated_count": 30}) is False
    assert recommend._is_cold_start({"loved": [1] * 8, "rated_count": 30}) is False  # loved==8, not cold
    assert recommend._is_cold_start({"loved": [1] * 20, "rated_count": 12}) is False  # rated==12, not cold


def test_metadata_pool_skips_authors_when_cold(monkeypatch):
    import mylibrary.catalog as cat
    monkeypatch.setattr(cat, "openlibrary_subject", lambda s, **k: [{"title": "S", "author": "A", "source": "openlibrary"}])
    monkeypatch.setattr(cat, "googlebooks_subject", lambda s, **k: [])
    called = {"authors": 0}
    def _author(a, **k):
        called["authors"] += 1
        return [{"title": "by-author", "author": a, "source": "googlebooks"}]
    monkeypatch.setattr(cat, "googlebooks_author", _author)

    signal = {"top_subjects": ["scifi"], "top_authors": ["Herbert"]}
    pool = recommend._metadata_pool(signal, per_query=3, cold_start=True)
    assert called["authors"] == 0
    assert all("by-author" != c["title"] for c, _ in pool)
