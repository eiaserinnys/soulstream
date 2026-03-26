"""
Agents API - 에이전트 프로필 목록 조회 및 portrait 서빙

GET /api/agents — 등록된 에이전트 목록 반환
GET /api/agents/{agent_id}/portrait — 에이전트 portrait 이미지 서빙
degraded mode(AgentRegistry 빈 상태)에서는 빈 목록 반환.
"""

from typing import Optional
from fastapi import APIRouter
from fastapi.responses import Response
from pydantic import BaseModel

from .portrait_utils import get_cached_portrait

router = APIRouter()


class AgentInfo(BaseModel):
    id: str
    name: str
    portrait_url: str  # 서빙 URL (/api/agents/{id}/portrait) 또는 빈 문자열
    max_turns: Optional[int]


class AgentsResponse(BaseModel):
    agents: list[AgentInfo]


@router.get("/api/agents", response_model=AgentsResponse)
async def list_agents():
    """등록된 에이전트 목록 반환.
    degraded mode(AgentRegistry 빈 상태)에서는 빈 목록 반환.
    workspace_dir은 보안상 미노출.
    portrait_url은 portrait_path에서 서빙 URL로 변환하여 반환.
    """
    from soul_server.main import get_agent_registry
    registry = get_agent_registry()
    agents = [
        AgentInfo(
            id=p.id,
            name=p.name,
            portrait_url=f"/api/agents/{p.id}/portrait" if p.portrait_path else "",
            max_turns=p.max_turns,
        )
        for p in registry.list()
    ]
    return AgentsResponse(agents=agents)


@router.get("/api/agents/{agent_id}/portrait")
async def get_agent_portrait(agent_id: str):
    """에이전트 portrait 이미지 서빙 (64x64 PNG).

    AgentRegistry에서 agent_id로 프로필을 조회하고,
    portrait_path에서 이미지를 로드하여 리사이즈 후 반환한다.
    """
    from soul_server.main import get_agent_registry
    registry = get_agent_registry()
    profile = registry.get(agent_id)
    if not profile or not profile.portrait_path:
        return Response(status_code=404)

    cache_key = f"agent:{agent_id}:{profile.portrait_path}"
    data = get_cached_portrait(cache_key, profile.portrait_path)
    if data is None:
        return Response(status_code=404)

    return Response(
        content=data,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=3600"},
    )
