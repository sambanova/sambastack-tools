"""Symmetric encryption for provider API keys (prodplan §3.6).

Keys are encrypted at rest with the app-held ``CREDS_KEY`` (a Fernet key from
the single K8s Secret in prod, or ``.env`` locally) — the samba-chat pattern,
not Cloud KMS. Only ciphertext is ever stored; the plaintext is decrypted at
call time inside the worker.

If ``CREDS_KEY`` is unset we derive a *stable* dev key from the session secret so
local dev works without ceremony. This is gated to the local env — deployed
environments must supply a real ``CREDS_KEY`` (the Makefile mints one).
"""

from __future__ import annotations

import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken

from .config import settings


def _fernet() -> Fernet:
    key = settings.creds_key
    if not key:
        if not settings.is_local:
            raise RuntimeError(
                "CREDS_KEY is required outside local dev (provider-key encryption)."
            )
        # Deterministic dev key derived from the session secret — stable across
        # restarts so previously-encrypted rows stay decryptable locally.
        digest = hashlib.sha256(("dev-creds::" + settings.session_secret).encode()).digest()
        key = base64.urlsafe_b64encode(digest).decode()
    # Accept either a raw urlsafe-base64 32-byte key, or derive one from an
    # arbitrary passphrase for convenience.
    try:
        return Fernet(key)
    except (ValueError, TypeError):
        digest = hashlib.sha256(key.encode()).digest()
        return Fernet(base64.urlsafe_b64encode(digest).decode())


def encrypt(plaintext: str) -> bytes:
    return _fernet().encrypt(plaintext.encode("utf-8"))


def decrypt(ciphertext: bytes) -> str:
    try:
        return _fernet().decrypt(ciphertext).decode("utf-8")
    except InvalidToken as err:
        raise RuntimeError(
            "Failed to decrypt a provider key — CREDS_KEY changed or data corrupt."
        ) from err


def last4(secret: str) -> str:
    s = secret or ""
    return s[-4:] if len(s) >= 4 else s


def new_key() -> str:
    """Generate a fresh Fernet key (used by `make create-secrets`)."""
    return Fernet.generate_key().decode()
