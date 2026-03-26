"""
Dashboard profile API - 대시보드 프로필 설정 및 초상화 서빙

대시보드 채팅창에서 사용자/어시스턴트의 이름과 프로필 이미지를 표시하기 위한 API.
초상화 이미지는 soul-server가 파일시스템에서 읽어 리사이즈 후 HTTP로 서빙한다.
(대시보드 서버가 파일을 직접 읽지 않도록 하기 위함)
"""

from fastapi import APIRouter
from fastapi.responses import JSONResponse, Response

from ..config import get_settings
from .portrait_utils import get_cached_portrait

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("/config")
async def get_dashboard_config():
    """대시보드 프로필 설정 반환.

    user: 환경변수 기반 (DASH_USER_*).
    agents: AgentRegistry 기반 — 에이전트 목록과 portrait 서빙 URL.
    """
    settings = get_settings()

    from soul_server.main import get_agent_registry
    registry = get_agent_registry()
    agents = [
        {
            "id": p.id,
            "name": p.name,
            "hasPortrait": bool(p.portrait_path),
            "portraitUrl": f"/api/agents/{p.id}/portrait" if p.portrait_path else None,
        }
        for p in registry.list()
    ]

    return JSONResponse({
        "user": {
            "name": settings.dash_user_name,
            "id": settings.dash_user_id,
            "hasPortrait": bool(settings.dash_user_portrait),
        },
        "agents": agents,
    })


@router.get("/portrait/{role}")
async def get_portrait(role: str):
    """프로필 초상화 이미지 서빙 (64x64 PNG).

    user role만 지원. assistant portrait은 /api/agents/{agent_id}/portrait로 이동.
    """
    if role != "user":
        return Response(status_code=404)

    settings = get_settings()
    path_str = settings.dash_user_portrait

    if not path_str:
        return Response(status_code=404)

    cache_key = f"user:{path_str}"
    data = get_cached_portrait(cache_key, path_str)
    if data is None:
        return Response(status_code=404)

    return Response(
        content=data,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=3600"},
    )
