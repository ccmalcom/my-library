import importlib
import pytest


def _fresh(monkeypatch, tmp_path):
    monkeypatch.setenv("MYLIBRARY_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    import mylibrary.config as config, mylibrary.db as db, mylibrary.profile as profile
    importlib.reload(config); importlib.reload(db); importlib.reload(profile)
    db.init_db()
    return db, profile


class _Sentinel(Exception):
    pass


def _seed_rated_books(db, n=3):
    with db.session_scope() as s:
        for i in range(n):
            s.add(db.Book(user_id="local", title=f"Book {i}", author=f"Auth {i}", goodreads_rating=5))


def test_extract_routes_through_tracked_create(monkeypatch, tmp_path):
    db, profile = _fresh(monkeypatch, tmp_path)
    _seed_rated_books(db)

    # Dummy Anthropic so client construction doesn't hit the network.
    monkeypatch.setattr(profile, "Anthropic", lambda api_key=None: object(), raising=False)

    captured = {}
    def fake_tracked_create(client, *, user_id, operation, **kw):
        captured.update(user_id=user_id, operation=operation, model=kw.get("model"))
        raise _Sentinel()
    monkeypatch.setattr(profile, "tracked_create", fake_tracked_create)

    with pytest.raises(_Sentinel):
        profile.extract_taste_profile(user_id="local")
    assert captured["operation"] == "profile_full"
    assert captured["user_id"] == "local"
    assert captured["model"]  # settings.model
