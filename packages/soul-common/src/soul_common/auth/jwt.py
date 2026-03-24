"""
JWT 토큰 생성/검증

Google OAuth JWT 쿠키 인증의 핵심 유틸리티.
"""

from datetime import datetime, timedelta, timezone
from typing import Optional

import jwt as pyjwt

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
    return pyjwt.encode(payload, secret, algorithm=JWT_ALGORITHM)


def verify_token(token: str, secret: str) -> Optional[dict]:
    """JWT를 검증하고 페이로드를 반환한다.

    Args:
        token: JWT 문자열
        secret: JWT 서명 키

    Returns:
        검증 성공 시 페이로드 dict, 실패 시 None
    """
    try:
        return pyjwt.decode(token, secret, algorithms=[JWT_ALGORITHM])
    except pyjwt.PyJWTError:
        return None
