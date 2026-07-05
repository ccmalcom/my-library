import importlib


def _fresh(monkeypatch, tmp_path):
    monkeypatch.setenv("MYLIBRARY_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("DATABASE_URL", raising=False)
    import mylibrary.config as config, mylibrary.db as db, mylibrary.highlights as highlights
    importlib.reload(config); importlib.reload(db); importlib.reload(highlights)
    db.init_db()
    return db, highlights


def _add(db, session, *, title, author, rating, subjects=None, pages=None,
         year=None, series=None, shelf="read"):
    book = db.Book(
        user_id="local", title=title, author=author, goodreads_rating=rating,
        page_count=pages, year_published=year, exclusive_shelf=shelf,
    )
    session.add(book)
    session.flush()
    session.add(db.Enrichment(book_id=book.id, subjects=subjects or [], series=series))
    return book


def test_compute_highlights_shapes_all_fields(monkeypatch, tmp_path):
    db, highlights = _fresh(monkeypatch, tmp_path)
    with db.session_scope() as s:
        _add(db, s, title="A", author="Ursula K. Le Guin", rating=5,
             subjects=["Fantasy", "Science Fiction"], pages=300, year=1974)
        _add(db, s, title="B", author="Ursula K. Le Guin", rating=5,
             subjects=["Fantasy"], pages=280, year=1969)
        _add(db, s, title="C", author="Brandon Sanderson", rating=3,
             subjects=["Fantasy"], pages=1000, year=2010, series="Stormlight")
        _add(db, s, title="D", author="Anton Chekhov", rating=4,
             subjects=["Short Stories", "Classics"], pages=90, year=1890)

    with db.session_scope() as s:
        out = highlights.compute_highlights(s, "local")

    assert out["thin"] is True  # only 4 rated books < 12
    assert out["n_authors"] == 3
    # Le Guin clears the 2-book bar; Sanderson/Chekhov do not.
    assert "Ursula K. Le Guin" in out["top_authors"]
    assert "Brandon Sanderson" not in out["top_authors"]
    # Fantasy appears in 3 of 4 enriched books -> top genre.
    assert out["top_genres"][0]["subject"] == "Fantasy"
    assert 0.0 < out["top_genres"][0]["share"] <= 1.0
    fm = out["format_mix"]
    assert fm["series"] == 1        # Sanderson has series metadata
    assert fm["novella"] == 1       # Chekhov 90pp < 120
    assert fm["dominant"] in {"novel", "novella", "collection", "series"}
    assert out["era_split"] == {"pre_2000": 3, "post_2000": 1}


def test_compute_highlights_empty_library(monkeypatch, tmp_path):
    db, highlights = _fresh(monkeypatch, tmp_path)
    with db.session_scope() as s:
        out = highlights.compute_highlights(s, "local")
    assert out["thin"] is True
    assert out["n_authors"] == 0
    assert out["top_genres"] == []
    assert out["top_authors"] == []
    assert out["era_split"] is None
