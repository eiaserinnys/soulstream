"""
Dashboard 인증 라우트 — soul-common 팩토리를 사용하여 라우터 생성

OAuth 라우트 팩토리는 soul_common.auth.oauth_routes에 위치한다.
soul-server의 Settings에서 설정을 읽어 팩토리를 호출한다.
"""

import logging

from soul_common.auth.oauth_routes import (  # noqa: F401
    create_oauth_router,
    OAUTH_STATE_COOKIE,
    RETURN_TO_COOKIE,
)

logger = logging.getLogger(__name__)


def create_soul_server_auth_router():
    """soul-server Settings를 읽어 OAuth 라우터를 생성한다.

    모듈 임포트 시점이 아닌 호출 시점에 Settings를 로딩하여
    테스트 격리와 환경변수 의존성 문제를 방지한다.
    """
    from soul_server.config import get_settings

    settings = get_settings()
    return create_oauth_router(
        google_client_id=settings.google_client_id or "",
        google_client_secret=settings.google_client_secret or "",
        callback_url=settings.google_callback_url or "/api/auth/google/callback",
        allowed_email=settings.allowed_email or "",
        jwt_secret=settings.jwt_secret or "",
        is_development=settings.is_development,
    )
