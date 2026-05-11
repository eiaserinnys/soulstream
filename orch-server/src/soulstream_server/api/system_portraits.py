"""System Portraits API 라우터 — /api/system/portraits/{source}

소울스트림 시스템·봇 source(`system` / `channel_observer` / `trello_watcher`)의 정체성
아이콘 정적 호스팅. soul_common 패키지에 번들된 PNG 자산을 `importlib.resources`로 접근.

R-3 (atom G-5, 2026-05-11): `caller_info.avatar_url`을 server-relative URL로 통일하기 위해
신설. agent portrait `/api/nodes/{node}/agents/{id}/portrait`와 §9 대칭으로 `verify_auth`
의존성 포함 (`main.py:_mount_api_routers`에서 `api_deps` 주입).

호출:
- `build_system_caller_info` / `build_bot_caller_info` (soul_common.auth.caller_info)가
  박은 avatar_url을 클라이언트가 직접 사용.
- unified-dashboard: cookie auth 자동 첨부.
- soul-app: `pickUserAvatarUri`가 server-relative URL에 useBearer=True 반환 (userAvatarHelpers.ts:130-136).

정본 자산: `packages/soul-common/src/soul_common/portraits/{source}.png`
"""

import logging
from importlib.resources import files

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

logger = logging.getLogger(__name__)

# 화이트리스트 — 정본 자산이 packages/soul-common/src/soul_common/portraits/에 존재하는 source만 허용.
# 새 source 추가 시 (1) 자산 파일 추가 + (2) 본 화이트리스트 추가 + (3) 빌더(build_bot_caller_info
# 인자) 동시 갱신 — atom N.1 가이드(`1e71e0d8`) 참조.
ALLOWED_SOURCES = frozenset({"system", "channel_observer", "trello_watcher"})


def create_system_portraits_router(dependencies: list | None = None) -> APIRouter:
    """시스템·봇 source 정체성 아이콘 라우터 생성.

    Args:
        dependencies: FastAPI 의존성 목록 (보통 `[Depends(verify_auth)]`).
    """
    router = APIRouter(
        prefix="/api/system/portraits",
        tags=["system-portraits"],
        dependencies=dependencies or [],
    )

    @router.get("/{source}")
    async def get_system_portrait(source: str) -> Response:
        """시스템·봇 source 정체성 아이콘 호스팅.

        화이트리스트 외 source → 404 (정본 자산 없음).
        자산 로드 실패 → 404 (warning log).

        Args:
            source: caller_info.source 값 (system / channel_observer / trello_watcher).

        Returns:
            PNG 이미지 응답 (1시간 캐시).
        """
        if source not in ALLOWED_SOURCES:
            raise HTTPException(
                status_code=404,
                detail=f"Unknown system portrait source: {source}",
            )
        try:
            data = (files("soul_common.portraits") / f"{source}.png").read_bytes()
        except (FileNotFoundError, ModuleNotFoundError) as e:
            logger.warning(
                "system portrait asset missing: source=%s err=%s",
                source, e,
            )
            raise HTTPException(
                status_code=404,
                detail="Portrait asset not found",
            )
        return Response(
            content=data,
            media_type="image/png",
            headers={"Cache-Control": "public, max-age=3600"},
        )

    return router
