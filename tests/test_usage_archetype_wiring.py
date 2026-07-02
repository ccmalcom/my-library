import importlib
import pytest


def _fresh(monkeypatch, tmp_path):
    monkeypatch.setenv("MYLIBRARY_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    import mylibrary.config as config, mylibrary.db as db, mylibrary.archetype as archetype
    importlib.reload(config); importlib.reload(db); importlib.reload(archetype)
    db.init_db()
    return db, archetype


class _Sentinel(Exception):
    pass


def test_archetype_routes_through_tracked_create(monkeypatch, tmp_path):
    db, archetype = _fresh(monkeypatch, tmp_path)
    # Seed at least one taste trait so derive_archetype reaches the Claude call.
    with db.session_scope() as s:
        s.add(db.TasteTrait(user_id="local", claim="loves slow character studies",
                            polarity="reward", inference_confidence=0.9))

    monkeypatch.setattr(archetype, "Anthropic", lambda api_key=None: object(), raising=False)

    captured = {}
    def fake_tracked_create(client, *, user_id, operation, **kw):
        captured.update(user_id=user_id, operation=operation, model=kw.get("model"))
        raise _Sentinel()
    monkeypatch.setattr(archetype, "tracked_create", fake_tracked_create)

    with pytest.raises(_Sentinel):
        archetype.derive_archetype(user_id="local")
    assert captured["operation"] == "archetype"
    assert captured["user_id"] == "local"
    assert captured["model"] == archetype._MODEL
