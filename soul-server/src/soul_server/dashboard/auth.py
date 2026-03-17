"""
Dashboard 인증 — Google OAuth JWT 쿠키 기반

GOOGLE_CLIENT_ID가 설정되어 있으면 인증 활성, 미설정이면 바이패스.
JWT는 httpOnly 쿠키(soul_dashboard_auth)로 전달되며,
Authorization Bearer 헤더도 폴백으로 지원한다.
"""

from datetime import datetime, timedelta, timezone
from typing import Optional

import jwt
from fastapi import HTTPException, Request

from soul_server.config import get_settings

# 쿠키 이름 (프론트엔드와 일치)
COOKIE_NAME = "soul_dashboard_auth"

# JWT 설정
JWT_ALGORITHM = "HS256"
JWT_EXPIRES_DAYS = 7


def generate_token(user: dict, secret: str, expires_days: int = JWT_EXPIRES_DAYS) -> str:
    """사용자 정보로 JWT를 생성한다.

    Args:
        user: email, name, picture 키를 포함하는 dict
        secret: JWT 서명 키
        expires_days: 만료 기간 (일)

    Returns:
        JWT 문자열
    """
    payload = {
        "sub": user["email"],
        "email": user["email"],
        "name": user.get("name", ""),
        "picture": user.get("picture", ""),
        "exp": datetime.now(timezone.utc) + timedelta(days=expires_days),
    }
    return jwt.encode(payload, secret, algorithm=JWT_ALGORITHM)


def verify_token(token: str, secret: str) -> Optional[dict]:
    """JWT를 검증하고 페이로드를 반환한다.

    Args:
        token: JWT 문자열
        secret: JWT 서명 키

    Returns:
        검증 성공 시 페이로드 dict, 실패 시 None
    """
    try:
        return jwt.decode(token, secret, algorithms=[JWT_ALGORITHM])
    except jwt.PyJWTError:
        return None


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
