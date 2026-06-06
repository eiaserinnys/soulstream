"""
Authentication — Bearer 토큰 + JWT 쿠키 이중 인증

soul-server의 Bearer 전용 `verify_token`을 그대로 복제하고,
orch-server 전용으로 Bearer OR JWT 이중 인증 결합 함수 `verify_auth`를 제공한다.

- verify_token: soul-server `soul_server.api.auth.verify_token` L1–L91 복제. import 경로만 변경.
- verify_auth: Bearer 시도 → 실패 시 JWT 쿠키 시도. 둘 다 실패 시 401.
"""

import logging
import secrets
from typing import Optional

from fastapi import Depends, Header, HTTPException, Request

from soulstream_server.config import get_settings
from soulstream_server.dashboard.auth import create_auth_dep

logger = logging.getLogger(__name__)


async def verify_token(authorization: Optional[str] = Header(None)) -> str:
    """
    Bearer 토큰 검증 (soul-server와 동일한 정본 로직).

    Args:
        authorization: Authorization 헤더 값

    Returns:
        검증된 토큰

    Raises:
        HTTPException: 인증 실패
    """
    settings = get_settings()
    configured_token = settings.auth_bearer_token

    # 토큰이 설정되지 않은 경우
    if not configured_token:
        # 프로덕션에서는 토큰 필수
        if settings.is_production:
            logger.error("AUTH_BEARER_TOKEN not configured in production")
            raise HTTPException(
                status_code=500,
                detail={
                    "error": {
                        "code": "CONFIG_ERROR",
                        "message": "Authentication not configured",
                        "details": {},
                    }
                },
            )
        # 개발 모드에서만 우회 허용
        return ""

    if not authorization:
        raise HTTPException(
            status_code=401,
            detail={
                "error": {
                    "code": "UNAUTHORIZED",
                    "message": "Authorization 헤더가 필요합니다",
                    "details": {},
                }
            },
        )

    # Bearer 토큰 파싱
    parts = authorization.split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(
            status_code=401,
            detail={
                "error": {
                    "code": "UNAUTHORIZED",
                    "message": "Bearer 토큰 형식이 올바르지 않습니다",
                    "details": {},
                }
            },
        )

    token = parts[1]

    # 토큰 검증 (타이밍 공격 방지를 위해 상수 시간 비교 사용)
    if not secrets.compare_digest(token, configured_token):
        raise HTTPException(
            status_code=401,
            detail={
                "error": {
                    "code": "UNAUTHORIZED",
                    "message": "유효하지 않은 토큰입니다",
                    "details": {},
                }
            },
        )

    return token


async def verify_auth(
    request: Request,
    authorization: Optional[str] = Header(None),
) -> None:
    """
    Bearer OR JWT 쿠키 이중 인증 결합.

    1) Bearer 시도 (verify_token이 dev mode 바이패스 처리)
    2) Bearer 실패 시 JWT 쿠키 시도 — `auth_enabled=True`일 때만
    3) 둘 다 실패하면 Bearer 쪽 에러를 우선 raise

    F-9 fix(2026-05-08, side-fix): 이전엔 JWT 쿠키 시도를 항상 실행했고,
    `is_auth_enabled=False`이면 `create_auth_dependency`가 `auth_enabled=False`로
    인증을 *무조건 통과*시켜 Bearer 토큰이 설정된 환경에서도 인증이 무력화되는
    회로 결함이 있었다 (Authorization 헤더 없거나 잘못된 토큰이어도 200 응답 →
    test_auth.py의 `test_missing_authorization_header_returns_401` 등 6 케이스 회귀
    fail 잔존). 본 fix는 JWT 경로를 `is_auth_enabled=True`인 환경에서만 실행하고,
    그렇지 않으면 Bearer 경로의 검증 결과를 그대로 따른다 — verify_token 자체에
    이미 dev mode 바이패스(빈 auth_bearer_token + non-production)가 있어 dev 환경
    공통 미설정 케이스도 안전하다.

    create_auth_dep는 매 요청마다 호출하는 클로저 팩토리다
    (soul_common.auth.oauth_routes.create_auth_dependency 참조).
    매번 호출하는 이유:
      (a) settings는 @lru_cache이므로 동일 객체를 재사용 — 실제 비용은 함수 객체 한 개 생성.
      (b) auth_dep를 모듈 스코프 전역으로 캐싱하면 settings mutation(테스트) 시 stale하게 된다.
      (c) verify_auth 자체는 Bearer 성공 시 early return이라 실제 호출 빈도가 낮다.
    """
    settings = get_settings()
    bearer_err: Optional[HTTPException] = None
    cookie_err: Optional[HTTPException] = None

    # 1. Bearer 시도 — verify_token이 빈 토큰 + non-production이면 dev mode 바이패스 처리
    try:
        token = await verify_token(authorization)
        if token:
            request.state.auth_mode = "service_token"
        return
    except HTTPException as e:
        bearer_err = e

    # 2. JWT 쿠키 시도 — `is_auth_enabled=True`인 환경에서만.
    #    `auth_enabled=False`로 호출하면 create_auth_dependency가 무조건 통과시켜
    #    Bearer 검증 결과가 무력화되므로, JWT 미활성 환경에선 본 단계 자체를 건너뛴다.
    if settings.is_auth_enabled:
        try:
            auth_dep = create_auth_dep(settings.jwt_secret, True)
            await auth_dep(request)
            request.state.auth_mode = "jwt"
            return
        except HTTPException as e:
            cookie_err = e

    # 3. 둘 다 실패 → 401 (Bearer err 우선)
    raise bearer_err or cookie_err or HTTPException(
        status_code=401,
        detail={
            "error": {
                "code": "UNAUTHORIZED",
                "message": "인증이 필요합니다",
                "details": {},
            }
        },
    )


__all__ = ["verify_token", "verify_auth"]
