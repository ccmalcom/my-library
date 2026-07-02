from mylibrary.db import Invite, init_db, session_scope, utcnow


def test_invite_row_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setenv("MYLIBRARY_DATA_DIR", str(tmp_path))
    import mylibrary.config as config, mylibrary.db as db, importlib
    importlib.reload(config); importlib.reload(db)
    db.init_db()
    with db.session_scope() as s:
        s.add(db.Invite(email="new@x.io", invited_by="admin-1", status="pending"))
    with db.session_scope() as s:
        row = s.query(db.Invite).filter(db.Invite.email == "new@x.io").one()
        assert row.status == "pending"
        assert row.supabase_user_id is None
        assert row.created_at is not None
