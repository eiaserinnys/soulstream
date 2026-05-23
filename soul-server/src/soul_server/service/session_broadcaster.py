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

    def _resolve_agent_info(
        self, task: Task
    ) -> tuple[Optional[str], Optional[str], Optional[str]]:
        """Task의 profile_id로 AgentRegistry를 조회하여 (이름, portrait URL, backend) 반환.

        모델(Task)이 레지스트리를 직접 참조하지 않도록, 이 헬퍼가 중개한다.
        옵션 D Phase A: backend(3번째 원소) 추가 — emit_session_created가 wire에 운반.
        """
        if not task.profile_id:
            return None, None, None
        try:
            agent = self._agent_registry.get(task.profile_id)
            if agent:
                portrait_url = f"/api/agents/{agent.id}/portrait" if agent.portrait_path else None
                return agent.name, portrait_url, agent.backend
        except Exception:
            pass  # 방어 로직 유지 — registry 조회 실패 시 None 반환
        return None, None, None

    async def emit_session_created(self, task: Task, folder_id: str | None = None) -> int:
        """세션 생성 이벤트 발행

        Args:
            task: 생성된 세션 태스크
            folder_id: 배정된 폴더 ID. None이면 미분류 세션.
        """
        agent_name, agent_portrait_url, agent_backend = self._resolve_agent_info(task)
        # R-2 fix(2026-05-10): emit_session_updated/phase와 §9 대칭 — top-level
        # caller_source를 wire에 박는다. orch `_on_node_change`가 이 키를 읽어
        # `apply_user_profile_enrichment`에 forward하여 agent/system 등 정체성
        # 명시 source 세션이 dashboard owner로 덮이지 않게 한다 (atom 0499ee7b).
        # wire 키 정본: atom b558ca3b.
        # 옵션 D Phase A: agent_backend를 to_session_info로 운반 (session 객체 안에 backend 키).
        # emit_session_updated/phase/message_updated는 G-19 contract 보존 — 변경 없음.
        session_info = task.to_session_info(
            agent_name=agent_name,
            agent_portrait_url=agent_portrait_url,
            agent_backend=agent_backend,
        )
        session_info["folder_id"] = folder_id
        session_info["folderId"] = folder_id
        event = {
            "type": "session_created",
            "session": session_info,
            "folder_id": folder_id,
            "folderId": folder_id,
            "caller_source": (task.caller_info or {}).get("source"),
        }
        return await self.broadcast(event)

    async def emit_session_updated(self, task: Task) -> int:
        """세션 업데이트 이벤트 발행.

        push 본문 정본은 last_assistant_text (text_delta가 누적해서 마지막에
        block.text 전체로 남는 어시스턴트 응답). last_progress_text는 진행 안내
        ("도구 실행 중...")라 본문에 부적합 — fallback으로만 둔다.
        task가 COMPLETED/ERROR로 전환되는 시점이 push 발사 트리거이므로
        이 시점의 last_assistant_text가 가장 의미 있는 본문이다.
        """
        updated_at = task.completed_at or utc_now()
        # F-10C fix(2026-05-08): caller_info에서 user 프로필 추출하여 wire에 운반.
        # catalog API는 박지만 SSE session_updated에는 누락되었던 결함 차단 (결함 A 본질).
        # 클라이언트(soul-ui buildSessionUpdates)가 동일 키로 수신하여 store에 머지.
        caller_info_dict = task.caller_info or {}
        event = {
            "type": "session_updated",
            "agent_session_id": task.agent_session_id,
            "status": task.status.value,
            "updated_at": updated_at.isoformat(),
            "last_event_id": task.last_event_id,
            "last_read_event_id": task.last_read_event_id,
            "last_progress_text": task.last_progress_text,
            "last_assistant_text": task.last_assistant_text,
            # push 알림 필터링용 메타 — orch PushNotifier가 LLM 세션과 비-사용자 시작 세션을
            # 차단하기 위해 사용. 정본은 task.session_type, task.caller_info["source"].
            "session_type": task.session_type,
            "caller_source": caller_info_dict.get("source"),
            "userName": caller_info_dict.get("display_name"),
            "userPortraitUrl": caller_info_dict.get("avatar_url"),
        }
        return await self.broadcast(event)

    async def emit_session_phase(self, task: Task, phase: str) -> int:
        """멀티턴 Claude Code 세션의 턴 사이 phase 전환을 통보한다 (running ↔ idle).

        task.status는 항상 RUNNING으로 유지되어 컨트롤 플로우에 영향이 없다 (멀티턴 세션은
        다음 사용자 입력을 기다리며 task가 alive 상태로 남기 때문). 그러나 클라이언트
        UI(타이핑 인디케이터, 도트 색상)는 한 턴이 끝났는지(idle)와 응답 생성 중인지(running)를
        구분해야 자연스럽다. 본 메서드는 task.status를 건드리지 않고 SSE wire-level status만
        실어 클라이언트에 phase 전환을 알린다.

        ⚠️ wire-level 임시 상태이므로 DB의 sessions.status에는 저장되지 않는다 — finalize_task만
        그것을 책임진다 (task가 진짜로 종료될 때).
        """
        # F-10C fix(2026-05-08): emit_session_updated와 대칭으로 user 프로필 운반.
        caller_info_dict = task.caller_info or {}
        event = {
            "type": "session_updated",
            "agent_session_id": task.agent_session_id,
            "status": phase,
            "updated_at": utc_now().isoformat(),
            "last_event_id": task.last_event_id,
            "last_read_event_id": task.last_read_event_id,
            "last_assistant_text": task.last_assistant_text,
            # push 알림 필터링용 메타 (emit_session_updated와 대칭).
            "session_type": task.session_type,
            "caller_source": caller_info_dict.get("source"),
            "userName": caller_info_dict.get("display_name"),
            "userPortraitUrl": caller_info_dict.get("avatar_url"),
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

        ## P6 결정(2026-05-08): user 프로필을 wire에 *비워 보낸다*

        본 wire는 emit_session_updated/emit_session_phase와 달리
        userName/userPortraitUrl·caller_source 키를 *포함하지 않는다*. 의도적이며
        결함이 아니다.

        근거:
        - 본 이벤트는 readable event마다 발행되는 *메시지 갱신* wire — 세션 단위
          메타데이터(user 프로필·발신자 source)는 P3 session_created에서 클라이언트
          캐시에 들어왔고 이후 변하지 않는다. 메시지마다 재전송할 필요 없음.
        - 클라이언트 buildSessionUpdates는 키 부재/None을 skip하므로 표시 영향 0.
        - 키를 넣으려면 caller_info source와 enrichment 정책을 또 한 번 끌어와야
          하므로 정본 둘 안티패턴(atom d7a1ad86) 재발 위험.

        메시지 단위 user 프로필 갱신이 필요한 표시 위치가 새로 추가되면 본 결정을
        재검토. 그 시점에 본 wire에 키 추가 + orch 측 enrichment 헬퍼 호출 추가.

        ## G-19 fix(2026-05-11): `last_message` 키는 본 wire의 식별 마커

        orch `_on_node_change` session_updated 분기는 본 wire와 emit_session_updated/
        emit_session_phase를 *구분*하여 처리해야 한다 — 본 wire는 caller 키 부재로
        오는 게 의도이지만 orch enrichment 헬퍼가 wire 종류를 모르고 호출되면
        caller_source=None + userName falsy 조합이 노드 owner fallback을 발동시켜
        SessionSummary가 dashboard owner로 매 메시지마다 덮어쓰이는 회로가 발생한다
        (라이브 재현 sess-20260511075138-3696750a, atom diagnosis 20260511-1700).

        orch는 본 wire의 *유일 고유 키*인 `last_message` 존재로 식별한다
        (emit_session_updated/phase는 last_assistant_text/last_progress_text는 박지만
        last_message는 *절대* 박지 않음).

        ⚠️ **변경 금지 사항** — 다음을 바꿀 때는 N.4 D-2 게이트(atom 9d47010b)를
        반드시 함께 점검할 것:
        1. 본 wire 페이로드에서 `last_message` 키 *제거*
           → orch 식별 마커 소실 → wire 종류 식별 실패 → G-19 회로 재발
        2. emit_session_updated/emit_session_phase wire에 `last_message` 키 *추가*
           → 식별 마커 충돌 → enrichment 회피 회로 → user 프로필 missing 회귀
        3. 본 wire에 caller_source/userName/userPortraitUrl 키 *추가* (P6 결정 철회)
           → orch 가드의 *enrichment skip 정당성* 무너짐 → 정본 둘 안티패턴 재발

        본 contract는 회귀 안전망으로 `test_session_broadcaster.py`의
        `test_session_message_updated_payload_keys_exact` (T15)와 orch
        `test_main_on_node_change.py`의 T13/T14가 함께 보호한다.

        관련 atom:
        - emit_session_updated wire payload 키 목록: b558ca3b
        - 정본 둘 안티패턴: d7a1ad86
        - N.4 enrichment 변경 시 동시 갱신: 9d47010b
        - G-19 진단: roselin/.local/artifacts/analysis/20260511-1700-caller-info-feed-card-leak-diagnosis.md

        Args:
            agent_session_id: 세션 식별자
            status: 현재 세션 상태 (TaskStatus.value)
            updated_at: ISO 8601 타임스탬프 (항상 UTC)
            last_message: {"type": str, "preview": str, "timestamp": str} — 본 wire의 식별 마커
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
