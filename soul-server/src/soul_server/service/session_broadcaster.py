"""
SessionBroadcaster - 세션 목록 변경 이벤트 브로드캐스트

대시보드의 세션 목록 SSE 구독을 위한 컴포넌트입니다.
세션 생성/업데이트/삭제 시 모든 클라이언트에게 이벤트를 발행합니다.

BaseSessionBroadcaster(soul-common)를 상속하여 큐 관리 로직을 재사용하며,
soul-server 고유의 emit 메서드만 추가 구현합니다.
"""

import logging
from typing import Optional

from soul_common.broadcaster import BaseSessionBroadcaster

from soul_server.service.agent_registry import AgentRegistry
from soul_server.service.task_models import Task, utc_now

logger = logging.getLogger(__name__)


class SessionBroadcaster(BaseSessionBroadcaster):
    """세션 목록 변경 이벤트 브로드캐스터.

    asyncio.Lock을 사용하는 use_lock=True 모드로 생성된다.
    모듈 레벨 싱글톤으로 관리된다(init_session_broadcaster 참고).
    """

    def __init__(self, agent_registry: AgentRegistry) -> None:
        super().__init__(use_lock=True)
        self._agent_registry = agent_registry

    def _resolve_agent_info(self, task: Task) -> tuple[Optional[str], Optional[str]]:
        """Task의 profile_id로 AgentRegistry를 조회하여 이름과 portrait URL을 반환.

        모델(Task)이 레지스트리를 직접 참조하지 않도록, 이 헬퍼가 중개한다.
        """
        if not task.profile_id:
            return None, None
        try:
            agent = self._agent_registry.get(task.profile_id)
            if agent:
                portrait_url = f"/api/agents/{agent.id}/portrait" if agent.portrait_path else None
                return agent.name, portrait_url
        except Exception:
            pass  # 방어 로직 유지 — registry 조회 실패 시 None 반환
        return None, None

    async def emit_session_created(self, task: Task) -> int:
        """세션 생성 이벤트 발행"""
        agent_name, agent_portrait_url = self._resolve_agent_info(task)
        event = {
            "type": "session_created",
            "session": task.to_session_info(
                agent_name=agent_name,
                agent_portrait_url=agent_portrait_url,
            ),
        }
        return await self.broadcast(event)

    async def emit_session_updated(self, task: Task) -> int:
        """세션 업데이트 이벤트 발행"""
        updated_at = task.completed_at or utc_now()
        event = {
            "type": "session_updated",
            "agent_session_id": task.agent_session_id,
            "status": task.status.value,
            "updated_at": updated_at.isoformat(),
            "last_event_id": task.last_event_id,
            "last_read_event_id": task.last_read_event_id,
        }
        return await self.broadcast(event)

    async def emit_session_message_updated(
        self,
        agent_session_id: str,
        status: str,
        updated_at: str,
        last_message: dict,
        last_event_id: int = 0,
        last_read_event_id: int = 0,
    ) -> int:
        """세션의 last_message 변경 이벤트 발행

        readable event가 발생할 때마다 호출되어 세션 리스트의
        마지막 메시지를 실시간으로 갱신한다.

        Args:
            agent_session_id: 세션 식별자
            status: 현재 세션 상태 (TaskStatus.value)
            updated_at: ISO 8601 타임스탬프 (항상 UTC)
            last_message: {"type": str, "preview": str, "timestamp": str}
            last_event_id: 세션의 최신 이벤트 ID
            last_read_event_id: 세션의 마지막 읽은 이벤트 ID
        """
        event = {
            "type": "session_updated",
            "agent_session_id": agent_session_id,
            "status": status,
            "updated_at": updated_at,
            "last_message": last_message,
            "last_event_id": last_event_id,
            "last_read_event_id": last_read_event_id,
        }
        return await self.broadcast(event)

    # emit_session_deleted, emit_read_position_updated는 BaseSessionBroadcaster에서 상속


# 싱글톤 인스턴스
_session_broadcaster: Optional[SessionBroadcaster] = None


def get_session_broadcaster() -> SessionBroadcaster:
    """SessionBroadcaster 싱글톤 반환

    Raises:
        RuntimeError: init_session_broadcaster()가 호출되지 않은 경우
    """
    if _session_broadcaster is None:
        raise RuntimeError(
            "SessionBroadcaster not initialized. "
            "Call init_session_broadcaster() first."
        )
    return _session_broadcaster


def init_session_broadcaster(agent_registry: AgentRegistry) -> SessionBroadcaster:
    """SessionBroadcaster 초기화"""
    global _session_broadcaster
    _session_broadcaster = SessionBroadcaster(agent_registry=agent_registry)
    return _session_broadcaster


def set_session_broadcaster(broadcaster: Optional[SessionBroadcaster]) -> None:
    """SessionBroadcaster 인스턴스 설정 (테스트용)"""
    global _session_broadcaster
    _session_broadcaster = broadcaster
