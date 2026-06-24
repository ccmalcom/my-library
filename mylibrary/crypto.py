"""Crypto — AES-256-GCM encryption for per-user Anthropic API keys at rest.

Web-distribution scaffold (Phase 3). Users paste their Anthropic key into settings; it is
encrypted here before it touches the DB and decrypted only server-side at Claude-call time.
It is never returned to the frontend.

Key management: `ENCRYPTION_KEY` is a base64-encoded 32-byte key supplied via the deployment
environment (never committed). Generate one with:

    python -c "import os,base64; print(base64.b64encode(os.urandom(32)).decode())"

The stored ciphertext is `base64(nonce[12] || ciphertext || tag)` so a single string round-trips.

NOT YET WIRED: no `user_settings` table and no settings endpoints exist yet — those land with
Phase 3. This module just provides the primitives so the endpoint code is trivial later.
"""

from __future__ import annotations

import base64
import os

from .config import get_settings

_NONCE_BYTES = 12  # standard GCM nonce size


def _load_key() -> bytes:
    settings = get_settings()
    if not settings.encryption_key:
        raise RuntimeError(
            "ENCRYPTION_KEY is not set — required to encrypt/decrypt user API keys"
        )
    key = base64.b64decode(settings.encryption_key)
    if len(key) != 32:
        raise RuntimeError("ENCRYPTION_KEY must decode to exactly 32 bytes (AES-256)")
    return key


def encrypt(plaintext: str) -> str:
    """Encrypt a secret; returns a base64 string safe to store in a TEXT column."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    nonce = os.urandom(_NONCE_BYTES)
    ct = AESGCM(_load_key()).encrypt(nonce, plaintext.encode(), None)
    return base64.b64encode(nonce + ct).decode()


def decrypt(token: str) -> str:
    """Inverse of `encrypt`. Raises on tampering or wrong key."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    blob = base64.b64decode(token)
    nonce, ct = blob[:_NONCE_BYTES], blob[_NONCE_BYTES:]
    return AESGCM(_load_key()).decrypt(nonce, ct, None).decode()
