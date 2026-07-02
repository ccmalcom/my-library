import importlib
from types import SimpleNamespace


def _fresh(monkeypatch, tmp_path, **env):
    monkeypatch.setenv("MYLIBRARY_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("DATABASE_URL", raising=False)
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    import mylibrary.config as config, mylibrary.db as db, mylibrary.usage as usage
    importlib.reload(config); importlib.reload(db); importlib.reload(usage)
    db.init_db()
    return db, usage


def _usage(inp=0, out=0, cw=0, cr=0):
    return SimpleNamespace(
        input_tokens=inp, output_tokens=out,
        cache_creation_input_tokens=cw, cache_read_input_tokens=cr,
    )


def test_cost_known_model(monkeypatch, tmp_path):
    _db, usage = _fresh(monkeypatch, tmp_path)
    # Sonnet 4.6: $3 in / $15 out per MTok -> 1e6 in + 1e6 out = $18.00
    c = usage.cost_usd("claude-sonnet-4-6", _usage(inp=1_000_000, out=1_000_000))
    assert round(c, 2) == 18.00


def test_cost_unknown_model_uses_default(monkeypatch, tmp_path):
    _db, usage = _fresh(monkeypatch, tmp_path)
    c = usage.cost_usd("some-future-model", _usage(inp=1_000_000))
    assert c > 0  # falls back to DEFAULT_PRICING, never crashes


def test_cost_sonnet_5_promo_pricing(monkeypatch, tmp_path):
    import datetime as dt
    _db, usage = _fresh(monkeypatch, tmp_path)
    monkeypatch.setattr(usage, "_today", lambda: dt.date(2026, 7, 15))  # inside the promo window
    # Sonnet 5 promo: $2 in / $10 out per MTok -> 1e6 in + 1e6 out = $12.00
    c = usage.cost_usd("claude-sonnet-5", _usage(inp=1_000_000, out=1_000_000))
    assert round(c, 2) == 12.00


def test_cost_sonnet_5_post_promo_pricing(monkeypatch, tmp_path):
    import datetime as dt
    _db, usage = _fresh(monkeypatch, tmp_path)
    monkeypatch.setattr(usage, "_today", lambda: dt.date(2026, 9, 1))  # promo has lapsed
    # Sonnet 5 list price after 2026-08-31: $3 in / $15 out per MTok -> $18.00
    c = usage.cost_usd("claude-sonnet-5", _usage(inp=1_000_000, out=1_000_000))
    assert round(c, 2) == 18.00


def test_record_and_cap_status(monkeypatch, tmp_path):
    db, usage = _fresh(monkeypatch, tmp_path, MYLIBRARY_MONTHLY_SOFT_CAP_USD="10.0", MYLIBRARY_USAGE_WARN_THRESHOLD="0.8")
    usage.record_usage(user_id="local", model="claude-sonnet-4-6", operation="profile_full",
                       usage=_usage(inp=1_000_000, out=0))  # $3.00
    st = usage.cap_status("local")
    assert round(st["spent_usd"], 2) == 3.00
    assert st["cap_usd"] == 10.0
    assert st["warn"] is False
    assert st["by_operation"]["profile_full"] > 0


def test_warn_flips_past_threshold(monkeypatch, tmp_path):
    db, usage = _fresh(monkeypatch, tmp_path, MYLIBRARY_MONTHLY_SOFT_CAP_USD="2.0", MYLIBRARY_USAGE_WARN_THRESHOLD="0.8")
    usage.record_usage(user_id="local", model="claude-sonnet-4-6", operation="profile_full",
                       usage=_usage(inp=1_000_000, out=0))  # $3.00 > 0.8*2.0
    st = usage.cap_status("local")
    assert st["warn"] is True


def test_record_usage_never_raises(monkeypatch, tmp_path):
    db, usage = _fresh(monkeypatch, tmp_path)
    # A malformed usage object must not raise out of record_usage.
    usage.record_usage(user_id="local", model="x", operation="y", usage=object())


def test_tracked_create_records_and_returns(monkeypatch, tmp_path):
    db, usage = _fresh(monkeypatch, tmp_path)

    class FakeMessages:
        def create(self, **kwargs):
            return SimpleNamespace(content=[], usage=_usage(inp=500_000, out=0))

    class FakeClient:
        messages = FakeMessages()

    msg = usage.tracked_create(FakeClient(), user_id="local", operation="recommend_seed",
                               model="claude-haiku-4-5-20251001", max_tokens=10, messages=[])
    assert msg is not None
    with db.session_scope() as s:
        rows = s.query(db.UsageEvent).all()
        assert len(rows) == 1
        assert rows[0].operation == "recommend_seed"
        assert rows[0].cost_usd > 0
