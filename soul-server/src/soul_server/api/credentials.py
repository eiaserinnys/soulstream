"""
Credentials API - 프로필 관리 REST 엔드포인트

프로필 목록 조회, 활성 프로필 확인, 저장/활성화/삭제.
모든 엔드포인트는 Bearer 토큰 인증이 필요합니다.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException

from soul_server.api.auth import verify_token
from soul_server.service.credential_store import CredentialStore
from soul_server.service.credential_swapper import CredentialSwapper
from soul_server.service.rate_limit_tracker import RateLimitTracker

logger = logging.getLogger(__name__)


def create_credentials_router(
    store: CredentialStore,
    swapper: CredentialSwapper,
    rate_limit_tracker: RateLimitTracker | None = None,
) -> APIRouter:
    """
    Credentials API 라우터 팩토리.

    Args:
        store: 프로필 저장소
        swapper: 크레덴셜 교체기
        rate_limit_tracker: rate limit 추적기 (없으면 rate-limits 엔드포인트 비활성)

    Returns:
        FastAPI APIRouter
    """
    router = APIRouter()

    # --- Static paths (parameterized paths보다 먼저 등록) ---

    @router.get("")
    async def list_profiles(_: str = Depends(verify_token)):
        """
        GET /profiles — 프로필 목록 + 메타데이터
        """
        profiles = store.list_profiles()
        active = store.get_active()
        return {"profiles": profiles, "active": active}

    @router.get("/active")
    async def get_active_profile(_: str = Depends(verify_token)):
        """
        GET /profiles/active — 현재 활성 프로필 정보
        """
        active = store.get_active()
        if active is None:
            return {"active": None, "profile": None}

        profiles = store.list_profiles()
        profile_meta = next(
            (p for p in profiles if p["name"] == active), None
        )
        return {"active": active, "profile": profile_meta}

    @router.get("/rate-limits")
    async def get_all_rate_limits(_: str = Depends(verify_token)):
        """
        GET /profiles/rate-limits — 전체 프로필의 rate limit 현황
        """
        if rate_limit_tracker is None:
            raise HTTPException(
                status_code=503, detail="Rate limit tracking이 활성화되지 않았습니다."
            )

        active = store.get_active()
        statuses = rate_limit_tracker.get_all_profiles_status()
        return {
            "active_profile": active,
            "profiles": statuses,
        }

    # --- Parameterized paths ---

    @router.post("/{name}")
    async def save_profile(name: str, _: str = Depends(verify_token)):
        """
        POST /profiles/{name} — 현재 크레덴셜을 프로필로 저장
        """
        try:
            swapper.save_current_as(name)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        except FileNotFoundError as e:
            raise HTTPException(status_code=500, detail=str(e))

        return {"name": name, "saved": True}

    @router.post("/{name}/activate")
    async def activate_profile(name: str, _: str = Depends(verify_token)):
        """
        POST /profiles/{name}/activate — 프로필 활성화 (크레덴셜 교체)
        """
        try:
            swapper.activate(name)
        except FileNotFoundError as e:
            raise HTTPException(status_code=404, detail=str(e))
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        except OSError as e:
            logger.error(f"크레덴셜 교체 실패: {e}")
            raise HTTPException(
                status_code=500, detail="크레덴셜 파일 교체 중 오류 발생"
            )

        return {"activated": name}

    @router.get("/{name}/rate-limits")
    async def get_profile_rate_limits(name: str, _: str = Depends(verify_token)):
        """
        GET /profiles/{name}/rate-limits — 특정 프로필의 rate limit 현황
        """
        if rate_limit_tracker is None:
            raise HTTPException(
                status_code=503, detail="Rate limit tracking이 활성화되지 않았습니다."
            )

        status = rate_limit_tracker.get_profile_status(name)
        return {"name": name, **status}

    @router.delete("/{name}")
    async def delete_profile(name: str, _: str = Depends(verify_token)):
        """
        DELETE /profiles/{name} — 프로필 삭제
        """
        try:
            deleted = store.delete(name)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

        if not deleted:
            raise HTTPException(
                status_code=404,
                detail=f"프로필이 존재하지 않습니다: {name}",
            )
        return {"deleted": True, "name": name}

    return router
