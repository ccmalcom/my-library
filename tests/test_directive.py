import pytest

from mylibrary import directive
from mylibrary.config import LOCAL_USER_ID


def test_get_directive_none_when_unset():
    assert directive.get_directive(user_id=LOCAL_USER_ID) is None


def test_set_then_get_roundtrip():
    directive.set_directive(
        "Read more nonfiction this year. No grimdark.",
        {"exclude_subjects": ["War"], "languages": ["EN"], "min_year": "2000"},
        user_id=LOCAL_USER_ID,
    )
    got = directive.get_directive(user_id=LOCAL_USER_ID)
    assert got["nl_text"] == "Read more nonfiction this year. No grimdark."
    # constraints are normalized: lowercased, 2-letter lang, int year
    assert got["constraints"] == {
        "exclude_subjects": ["war"],
        "languages": ["en"],
        "min_year": 2000,
    }


def test_set_is_upsert_single_row():
    directive.set_directive("first", user_id=LOCAL_USER_ID)
    directive.set_directive("second", user_id=LOCAL_USER_ID)
    got = directive.get_directive(user_id=LOCAL_USER_ID)
    assert got["nl_text"] == "second"


def test_set_empty_raises():
    with pytest.raises(ValueError):
        directive.set_directive("   ", {}, user_id=LOCAL_USER_ID)


def test_clear_directive():
    directive.set_directive("gone soon", user_id=LOCAL_USER_ID)
    directive.clear_directive(user_id=LOCAL_USER_ID)
    assert directive.get_directive(user_id=LOCAL_USER_ID) is None


def test_clean_drops_unfilterable_keys():
    cleaned = directive._clean_directive_constraints(
        {"max_pages": 300, "series_only": True, "exclude_authors": ["Martin", " "]}
    )
    assert cleaned == {"exclude_authors": ["martin"]}


def test_directive_survives_clear_library_and_profile():
    from mylibrary import purge
    directive.set_directive("keep me", {"languages": ["en"]}, user_id=LOCAL_USER_ID)
    purge.clear_profile(user_id=LOCAL_USER_ID)
    assert directive.get_directive(user_id=LOCAL_USER_ID) is not None
    purge.clear_library(user_id=LOCAL_USER_ID)
    assert directive.get_directive(user_id=LOCAL_USER_ID) is not None


def test_directive_dropped_on_delete_account():
    from mylibrary import purge
    directive.set_directive("delete me", user_id=LOCAL_USER_ID)
    result = purge.delete_account(user_id=LOCAL_USER_ID)
    assert directive.get_directive(user_id=LOCAL_USER_ID) is None
    assert result["directive_removed"] == 1
