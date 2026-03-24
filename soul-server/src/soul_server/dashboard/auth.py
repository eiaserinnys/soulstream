"""
Dashboard 인증 — soul-common re-export 래퍼

JWT 유틸(generate_token, verify_token)은 soul_common.auth.jwt에 위치한다.
require_dashboard_auth는 soul-server의 Settings에 의존하므로 여기에 유지한다.
"""

from typing import Optional

from fastapi import HTTPException, Request

# soul-common re-export
from soul_common.auth.jwt import (  # noqa: F401
    COOKIE_NAME,
    JWT_ALGORITHM,
    JWT_EXPIRES_DAYS,
    generate_token,
    verify_token,
)

from soul_server.config import get_settings


async def require_dashboard_auth(request: Request) -> Optional[dict]:
    """FastAPI 의존성: 인증이 활성화되어 있으면 JWT를 검증한다.

    인증 비활성 시 None을 반환하여 통과.
    인증 활성 시 쿠키 또는 Bearer 헤더에서 JWT를 추출하여 검증.
    """
    settings = get_settings()
    if not settings.is_auth_enabled:
        return None  # 바이패스

    # 1. 쿠키에서 JWT 추출
    token = request.cookies.get(COOKIE_NAME)
    # 2. 없으면 Authorization Bearer 헤더 폴백
    if not token:
        auth_header = request.headers.get("authorization", "")
        if auth_header.startswith("Bearer "):
            token = auth_header[7:]

    if not token:
        raise HTTPException(status_code=401, detail="Authentication required")

    payload = verify_token(token, settings.jwt_secret)
    if not payload:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    request.state.auth_user = payload
    return payload
