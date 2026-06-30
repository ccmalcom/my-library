from mylibrary import catalog
import mylibrary.catalog as catalog_mod


def _c(title, author=None, cover=None, isbn13=None, year=None):
    return {"title": title, "author": author, "cover_url": cover,
            "isbn13": isbn13, "year": year}


def test_norm_full_keeps_subtitle():
    # The enrichment normalizer drops everything after ':'; the search one must NOT.
    assert catalog._norm_full("Wings of Fire: The Lost Heir") == "wings of fire the lost heir"
    assert catalog._norm_full("Wings of Fire: The Lost Heir") != catalog._norm_full("Wings of Fire: The Dragonet Prophecy")


def test_search_dedup_key_distinguishes_series_volumes():
    k7 = catalog._search_dedup_key("Wings of Fire: The Dark Secret", "Tui T. Sutherland")
    k8 = catalog._search_dedup_key("Wings of Fire: The Brightest Night", "Tui T. Sutherland")
    assert k7 != k8


def test_match_score_bands():
    q = "the fault in our stars"
    assert catalog._match_score(q, _c("The Fault in Our Stars")) == 100
    assert catalog._match_score("the fault", _c("The Fault in Our Stars")) == 80   # startswith
    assert catalog._match_score("fault stars", _c("The Fault in Our Stars")) == 60  # all tokens
    assert catalog._match_score("our stars", _c("The Fault in Our Stars")) == 60  # all tokens
    assert catalog._match_score("geology", _c("Faults and Earthquakes", author="A. Geologist")) == 0
    assert catalog._match_score("green", _c("The Fault in Our Stars", author="John Green")) == 20  # author only


def test_rank_key_orders_title_match_over_keyword():
    q = "the fault"
    title_hit = _c("The Fault in Our Stars", cover="x", isbn13="9780525478812", year=2012)
    keyword_hit = _c("Active Faults of the World", cover="y", year=2014)
    ranked = sorted([keyword_hit, title_hit], key=lambda c: catalog._rank_key(q, c), reverse=True)
    assert ranked[0] is title_hit


def test_search_books_floats_title_match_to_top(monkeypatch):
    # 'the fault' must surface the title, not geoscience keyword hits.
    google_hits = [
        {"source": "googlebooks", "title": "Active Faults of the World",
         "author": "R. Yeats", "cover_url": "g1", "raw": {}},
    ]
    ol_broad = [
        {"source": "openlibrary", "title": "Fault Lines", "author": "Someone",
         "cover_url": "o1"},
    ]
    ol_title = [
        {"source": "openlibrary", "title": "The Fault in Our Stars",
         "author": "John Green", "cover_url": "o2", "isbn13": "9780525478812"},
    ]
    monkeypatch.setattr(catalog_mod, "_google_books_query", lambda q, **k: list(google_hits))
    monkeypatch.setattr(catalog_mod, "openlibrary_query", lambda q, **k: list(ol_broad))
    monkeypatch.setattr(catalog_mod, "openlibrary_title", lambda t, **k: list(ol_title))
    monkeypatch.setattr(catalog_mod, "_isbn13_from_google_item", lambda item: None)

    out = catalog_mod.search_books("the fault", max_results=5)
    assert out[0]["title"] == "The Fault in Our Stars"


def test_search_books_merges_cross_source_isbn_dupes(monkeypatch):
    g = [{"source": "googlebooks", "title": "Dune", "author": "Frank Herbert",
          "cover_url": "g", "raw": {}}]
    o = [{"source": "openlibrary", "title": "Dune", "author": "Frank Herbert",
          "cover_url": "o", "isbn13": "9780441013593"}]
    monkeypatch.setattr(catalog_mod, "_google_books_query", lambda q, **k: list(g))
    monkeypatch.setattr(catalog_mod, "openlibrary_query", lambda q, **k: list(o))
    monkeypatch.setattr(catalog_mod, "openlibrary_title", lambda t, **k: [])
    monkeypatch.setattr(catalog_mod, "_isbn13_from_google_item", lambda item: "9780441013593")

    out = catalog_mod.search_books("dune", max_results=5)
    assert sum(1 for c in out if c["title"] == "Dune") == 1


def test_search_books_keeps_distinct_series_volumes(monkeypatch):
    vols = [
        {"source": "openlibrary", "title": "Wings of Fire: The Dark Secret",
         "author": "Tui T. Sutherland", "cover_url": "c4"},
        {"source": "openlibrary", "title": "Wings of Fire: The Brightest Night",
         "author": "Tui T. Sutherland", "cover_url": "c5"},
    ]
    monkeypatch.setattr(catalog_mod, "_google_books_query", lambda q, **k: [])
    monkeypatch.setattr(catalog_mod, "openlibrary_query", lambda q, **k: list(vols))
    monkeypatch.setattr(catalog_mod, "openlibrary_title", lambda t, **k: [])
    monkeypatch.setattr(catalog_mod, "_isbn13_from_google_item", lambda item: None)

    out = catalog_mod.search_books("wings of fire", max_results=10)
    titles = {c["title"] for c in out}
    assert "Wings of Fire: The Dark Secret" in titles
    assert "Wings of Fire: The Brightest Night" in titles


def test_volume_number_parsing():
    assert catalog._volume_number("Wings of Fire #7") == 7
    assert catalog._volume_number("Wings of Fire, Book 8") == 8
    assert catalog._volume_number("Wings of Fire: Volume 3") == 3
    assert catalog._volume_number("The Fault in Our Stars") is None


def test_series_grouping_orders_volumes_and_keeps_all(monkeypatch):
    vols = [
        {"source": "openlibrary", "title": "Wings of Fire #8", "author": "Tui T. Sutherland", "cover_url": "c"},
        {"source": "openlibrary", "title": "Wings of Fire #7", "author": "Tui T. Sutherland", "cover_url": "c"},
        {"source": "openlibrary", "title": "Wings of Fire #6", "author": "Tui T. Sutherland", "cover_url": "c"},
        {"source": "openlibrary", "title": "An Unrelated Book", "author": "X", "cover_url": "c"},
    ]
    monkeypatch.setattr(catalog_mod, "_google_books_query", lambda q, **k: [])
    monkeypatch.setattr(catalog_mod, "openlibrary_query", lambda q, **k: list(vols))
    monkeypatch.setattr(catalog_mod, "openlibrary_title", lambda t, **k: [])
    monkeypatch.setattr(catalog_mod, "_isbn13_from_google_item", lambda item: None)

    out = catalog_mod.search_books("wings of fire", max_results=10)
    series_titles = [c["title"] for c in out if c["title"].startswith("Wings of Fire")]
    assert series_titles == ["Wings of Fire #6", "Wings of Fire #7", "Wings of Fire #8"]
    assert len(series_titles) == 3  # 8th (and 6th, 7th) all present
