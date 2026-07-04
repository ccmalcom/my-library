import importlib
from datetime import datetime, timedelta

from fastapi.testclient import TestClient


def _client(monkeypatch, tmp_path):
    monkeypatch.setenv("MYLIBRARY_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_JWT_SECRET", raising=False)
    import mylibrary.api as api
    import mylibrary.config as config
    import mylibrary.db as db
    importlib.reload(config)
    importlib.reload(db)
    importlib.reload(api)
    db.init_db()
    return api, TestClient(api.app)


def test_admin_usage_lists_events_newest_first_with_email(monkeypatch, tmp_path):
    api, client = _client(monkeypatch, tmp_path)
    import mylibrary.db as db

    with db.session_scope() as s:
        s.add(db.Invite(email="a@x.io", invited_by="local", supabase_user_id="sb-a", status="active"))
        s.add(db.UsageEvent(
            user_id="sb-a", model="claude-sonnet-5", operation="recommend_seed",
            input_tokens=100, output_tokens=50, cost_usd=0.01,
            created_at=datetime(2026, 1, 1),
        ))
        s.add(db.UsageEvent(
            user_id="sb-a", model="claude-sonnet-5", operation="profile_full",
            input_tokens=200, output_tokens=80, cost_usd=0.02,
            created_at=datetime(2026, 1, 2),
        ))

    r = client.get("/admin/usage")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == 2
    assert body["events"][0]["operation"] == "profile_full"  # newest first
    assert body["events"][0]["email"] == "a@x.io"
    assert round(body["total_cost_usd"], 2) == 0.03


def test_admin_usage_filters_by_operation(monkeypatch, tmp_path):
    api, client = _client(monkeypatch, tmp_path)
    import mylibrary.db as db

    with db.session_scope() as s:
        s.add(db.UsageEvent(user_id="sb-a", model="m", operation="recommend_seed", cost_usd=0.01))
        s.add(db.UsageEvent(user_id="sb-a", model="m", operation="profile_full", cost_usd=0.02))

    r = client.get("/admin/usage", params={"operation": "profile_full"})
    body = r.json()
    assert body["total"] == 1
    assert body["events"][0]["operation"] == "profile_full"


def test_admin_usage_pagination(monkeypatch, tmp_path):
    api, client = _client(monkeypatch, tmp_path)
    import mylibrary.db as db

    with db.session_scope() as s:
        for i in range(5):
            s.add(db.UsageEvent(
                user_id="sb-a", model="m", operation="archetype", cost_usd=0.01,
                created_at=datetime(2026, 1, 1) + timedelta(minutes=i),
            ))

    r = client.get("/admin/usage", params={"limit": 2, "offset": 0})
    body = r.json()
    assert body["total"] == 5
    assert len(body["events"]) == 2

    r2 = client.get("/admin/usage", params={"limit": 2, "offset": 4})
    assert len(r2.json()["events"]) == 1
