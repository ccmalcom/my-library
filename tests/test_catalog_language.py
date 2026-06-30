from mylibrary import catalog


def test_norm_lang_maps_marc_and_iso():
    assert catalog._norm_lang("en") == "en"
    assert catalog._norm_lang(["eng"]) == "en"
    assert catalog._norm_lang("spa") == "es"
    assert catalog._norm_lang("fre") == "fr"
    assert catalog._norm_lang(None) is None
    assert catalog._norm_lang([]) is None


def test_google_candidates_carry_language(monkeypatch):
    payload = {"items": [
        {"id": "x", "volumeInfo": {"title": "Dune", "language": "en"}},
    ]}
    monkeypatch.setattr(catalog, "_get_json", lambda url, **k: payload)
    cands = catalog._google_books_query("dune")
    assert cands[0]["language"] == "en"
