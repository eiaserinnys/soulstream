"""PKCE OAuth 웹 세션 관리 (메모리 내 TTL Map)"""
from __future__ import annotations
import time
from dataclasses import dataclass, field

TTL_SECONDS = 300  # 5분


@dataclass
class PkceSession:
    state: str
    verifier: str
    created_at: float
    metadata: dict = field(default_factory=dict)


class WebSessionStore:
    def __init__(self) -> None:
        self._store: dict[str, PkceSession] = {}

    def create(self, state: str, verifier: str, metadata: dict | None = None) -> PkceSession:
        session = PkceSession(
            state=state,
            verifier=verifier,
            created_at=time.time(),
            metadata=metadata or {},
        )
        self._store[state] = session
        self._evict_expired()
        return session

    def pop(self, state: str) -> PkceSession | None:
        session = self._store.pop(state, None)
        if session is None:
            return None
        if time.time() - session.created_at > TTL_SECONDS:
            return None  # 만료
        return session

    def _evict_expired(self) -> None:
        now = time.time()
        expired = [k for k, v in self._store.items() if now - v.created_at > TTL_SECONDS]
        for k in expired:
            del self._store[k]


# 모듈 레벨 싱글턴 — router.py에서 import하여 사용
web_session_store = WebSessionStore()
