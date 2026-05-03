"""push 라우터 단위 테스트.

FastAPI TestClient를 거치는 통합 테스트는 verify_auth + JWT 쿠키 주입
인프라가 필요해 비용이 큼. 라우터 핸들러는 단순 함수이므로 직접 호출하여
auth_user 처리 로직과 repo 호출 정합성만 검증한다.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from soulstream_server.api.push import RegisterRequest, _require_jwt_user, create_push_router


def _make_request(auth_user: dict | None = None):
    """Request mock — request.state.auth_user만 사용하므로 그 부분만 stub."""
    state = SimpleNamespace()
    if auth_user is not None:
        state.auth_user = auth_user
    return SimpleNamespace(state=state)


def test_require_jwt_user_rejects_missing_auth_user():
    """Bearer 정적 토큰 모드(auth_user 없음) → 401."""
    req = _make_request(auth_user=None)
    with pytest.raises(HTTPException) as exc:
        _require_jwt_user(req)
    assert exc.value.status_code == 401


def test_require_jwt_user_rejects_missing_email():
    """auth_user에 email이 없으면 401 (방어적)."""
    req = _make_request(auth_user={"name": "Alice"})
    with pytest.raises(HTTPException) as exc:
        _require_jwt_user(req)
    assert exc.value.status_code == 401


def test_require_jwt_user_returns_user_when_email_present():
    req = _make_request(auth_user={"email": "a@b.com", "name": "A"})
    user = _require_jwt_user(req)
    assert user["email"] == "a@b.com"


@pytest.mark.asyncio
async def test_register_calls_repo_upsert():
    repo = AsyncMock()
    router = create_push_router(repo)
    register_handler = next(
        r.endpoint for r in router.routes if getattr(r, "name", "") == "register"
    )
    req = _make_request(auth_user={"email": "a@b.com"})
    body = RegisterRequest(token="ExponentPushToken[xxx]", deviceId="dev-1")

    result = await register_handler(req, body)

    assert result == {"ok": True}
    repo.upsert_token.assert_awaited_once_with("a@b.com", "dev-1", "ExponentPushToken[xxx]")


@pytest.mark.asyncio
async def test_register_rejects_bearer_only_caller():
    repo = AsyncMock()
    router = create_push_router(repo)
    register_handler = next(
        r.endpoint for r in router.routes if getattr(r, "name", "") == "register"
    )
    req = _make_request(auth_user=None)  # Bearer 토큰만 통과한 상태 시뮬레이션
    body = RegisterRequest(token="t", deviceId="d")

    with pytest.raises(HTTPException) as exc:
        await register_handler(req, body)
    assert exc.value.status_code == 401
    repo.upsert_token.assert_not_awaited()


@pytest.mark.asyncio
async def test_deregister_calls_repo_delete():
    repo = AsyncMock()
    router = create_push_router(repo)
    deregister_handler = next(
        r.endpoint for r in router.routes if getattr(r, "name", "") == "deregister"
    )
    req = _make_request(auth_user={"email": "a@b.com"})

    result = await deregister_handler(req, "dev-1")

    assert result == {"ok": True}
    repo.delete_token.assert_awaited_once_with("a@b.com", "dev-1")
