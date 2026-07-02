import importlib

import mylibrary.config as config


def _fresh_settings(monkeypatch, **env):
    for k, v in env.items():
        if v is None:
            monkeypatch.delenv(k, raising=False)
        else:
            monkeypatch.setenv(k, v)
    importlib.reload(config)
    return config.get_settings()


def test_admin_emails_parsed_and_lowercased(monkeypatch):
    s = _fresh_settings(monkeypatch, ADMIN_EMAILS="Chase@Example.com, two@x.io")
    assert s.admin_emails == ("chase@example.com", "two@x.io")
    assert s.is_admin_email("chase@example.com") is True
    assert s.is_admin_email("CHASE@example.com") is True
    assert s.is_admin_email("nope@x.io") is False
    assert s.is_admin_email(None) is False


def test_admin_emails_unset_is_empty(monkeypatch):
    s = _fresh_settings(monkeypatch, ADMIN_EMAILS=None, SUPABASE_SERVICE_ROLE_KEY=None)
    assert s.admin_emails == ()
    assert s.supabase_service_role_key is None
    assert s.is_admin_email("anyone@x.io") is False
