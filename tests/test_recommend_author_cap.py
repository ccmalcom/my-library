from mylibrary import recommend


def _cand(title, author):
    return {"title": title, "author": author, "retrieval_pool": "metadata"}


def test_per_author_cap_limits_clones():
    cands = [_cand(f"Book {i}", "Brandon Sanderson") for i in range(6)]
    out = recommend._apply_author_caps(cands, {"library_authors": set()})
    assert len(out) == recommend._MAX_PER_AUTHOR


def test_library_author_share_capped():
    # Use two distinct library-author surnames so per-author cap alone leaves 4 library
    # candidates (2 alpha + 2 beta). With 2 non-library candidates the post-per-author
    # pool is 6, and 4/6 ≈ 67% > _MAX_LIBRARY_AUTHOR_SHARE (0.4), so the share-cap
    # branch must fire to trim library authors down to int(6 * 0.4) = 2.
    lib_alpha = [_cand(f"LA{i}", "Library Alpha") for i in range(4)]
    lib_beta = [_cand(f"LB{i}", "Library Beta") for i in range(4)]
    new = [_cand("N1", "Fresh One"), _cand("N2", "Fresh Two")]
    signal = {
        "library_authors": {"alpha", "beta"},  # _surname("Library Alpha/Beta")
    }
    all_cands = lib_alpha + lib_beta + new
    out = recommend._apply_author_caps(all_cands, signal)

    lib_kept = [c for c in out if recommend._surname(c["author"]) in {"alpha", "beta"}]

    # New-author candidates must survive unchanged
    assert all(c in out for c in new)
    # The share-cap branch trimmed library authors below per-author-cap-only count (4 → 2)
    per_author_kept_lib = recommend._MAX_PER_AUTHOR * 2  # 2 authors × 2 each = 4
    assert len(lib_kept) < per_author_kept_lib
    # Specifically: max_lib = int(6 * 0.4) = 2
    assert len(lib_kept) <= int((recommend._MAX_PER_AUTHOR * 2 + len(new)) * recommend._MAX_LIBRARY_AUTHOR_SHARE)
