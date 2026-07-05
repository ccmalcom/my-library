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


def test_admin_feedback_lists_items_newest_first_with_email(monkeypatch, tmp_path):
    api, client = _client(monkeypatch, tmp_path)
    import mylibrary.db as db

    with db.session_scope() as s:
        s.add(db.Invite(email="b@x.io", invited_by="local", supabase_user_id="sb-b", status="active"))
        s.add(db.Feedback(
            user_id="sb-b", category="bug", body="broken swipe", created_at=datetime(2026, 1, 1),
        ))
        s.add(db.Feedback(
            user_id="sb-b", category="idea", body="add dark mode", created_at=datetime(2026, 1, 2),
        ))

    r = client.get("/admin/feedback")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == 2
    assert body["items"][0]["category"] == "idea"  # newest first
    assert body["items"][0]["email"] == "b@x.io"


def test_admin_feedback_filters_by_category(monkeypatch, tmp_path):
    api, client = _client(monkeypatch, tmp_path)
    import mylibrary.db as db

    with db.session_scope() as s:
        s.add(db.Feedback(user_id="sb-b", category="bug", body="one"))
        s.add(db.Feedback(user_id="sb-b", category="praise", body="two"))

    r = client.get("/admin/feedback", params={"category": "bug"})
    body = r.json()
    assert body["total"] == 1
    assert body["items"][0]["category"] == "bug"


def test_admin_feedback_pagination(monkeypatch, tmp_path):
    api, client = _client(monkeypatch, tmp_path)
    import mylibrary.db as db

    with db.session_scope() as s:
        for i in range(5):
            s.add(db.Feedback(
                user_id="sb-b", category="idea", body=f"idea {i}",
                created_at=datetime(2026, 1, 1) + timedelta(minutes=i),
            ))

    r = client.get("/admin/feedback", params={"limit": 2, "offset": 0})
    body = r.json()
    assert body["total"] == 5
    assert len(body["items"]) == 2
