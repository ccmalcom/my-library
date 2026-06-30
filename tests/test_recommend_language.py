from mylibrary import recommend


def test_allowed_languages_defaults_to_english_when_empty():
    assert recommend._allowed_languages({"library_languages": set()}) == {"en"}
    assert recommend._allowed_languages({}) == {"en"}


def test_allowed_languages_uses_library_languages():
    assert recommend._allowed_languages({"library_languages": {"en", "es"}}) == {"en", "es"}


def test_language_ok_allows_unknown_and_matching():
    allowed = {"en"}
    assert recommend._language_ok(None, allowed) is True       # unknown always allowed
    assert recommend._language_ok("en", allowed) is True
    assert recommend._language_ok("fr", allowed) is False      # foreign edition dropped
