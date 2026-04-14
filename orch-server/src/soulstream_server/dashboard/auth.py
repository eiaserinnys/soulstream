"""
Auth 설정 — soul-common 팩토리를 사용한 OAuth 라우터 및 인증 의존성 생성.
"""

from typing import Any, Callable, Coroutine

from fastapi import APIRouter, Request

from soul_common.auth.oauth_routes import create_auth_dependency, create_oauth_router


def create_auth_router(
    google_client_id: str,
    google_client_secret: str,
    callback_url: str,
    allowed_email: str,
    jwt_secret: str,
    is_development: bool = False,
) -> APIRouter:
    """OAuth 라우터를 생성한다."""
    return create_oauth_router(
        google_client_id=google_client_id,
        google_client_secret=google_client_secret,
        callback_url=callback_url,
        allowed_email=allowed_email,
        jwt_secret=jwt_secret,
        is_development=is_development,
    )


def create_auth_dep(
    jwt_secret: str,
    auth_enabled: bool = True,
) -> Callable[[Request], Coroutine[Any, Any, dict | None]]:
    """FastAPI Depends로 사용할 인증 검증 함수를 반환한다."""
    return create_auth_dependency(
        jwt_secret=jwt_secret,
        auth_enabled=auth_enabled,
    )
