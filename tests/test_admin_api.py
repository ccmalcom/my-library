import importlib

from fastapi.testclient import TestClient


def _client(monkeypatch, tmp_path):
    monkeypatch.setenv("MYLIBRARY_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_URL", raising=False)        # local mode -> local user is admin
    monkeypatch.delenv("SUPABASE_JWT_SECRET", raising=False)
    import mylibrary.api as api
    import mylibrary.config as config
    import mylibrary.db as db
    importlib.reload(config)
    importlib.reload(db)
    importlib.reload(api)
    db.init_db()
    return api, TestClient(api.app)


def test_admin_me_true_in_local_mode(monkeypatch, tmp_path):
    _api, client = _client(monkeypatch, tmp_path)
    assert client.get("/admin/me").json() == {"is_admin": True}


def test_invite_then_roster(monkeypatch, tmp_path):
    api, client = _client(monkeypatch, tmp_path)
    import mylibrary.invites as invites
    monkeypatch.setattr(invites, "invite_user", lambda email, **kw: {"id": "sb-1", "email": email})

    r = client.post("/admin/invite", json={"email": "new@x.io"})
    assert r.status_code == 201, r.text
    assert r.json()["status"] == "active"

    roster = client.get("/admin/users").json()
    assert any(u["email"] == "new@x.io" and u["book_count"] == 0 for u in roster)


def test_revoke(monkeypatch, tmp_path):
    api, client = _client(monkeypatch, tmp_path)
    import mylibrary.db as db
    import mylibrary.invites as invites
    with db.session_scope() as s:
        s.add(db.Invite(email="gone@x.io", invited_by="local", supabase_user_id="sb-9", status="active"))
    monkeypatch.setattr(invites, "delete_user", lambda uid, **kw: None)

    r = client.post("/admin/revoke", json={"supabase_user_id": "sb-9"})
    assert r.status_code == 200
    assert r.json()["status"] == "revoked"


def test_revoke_unknown_user_is_404(monkeypatch, tmp_path):
    api, client = _client(monkeypatch, tmp_path)
    import mylibrary.invites as invites
    monkeypatch.setattr(
        invites, "delete_user",
        lambda uid, **kw: (_ for _ in ()).throw(AssertionError("must not delete unknown user")),
    )

    r = client.post("/admin/revoke", json={"supabase_user_id": "sb-does-not-exist"})
    assert r.status_code == 404
