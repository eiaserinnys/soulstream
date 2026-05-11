"""System Portraits API 라우터 — /api/system/portraits/{source}

소울스트림 시스템·봇 source(`system` / `channel_observer` / `trello_watcher`)의 정체성
아이콘 정적 호스팅. soul_common 패키지에 번들된 PNG 자산을 `importlib.resources`로 접근.

R-3 (atom G-5, 2026-05-11): `caller_info.avatar_url`을 server-relative URL로 통일하기 위해
신설. agent portrait `/api/nodes/{node}/agents/{id}/portrait`와 §9 대칭으로 `verify_auth`
의존성 포함 (`main.py:_mount_api_routers`에서 `api_deps` 주입).

R-4 (atom G-11, 2026-05-11): 봇별 다른 PNG 사본 패턴 → 단일 정본 파일 + `_PORTRAIT_FILE_MAP`
source → 파일명 매핑. 현재 3 source 모두 동일 자산(`system.png`, soul-app `assets/icon.png`
md5 정합). 디자이너 봇별 다른 자산 결정 시 본 매핑만 갱신 (design-principles §3 정본 하나
+ §9 일관성, §10 확장 용이).

호출:
- `build_system_caller_info` / `build_bot_caller_info` (soul_common.auth.caller_info)가
  박은 avatar_url을 클라이언트가 직접 사용.
- unified-dashboard: cookie auth 자동 첨부.
- soul-app: `pickUserAvatarUri`가 server-relative URL에 useBearer=True 반환 (userAvatarHelpers.ts:130-136).

정본 자산: `packages/soul-common/src/soul_common/portraits/system.png` (R-4 단일 파일)
"""

import logging
from importlib.resources import files

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

logger = logging.getLogger(__name__)

# 화이트리스트 — 정본 자산이 _PORTRAIT_FILE_MAP에 등록된 source만 허용.
# 새 source 추가 시 (1) _PORTRAIT_FILE_MAP에 source → 파일명 매핑 + (2) 본 화이트리스트 추가
# (3) 빌더(build_bot_caller_info 인자) 동시 갱신 — atom N.1 가이드(`1e71e0d8`) 참조.
ALLOWED_SOURCES = frozenset({"system", "channel_observer", "trello_watcher"})

# R-4 (atom G-11, 2026-05-11): source → 정본 파일명 매핑. 현재 3 source 모두 동일 자산
# (`system.png`, soul-app icon.png md5 정합 — `cd4da98f94571d857faff2bf18a78353`). 봇별 다른
# 자산 디자인 결정 시 본 매핑만 갱신 — design-principles §3 정본 하나 + §10 확장 용이.
_PORTRAIT_FILE_MAP: dict[str, str] = {
    "system": "system.png",
    "channel_observer": "system.png",
    "trello_watcher": "system.png",
}


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
        filename = _PORTRAIT_FILE_MAP[source]
        try:
            data = (files("soul_common.portraits") / filename).read_bytes()
        except (FileNotFoundError, ModuleNotFoundError) as e:
            logger.warning(
                "system portrait asset missing: source=%s file=%s err=%s",
                source, filename, e,
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
