import importlib
from fastapi.testclient import TestClient


def _client(monkeypatch, tmp_path):
    monkeypatch.setenv("MYLIBRARY_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    import mylibrary.config as config, mylibrary.db as db, mylibrary.api as api
    importlib.reload(config); importlib.reload(db); importlib.reload(api)
    db.init_db()
    return api, TestClient(api.app)


def test_usage_endpoint_reports_spend(monkeypatch, tmp_path):
    api, client = _client(monkeypatch, tmp_path)
    import mylibrary.usage as usage
    from types import SimpleNamespace
    usage.record_usage(user_id="local", model="claude-sonnet-4-6", operation="profile_full",
                       usage=SimpleNamespace(input_tokens=1_000_000, output_tokens=0,
                                             cache_creation_input_tokens=0, cache_read_input_tokens=0))
    body = client.get("/settings/usage").json()
    assert round(body["spent_usd"], 2) == 3.00
    assert "by_operation" in body
    assert body["warn"] in (True, False)


def test_usage_endpoint_zero_usage(monkeypatch, tmp_path):
    """A user who has never triggered Claude usage (e.g. opening Settings right after
    signup) must still get a clean 200 with zeroed-out fields, not an error."""
    _api, client = _client(monkeypatch, tmp_path)
    resp = client.get("/settings/usage")
    assert resp.status_code == 200
    body = resp.json()
    assert body["spent_usd"] == 0.0
    assert body["by_operation"] == {}


def test_usage_endpoint_requires_auth(monkeypatch, tmp_path):
    """Hosted mode (SUPABASE_JWT_SECRET set) must reject requests without a valid bearer
    token, confirming the route's `user_id: UserId` dependency actually enforces auth
    rather than merely declaring it. Mirrors the HS256 fallback path used in
    tests/test_admin_auth.py."""
    monkeypatch.setenv("MYLIBRARY_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.setenv("SUPABASE_JWT_SECRET", "testsecret")
    import importlib
    import mylibrary.config as config, mylibrary.db as db, mylibrary.api as api
    importlib.reload(config); importlib.reload(db); importlib.reload(api)
    db.init_db()
    client = TestClient(api.app)

    resp = client.get("/settings/usage")
    assert resp.status_code == 401

    resp = client.get("/settings/usage", headers={"Authorization": "Bearer not-a-real-token"})
    assert resp.status_code == 401
