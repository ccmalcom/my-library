"""Per-user Anthropic key storage: encrypt-at-rest, env fallback, status, clear."""

from __future__ import annotations

import base64
import os

import pytest

from mylibrary.db import UserSettings, session_scope
from mylibrary.user_settings import (
    anthropic_key_status,
    clear_anthropic_key,
    resolve_anthropic_key,
    set_anthropic_key,
)


def _set_encryption_key(monkeypatch):
    monkeypatch.setenv("ENCRYPTION_KEY", base64.b64encode(os.urandom(32)).decode())


def test_set_resolve_roundtrip_is_encrypted_at_rest(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)  # isolate from any .env fallback
    _set_encryption_key(monkeypatch)

    assert anthropic_key_status()["configured"] is False

    set_anthropic_key("sk-ant-secret-123")

    # Stored value is ciphertext, not the plaintext key.
    with session_scope() as s:
        row = s.query(UserSettings).one()
        assert row.anthropic_api_key_encrypted
        assert "sk-ant-secret-123" not in row.anthropic_api_key_encrypted

    assert resolve_anthropic_key() == "sk-ant-secret-123"
    assert anthropic_key_status()["configured"] is True


def test_clear_reverts_to_unconfigured(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    _set_encryption_key(monkeypatch)

    set_anthropic_key("sk-ant-secret-123")
    clear_anthropic_key()
    assert resolve_anthropic_key() is None
    assert anthropic_key_status()["configured"] is False


def test_resolve_falls_back_to_env_when_no_stored_key(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "env-fallback-key")
    # No stored key → env fallback (keeps the CLI / local mode working).
    assert resolve_anthropic_key() == "env-fallback-key"


def test_stored_key_wins_over_env(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "env-fallback-key")
    _set_encryption_key(monkeypatch)
    set_anthropic_key("sk-ant-stored")
    assert resolve_anthropic_key() == "sk-ant-stored"


def test_empty_key_rejected(monkeypatch):
    _set_encryption_key(monkeypatch)
    with pytest.raises(ValueError):
        set_anthropic_key("   ")
