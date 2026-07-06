from mylibrary import directive, recommend
from mylibrary.config import LOCAL_USER_ID
from mylibrary.db import session_scope


def test_apply_directive_constraints_filters():
    cands = [
        {"title": "Old",     "author": "A. Writer",         "year": 1990, "subjects": ["war", "history"]},
        {"title": "New",     "author": "B. Writer",         "year": 2020, "subjects": ["friendship"]},
        {"title": "Warish",  "author": "C. Writer",         "year": 2021, "subjects": ["War Stories"]},
        {"title": "ByMartin","author": "George R. R. Martin","year": 2015, "subjects": ["fantasy"]},
    ]
    out = recommend._apply_directive_constraints(
        cands,
        {"min_year": 2000, "exclude_subjects": ["war"], "exclude_authors": ["martin"]},
    )
    assert {c["title"] for c in out} == {"New"}


def test_apply_directive_constraints_empty_passthrough():
    cands = [{"title": "x", "author": None, "year": None, "subjects": []}]
    assert recommend._apply_directive_constraints(cands, {}) == cands


def test_steering_block_includes_directive():
    signal = {"more_like": [], "less_like": [], "reject_reason_counts": {},
              "directive_text": "More nonfiction this year. No grimdark."}
    block = recommend._user_steering_block(signal)
    assert "CUSTOM INSTRUCTIONS" in block
    assert "No grimdark." in block


def test_build_signal_attaches_directive():
    directive.set_directive("More translated fiction.", {"languages": ["fr"]}, user_id=LOCAL_USER_ID)
    with session_scope() as s:
        sig = recommend._build_signal(s, LOCAL_USER_ID)
    assert sig["directive_text"] == "More translated fiction."
    assert sig["directive_constraints"] == {"languages": ["fr"]}
