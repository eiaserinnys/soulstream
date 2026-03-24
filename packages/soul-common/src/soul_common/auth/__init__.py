"""soul_common.auth: JWT 인증 + OAuth 라우트 팩토리"""

from soul_common.auth.jwt import (
    COOKIE_NAME,
    JWT_ALGORITHM,
    JWT_EXPIRES_DAYS,
    generate_token,
    verify_token,
)
from soul_common.auth.oauth_routes import create_oauth_router, create_auth_dependency

__all__ = [
    "COOKIE_NAME",
    "JWT_ALGORITHM",
    "JWT_EXPIRES_DAYS",
    "generate_token",
    "verify_token",
    "create_oauth_router",
    "create_auth_dependency",
]
