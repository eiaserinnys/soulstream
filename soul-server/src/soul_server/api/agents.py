"""
Agents API - 에이전트 프로필 목록 조회

GET /api/agents — 등록된 에이전트 목록 반환
degraded mode(AgentRegistry 빈 상태)에서는 빈 목록 반환.
"""

from typing import Optional
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()


class AgentInfo(BaseModel):
    id: str
    name: str
    portrait_url: str
    max_turns: Optional[int]


class AgentsResponse(BaseModel):
    agents: list[AgentInfo]


@router.get("/api/agents", response_model=AgentsResponse)
async def list_agents():
    """등록된 에이전트 목록 반환.
    degraded mode(AgentRegistry 빈 상태)에서는 빈 목록 반환.
    workspace_dir은 보안상 미노출.
    """
    from soul_server.main import get_agent_registry
    registry = get_agent_registry()
    agents = [
        AgentInfo(
            id=p.id,
            name=p.name,
            portrait_url=p.portrait_url,
            max_turns=p.max_turns,
        )
        for p in registry.list()
    ]
    return AgentsResponse(agents=agents)
