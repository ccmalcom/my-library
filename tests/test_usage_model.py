import importlib


def test_usage_event_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setenv("MYLIBRARY_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("DATABASE_URL", raising=False)
    import mylibrary.config as config, mylibrary.db as db
    importlib.reload(config); importlib.reload(db)
    db.init_db()
    with db.session_scope() as s:
        s.add(db.UsageEvent(
            user_id="local", model="claude-sonnet-4-6", operation="profile_full",
            input_tokens=1000, output_tokens=200,
            cache_creation_input_tokens=0, cache_read_input_tokens=0,
            cost_usd=0.006,
        ))
    with db.session_scope() as s:
        row = s.query(db.UsageEvent).one()
        assert row.operation == "profile_full"
        assert row.cost_usd == 0.006
        assert row.created_at is not None


def test_settings_cap_defaults(monkeypatch):
    monkeypatch.delenv("MYLIBRARY_MONTHLY_SOFT_CAP_USD", raising=False)
    monkeypatch.delenv("MYLIBRARY_USAGE_WARN_THRESHOLD", raising=False)
    import mylibrary.config as config
    importlib.reload(config)
    s = config.get_settings()
    assert s.monthly_soft_cap_usd == 5.0
    assert s.usage_warn_threshold == 0.8
