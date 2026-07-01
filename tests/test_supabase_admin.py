import httpx
import pytest

import importlib
import mylibrary.config as config
import mylibrary.supabase_admin as sa_admin


def _configure(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://proj.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service-role-xyz")
    importlib.reload(config)
    importlib.reload(sa_admin)


def _client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_invite_user_posts_to_gotrue(monkeypatch):
    _configure(monkeypatch)
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("authorization")
        seen["apikey"] = request.headers.get("apikey")
        return httpx.Response(200, json={"id": "uuid-1", "email": "new@x.io"})

    out = sa_admin.invite_user("new@x.io", client=_client(handler))
    assert out == {"id": "uuid-1", "email": "new@x.io"}
    assert seen["url"] == "https://proj.supabase.co/auth/v1/invite"
    assert seen["auth"] == "Bearer service-role-xyz"
    assert seen["apikey"] == "service-role-xyz"


def test_delete_user_calls_admin_endpoint(monkeypatch):
    _configure(monkeypatch)
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["method"] = request.method
        seen["url"] = str(request.url)
        return httpx.Response(200, json={})

    sa_admin.delete_user("uuid-1", client=_client(handler))
    assert seen["method"] == "DELETE"
    assert seen["url"] == "https://proj.supabase.co/auth/v1/admin/users/uuid-1"


def test_missing_config_raises(monkeypatch):
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    monkeypatch.setenv("SUPABASE_URL", "https://proj.supabase.co")
    importlib.reload(config); importlib.reload(sa_admin)
    with pytest.raises(sa_admin.SupabaseAdminError):
        sa_admin.invite_user("x@x.io")


def test_non_2xx_raises(monkeypatch):
    _configure(monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(422, json={"msg": "already registered"})

    with pytest.raises(sa_admin.SupabaseAdminError):
        sa_admin.invite_user("dupe@x.io", client=_client(handler))
