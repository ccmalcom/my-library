import importlib
import pytest


def _fresh(monkeypatch, tmp_path):
    monkeypatch.setenv("MYLIBRARY_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    import mylibrary.config as config, mylibrary.db as db, mylibrary.reveal as reveal
    importlib.reload(config); importlib.reload(db); importlib.reload(reveal)
    db.init_db()
    return db, reveal


class _Sentinel(Exception):
    pass


def _seed_trait(db, claim="Rewards dense, stylized prose; rates workmanlike prose lower"):
    with db.session_scope() as s:
        t = db.TasteTrait(user_id="local", claim=claim, polarity="reward",
                          inference_confidence=0.8, status="proposed")
        s.add(t)
        s.flush()
        return t.id


def test_reveal_lines_route_through_tracked_create(monkeypatch, tmp_path):
    db, reveal = _fresh(monkeypatch, tmp_path)
    _seed_trait(db)
    monkeypatch.setattr(reveal, "Anthropic", lambda api_key=None: object(), raising=False)

    captured = {}
    def fake_tracked_create(client, *, user_id, operation, **kw):
        captured.update(user_id=user_id, operation=operation, model=kw.get("model"))
        raise _Sentinel()
    monkeypatch.setattr(reveal, "tracked_create", fake_tracked_create)

    with pytest.raises(_Sentinel):
        reveal.generate_reveal_lines(user_id="local")
    assert captured["operation"] == "reveal_lines"
    assert captured["user_id"] == "local"
    assert captured["model"] == reveal._MODEL


def test_generate_persists_lines_and_is_idempotent(monkeypatch, tmp_path):
    db, reveal = _fresh(monkeypatch, tmp_path)
    tid = _seed_trait(db)
    monkeypatch.setattr(reveal, "Anthropic", lambda api_key=None: object(), raising=False)

    class _Block:
        type = "tool_use"
        input = {"lines": [{"id": tid, "reveal_line": "You notice sentences. Plain prose works twice as hard."}]}

    class _Msg:
        content = [_Block()]
        usage = None

    calls = {"n": 0}
    def fake_tracked_create(client, *, user_id, operation, **kw):
        calls["n"] += 1
        return _Msg()
    monkeypatch.setattr(reveal, "tracked_create", fake_tracked_create)

    res = reveal.generate_reveal_lines(user_id="local")
    assert res["generated"] == 1
    with db.session_scope() as s:
        t = s.get(db.TasteTrait, tid)
        assert t.reveal_line.startswith("You notice sentences")

    # Second call: line already present -> no Claude call, nothing generated.
    res2 = reveal.generate_reveal_lines(user_id="local")
    assert res2["generated"] == 0
    assert calls["n"] == 1  # unchanged


def test_generate_no_traits_is_noop(monkeypatch, tmp_path):
    db, reveal = _fresh(monkeypatch, tmp_path)
    monkeypatch.setattr(reveal, "Anthropic", lambda api_key=None: object(), raising=False)
    def fake_tracked_create(*a, **k):
        raise AssertionError("should not call Claude with no traits")
    monkeypatch.setattr(reveal, "tracked_create", fake_tracked_create)

    res = reveal.generate_reveal_lines(user_id="local")
    assert res["generated"] == 0
