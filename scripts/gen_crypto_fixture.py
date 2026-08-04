"""Generate the cross-language crypto fixture consumed by frontend crypto tests.

Encrypts a known plaintext with a FIXED test key (bytes 0..31) using the real
mylibrary.crypto implementation, so the Node decrypt path is proven against
Python-produced ciphertext. The key is a test constant, not a secret.
"""
import base64
import json
import os
import pathlib

os.environ["ENCRYPTION_KEY"] = base64.b64encode(bytes(range(32))).decode()

from mylibrary.crypto import decrypt, encrypt  # noqa: E402 — env must be set first

PLAINTEXT = "sk-ant-test-0123456789-fixture"
token = encrypt(PLAINTEXT)
assert decrypt(token) == PLAINTEXT

out = pathlib.Path("frontend/lib/server/__tests__/fixtures/crypto.json")
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(
    json.dumps(
        {
            "key_b64": os.environ["ENCRYPTION_KEY"],
            "plaintext": PLAINTEXT,
            "token": token,
        },
        indent=2,
    )
    + "\n"
)
print(f"wrote {out}")
