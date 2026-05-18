"""/execute · /api/sessions/{id}/intervene 정본 통합 검증 (design-principles §3).

두 라우트가 같은 시나리오에서 같은 정본(submit_message → add_intervention/직접 호출)을 거쳐
동일 결과를 만든다. 라우트 어댑터 변경 후의 회귀 보호:

- /execute 라우트(tasks.py): submit_message 직접 호출 + TaskConflictError 분기 제거
- /api/sessions/{id}/intervene(_lifecycle.py): intervention_service.intervene → add_intervention → submit_message

본 테스트는 라우트 wire 자체보다 *두 진입점이 같은 정본을 거치는지*에 초점.
라우트 wire(SSE/ACK 형식)는 기존 test_api_session_events.py·test_intervention_service.py가 보호.

ACK 형식 회귀: api_intervene이 반환하는 dict 형식이 변경 0임을 intervention_service 통과로 확인.
broadcast 수신 정합: listener_manager 기본 동작이 본 fix로 영향받지 않음을 회귀 보호.
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from soul_server.service.message_submission_service import (
    SubmitMessageParams,
    submit_message,
)
from soul_server.service.task_manager import TaskManager, set_task_manager
from soul_server.service.task_factory import CreateTaskParams
from soul_server.service.task_models import TaskStatus


def _make_mock_db():
    db = MagicMock()
    db._pool = AsyncMock()
    db.node_id = "test-node"
    db.register_session_initial = AsyncMock()
    db.set_claude_session_id = AsyncMock()
    db.update_session = AsyncMock()
    db.update_session_status = AsyncMock()
    db.get_session = AsyncMock(return_value=None)
    db.get_all_sessions = AsyncMock(return_value=([], 0))
    db.append_event = AsyncMock(return_value=1)
    db.read_events = AsyncMock(return_value=[])
    db.update_last_read_event_id = AsyncMock(return_value=True)
    db.get_read_position = AsyncMock(return_value=(0, 0))
    db.get_all_folders = AsyncMock(return_value=[
        {"id": "claude", "name": "⚙️ 클로드 코드 세션"},
    ])
    db.get_folder = AsyncMock(return_value={"id": "claude", "name": "⚙️"})
    db.get_catalog = AsyncMock(return_value={"folders": [], "sessions": {}})
    db.get_default_folder = AsyncMock(return_value={"id": "claude", "name": "⚙️"})
    db.assign_session_to_folder = AsyncMock()
    db.append_metadata = AsyncMock()
    db.DEFAULT_FOLDERS = {"claude": "⚙️", "llm": "⚙️"}
    return db


@pytest.fixture
def manager():
    m = TaskManager(session_db=_make_mock_db())
    yield m
    set_task_manager(None)


class TestExecuteInterveneUnify:
    """/execute와 /intervene이 같은 시나리오에서 같은 정본을 거친다."""

    async def test_running_session_both_routes_queue_intervention(self, manager):
        """RUNNING task에 /execute(agent_session_id)와 /intervene 모두 intervention_queue로 큐잉.

        본 fix 전 /execute는 TaskConflictError → 409를 반환했다. 본 fix 후 두 라우트 모두
        같은 submit_message 정본을 거쳐 kind='intervened'로 큐잉된다 (의미상 동일).
        """
        await manager.create_task(CreateTaskParams(prompt="first", agent_session_id="sess-X"))

        # /execute 경로 시뮬레이션 — submit_message 직접 호출 (tasks.py:execute_task가 그렇게 함)
        res_a = await submit_message(
            SubmitMessageParams(prompt="from-execute", agent_session_id="sess-X", user="u1"),
            task_manager=manager,
        )
        assert res_a.kind == "intervened"
        assert res_a.queue_position == 1

        # /intervene 경로 시뮬레이션 — add_intervention(=submit_message wrapper) 호출
        # (intervention_service.intervene이 add_intervention을 호출하는 흐름)
        res_b = await manager.add_intervention(
            agent_session_id="sess-X", text="from-intervene", user="u2"
        )
        assert "queue_position" in res_b
        assert res_b["queue_position"] == 2

        # ★ 두 경로가 같은 task의 같은 intervention_queue에 큐잉됨 — 정본 하나
        task = await manager.get_task("sess-X")
        assert task.intervention_queue.qsize() == 2
        msgs = []
        while not task.intervention_queue.empty():
            msgs.append(task.intervention_queue.get_nowait())
        assert msgs[0]["text"] == "from-execute"
        assert msgs[1]["text"] == "from-intervene"

    async def test_terminal_session_both_routes_auto_resume_fresh(self, manager):
        """terminal task에 두 라우트 모두 auto-resume + task.resume_session_id is None.

        본 fix의 핵심 — Claude 계정 limit 후 두 경로 모두 동일 정책으로 fresh 시작.
        """
        await manager.create_task(CreateTaskParams(prompt="first", agent_session_id="sess-Y"))
        await manager.register_session("claude-Y", "sess-Y")

        # 시나리오 1: /execute 경로
        task = await manager.get_task("sess-Y")
        task.status = TaskStatus.INTERRUPTED

        res_a = await submit_message(
            SubmitMessageParams(prompt="from-execute", agent_session_id="sess-Y"),
            task_manager=manager,
        )
        assert res_a.kind == "auto_resumed"
        assert res_a.task.resume_session_id is None  # ★ Claude SDK fresh

        # 시나리오 2: /intervene 경로 — 다시 terminal로 전환 후 add_intervention
        task = await manager.get_task("sess-Y")
        task.status = TaskStatus.INTERRUPTED

        res_b = await manager.add_intervention(
            agent_session_id="sess-Y", text="from-intervene", user="u"
        )
        assert res_b["auto_resumed"] is True
        task = await manager.get_task("sess-Y")
        assert task.resume_session_id is None  # ★ 동일 정책


class TestInterveneAckFormatRegression:
    """ACK 형식 회귀 — intervention_service.intervene 반환 dict 형식 변경 0."""

    async def test_running_returns_queued_format(self, manager):
        """running 세션에 intervention_service.intervene 호출 → {queued: True, queue_position}."""
        from soul_server.service.intervention_service import intervene as svc_intervene

        await manager.create_task(CreateTaskParams(prompt="first", agent_session_id="sess-Q"))

        soul_engine = MagicMock()
        rm = MagicMock()
        result = await svc_intervene(
            agent_session_id="sess-Q",
            text="개입",
            user="u",
            attachment_paths=None,
            task_manager=manager,
            soul_engine=soul_engine,
            resource_manager=rm,
        )
        assert result == {"queued": True, "queue_position": 1}

    async def test_terminal_returns_auto_resumed_format(self, manager):
        """terminal 세션에 intervention_service.intervene → {auto_resumed: True, agent_session_id}."""
        from soul_server.service.intervention_service import intervene as svc_intervene

        await manager.create_task(CreateTaskParams(prompt="first", agent_session_id="sess-R"))
        await manager.register_session("claude-R", "sess-R")
        task = await manager.get_task("sess-R")
        task.status = TaskStatus.INTERRUPTED

        # start_execution mock — auto_resumed 경로에서 호출되므로 (실 실행은 막음)
        manager._executor.start_execution = AsyncMock()
        soul_engine = MagicMock()
        rm = MagicMock()

        result = await svc_intervene(
            agent_session_id="sess-R",
            text="후속",
            user="u",
            attachment_paths=None,
            task_manager=manager,
            soul_engine=soul_engine,
            resource_manager=rm,
        )
        assert result == {"auto_resumed": True, "agent_session_id": "sess-R"}
        # start_execution 호출 검증 — auto_resumed 케이스에서 라우트가 트리거
        assert manager._executor.start_execution.called


class TestBroadcastListenerIntegration:
    """broadcast → listener queue 도달 회귀 — 본 fix가 listener wire에 영향 없음.

    위임자 보강 3: "이벤트 스트리밍 수신 정합"이 핵심 검증 게이트.
    submit_message 자체는 broadcast 안 하므로 listener_manager 기본 동작 회귀 보호.
    """

    async def test_listener_receives_broadcast_after_intervene(self, manager):
        """intervene 호출 후 listener queue에 broadcast 이벤트가 도달함을 확인."""
        await manager.create_task(CreateTaskParams(prompt="first", agent_session_id="sess-B"))

        queue = asyncio.Queue()
        await manager.listener_manager.add_listener("sess-B", queue)

        # intervene 호출 (running → 큐잉)
        await manager.add_intervention(
            agent_session_id="sess-B", text="개입", user="u"
        )

        # broadcast 시뮬레이션 — 실 운영에서는 task_executor가 호출하지만 여기선 직접
        fake_event = {"type": "assistant_text", "text": "응답 chunk"}
        await manager.listener_manager.broadcast("sess-B", fake_event)

        received = await asyncio.wait_for(queue.get(), timeout=1.0)
        assert received["type"] == "assistant_text"
        assert received["text"] == "응답 chunk"
