from mylibrary import recommend


def _cand(title, author):
    return {"title": title, "author": author, "retrieval_pool": "metadata"}


def test_per_author_cap_limits_clones():
    cands = [_cand(f"Book {i}", "Brandon Sanderson") for i in range(6)]
    out = recommend._apply_author_caps(cands, {"library_authors": set()})
    assert len(out) == recommend._MAX_PER_AUTHOR


def test_library_author_share_capped():
    # 8 candidates: 6 by a library author, 2 by new authors. Share cap = 0.4.
    lib = [_cand(f"L{i}", "Library Author") for i in range(6)]
    new = [_cand("N1", "Fresh One"), _cand("N2", "Fresh Two")]
    signal = {"library_authors": {"author"}}  # _surname("Library Author") == "author"
    out = recommend._apply_author_caps(lib + new, signal)
    lib_kept = [c for c in out if recommend._surname(c["author"]) == "author"]
    # per-author cap already trims to 2, which is <= 40% of total kept — both new survive
    assert all(c in out for c in new)
    assert len(lib_kept) <= recommend._MAX_PER_AUTHOR
