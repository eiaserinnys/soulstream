"""PKCE (Proof Key for Code Exchange) 유틸리티"""
from __future__ import annotations
import hashlib
import os
import base64


def generate_verifier() -> str:
    """code_verifier: 43-128자 base64url 랜덤"""
    raw = os.urandom(32)
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def generate_challenge(verifier: str) -> str:
    """code_challenge: SHA256(verifier) → base64url (S256 method)"""
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def generate_state() -> str:
    """state: 32바이트 base64url 랜덤"""
    raw = os.urandom(32)
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")
