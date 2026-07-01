import importlib

import pytest


def _fresh(monkeypatch, tmp_path):
    monkeypatch.setenv("MYLIBRARY_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("DATABASE_URL", raising=False)
    import mylibrary.config as config, mylibrary.db as db
    importlib.reload(config); importlib.reload(db)
    db.init_db()
    return db


def test_create_invite_records_active_row(monkeypatch, tmp_path):
    db = _fresh(monkeypatch, tmp_path)
    import mylibrary.invites as invites, mylibrary.supabase_admin as sa_admin
    importlib.reload(invites)
    monkeypatch.setattr(sa_admin, "invite_user", lambda email, **kw: {"id": "sb-1", "email": email})
    monkeypatch.setattr(invites, "invite_user", sa_admin.invite_user, raising=False)

    out = invites.create_invite("new@x.io", invited_by="admin-1")
    assert out["email"] == "new@x.io"
    assert out["supabase_user_id"] == "sb-1"
    assert out["status"] == "active"
    with db.session_scope() as s:
        row = s.query(db.Invite).filter(db.Invite.email == "new@x.io").one()
        assert row.status == "active"
        assert row.supabase_user_id == "sb-1"


def test_revoke_user_deletes_and_purges(monkeypatch, tmp_path):
    db = _fresh(monkeypatch, tmp_path)
    import mylibrary.invites as invites, mylibrary.supabase_admin as sa_admin
    importlib.reload(invites)
    # Seed an active invite + a book owned by that supabase user.
    with db.session_scope() as s:
        s.add(db.Invite(email="gone@x.io", invited_by="admin-1", supabase_user_id="sb-9", status="active"))
        s.add(db.Book(user_id="sb-9", title="Doomed", goodreads_rating=5))

    deleted = {}
    monkeypatch.setattr(invites, "delete_user", lambda uid, **kw: deleted.setdefault("uid", uid))
    out = invites.revoke_user(supabase_user_id="sb-9")

    assert out["status"] == "revoked"
    assert deleted["uid"] == "sb-9"
    with db.session_scope() as s:
        assert s.query(db.Book).filter(db.Book.user_id == "sb-9").count() == 0  # purged
        row = s.query(db.Invite).filter(db.Invite.supabase_user_id == "sb-9").one()
        assert row.status == "revoked"
        assert row.revoked_at is not None


def test_revoke_user_marks_revoked_even_if_purge_fails(monkeypatch, tmp_path):
    db = _fresh(monkeypatch, tmp_path)
    import mylibrary.invites as invites, mylibrary.supabase_admin as sa_admin
    importlib.reload(invites)
    # Seed an active invite owned by the supabase user being revoked.
    with db.session_scope() as s:
        s.add(db.Invite(email="oops@x.io", invited_by="admin-1", supabase_user_id="sb-7", status="active"))

    monkeypatch.setattr(invites, "delete_user", lambda uid, **kw: None)

    def _boom(*, user_id):
        raise RuntimeError("purge failed")

    monkeypatch.setattr(invites, "delete_account", _boom)

    with pytest.raises(RuntimeError):
        invites.revoke_user(supabase_user_id="sb-7")

    # Even though delete_account raised, the Supabase account is already gone,
    # so the Invite row must already be marked revoked (a retry must not re-call delete_user).
    with db.session_scope() as s:
        row = s.query(db.Invite).filter(db.Invite.supabase_user_id == "sb-7").one()
        assert row.status == "revoked"
        assert row.revoked_at is not None


def test_revoke_user_retry_on_already_revoked_skips_delete_user(monkeypatch, tmp_path):
    db = _fresh(monkeypatch, tmp_path)
    import mylibrary.invites as invites, mylibrary.supabase_admin as sa_admin
    importlib.reload(invites)
    # Seed an invite row that is ALREADY revoked (simulating a prior call that
    # deleted the Supabase user but then failed during delete_account).
    with db.session_scope() as s:
        s.add(
            db.Invite(
                email="retry@x.io",
                invited_by="admin-1",
                supabase_user_id="sb-5",
                status="revoked",
            )
        )

    def _fail_if_called(uid, **kw):
        pytest.fail("delete_user must not be called when the invite is already revoked")

    monkeypatch.setattr(invites, "delete_user", _fail_if_called)

    purge_calls = []
    monkeypatch.setattr(
        invites, "delete_account", lambda *, user_id: purge_calls.append(user_id)
    )

    out = invites.revoke_user(supabase_user_id="sb-5")

    assert out == {"supabase_user_id": "sb-5", "status": "revoked"}
    assert purge_calls == ["sb-5"]
