# tests/test_usage_recommend_wiring.py
import importlib
import pytest


def _fresh(monkeypatch, tmp_path):
    monkeypatch.setenv("MYLIBRARY_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    import mylibrary.config as config, mylibrary.db as db, mylibrary.recommend as recommend
    importlib.reload(config); importlib.reload(db); importlib.reload(recommend)
    db.init_db()
    return db, recommend


class _Sentinel(Exception):
    pass


def test_seed_queries_pass_operation_and_user(monkeypatch, tmp_path):
    _db, recommend = _fresh(monkeypatch, tmp_path)
    captured = {}
    def fake_tracked_create(client, *, user_id, operation, **kw):
        captured.update(user_id=user_id, operation=operation, model=kw.get("model"))
        raise _Sentinel()
    monkeypatch.setattr(recommend, "tracked_create", fake_tracked_create)

    signal = {"traits": [], "loved": [], "more_like": [], "less_like": []}
    with pytest.raises(_Sentinel):
        recommend._claude_seed_queries(signal, n_queries=3, api_key="test-key", user_id="local")
    assert captured["operation"] == "recommend_seed"
    assert captured["user_id"] == "local"
    assert captured["model"] == "claude-haiku-4-5-20251001"


def test_rerank_passes_operation_and_user(monkeypatch, tmp_path):
    _db, recommend = _fresh(monkeypatch, tmp_path)
    captured = {}
    def fake_tracked_create(client, *, user_id, operation, **kw):
        captured.update(user_id=user_id, operation=operation, model=kw.get("model"))
        raise _Sentinel()
    monkeypatch.setattr(recommend, "tracked_create", fake_tracked_create)

    signal = {"traits": [], "loved": [], "more_like": [], "less_like": [], "reject_reason_counts": {}}
    candidates = [{"title": "X", "author": "Y", "year": 2000, "subjects": []}]
    with pytest.raises(_Sentinel):
        recommend._claude_rerank(candidates, signal, n=5, api_key="test-key", user_id="local")
    assert captured["operation"] == "recommend_rerank"
    assert captured["user_id"] == "local"
