"""soul_common.auth: JWT 인증 + OAuth 라우트 팩토리"""

from soul_common.auth.jwt import (
    COOKIE_NAME,
    JWT_ALGORITHM,
    JWT_EXPIRES_DAYS,
    generate_token,
    verify_token,
)
from soul_common.auth.oauth_routes import create_oauth_router, create_auth_dependency
from soul_common.auth.caller_info import (
    IDENTITY_BEARING_SOURCES,
    build_agent_caller_info,
    build_bot_caller_info,
    build_browser_caller_info,
    build_system_caller_info,
    decode_dashboard_jwt_user,
    extract_caller_info_from_metadata,
)

__all__ = [
    "COOKIE_NAME",
    "JWT_ALGORITHM",
    "JWT_EXPIRES_DAYS",
    "generate_token",
    "verify_token",
    "create_oauth_router",
    "create_auth_dependency",
    "IDENTITY_BEARING_SOURCES",
    "build_agent_caller_info",
    "build_bot_caller_info",
    "build_browser_caller_info",
    "build_system_caller_info",
    "decode_dashboard_jwt_user",
    "extract_caller_info_from_metadata",
]
