"""
Dashboard 인증 의존성

SOUL_DASHBOARD_AUTH_ENABLED=true일 때만 인증 검사를 수행합니다.
향후 OAuth 추가를 위한 자리만 마련하며, 현재는 auth_enabled=false 시 통과합니다.

설계 원칙: 코드에 기본값을 하드코딩하지 않습니다.
SOUL_DASHBOARD_AUTH_ENABLED가 .env에 없으면 KeyError → 시작 시 명시적 실패.

lru_cache로 지연 평가: 모듈 임포트 시점(load_dotenv 이전)이 아닌,
첫 요청 시점(load_dotenv 완료 후)에 한 번만 환경변수를 읽습니다.
"""

import functools
import os

from fastapi import HTTPException, Request


@functools.lru_cache(maxsize=1)
def _is_auth_enabled() -> bool:
    """첫 호출 시 환경변수를 읽고 결과를 캐시합니다.

    키가 없으면 KeyError → 명시적 실패.
    """
    return os.environ["SOUL_DASHBOARD_AUTH_ENABLED"].lower() == "true"


async def require_dashboard_auth(request: Request):
    """_is_auth_enabled()=True가 아니면 인증 없이 통과."""
    if not _is_auth_enabled():
        return None  # 인증 비활성화 → 통과
    # TODO: JWT 쿠키/Bearer 검증 (OAuth 설정 시 구현)
    raise HTTPException(status_code=401, detail="Authentication required")
