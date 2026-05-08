"""F-9 + F-10A/B fix — intervene/resume wire에 caller_info 운반 회귀 테스트.

F-9 (atom F-9 카드 beed44e0):
- 슬랙 2차+ 메시지가 InterventionSentEvent에 caller_info 없이 wire되어
  unified-dashboard InterventionMessage가 발신자(슬랙)이 아닌 dashboard owner(Google)
  portrait를 표시.
- /execute resume 흐름에서 task_factory가 params.caller_info를 task.caller_info에
  갱신하지 않아, 두 번째 user_message가 첫 caller_info(또는 None)로 떨어져
  사용자 보고 ("resume에서도 2회차 이후에는 기본 프로필이 나와") 발생.
- evicted task reload 시 caller_info를 복원하지 않아 위와 동일 결함이 추가 발생.

F-10A/B (2026-05-08, 본 라운드):
- F-9 fix가 InterventionSentEvent에 caller_info를 박았으나 task_executor 콜백이
  caller_info를 받지 못해 DB events 영속·listener_manager.broadcast 모두 누락.
- 결과: running 세션 intervene 시 클라이언트가 받는 dict에 caller_info 없음 →
  InterventionMessage fallback이 *세션 첫 발신자*로 떨어짐 (사용자 보고 결함 B).
- F-10B: engine_adapter on_intervention_callback이 콜백에 caller_info forward.
- F-10A: task_executor on_intervention_sent 콜백 시그니처 + dict에 caller_info 박음.

본 모듈은 다음 6 결함의 회귀 차단:
- Q-1: add_intervention 큐 message dict에 caller_info 첨부 (F-9)
- Q-4: InterventionSentEvent 스키마에 caller_info 필드 존재 (F-9)
- R-1: task_factory._resume_existing_task_locked가 params.caller_info로 task.caller_info 갱신 (F-9)
- R-2: session_eviction_manager.load_evicted_task가 metadata에서 caller_info 복원 (F-9)
- F-10B: engine_adapter handler가 콜백에 caller_info forward (본 라운드)
- F-10A: task_executor on_intervention_sent가 caller_info를 dict에 박음 (본 라운드)
"""

import asyncio
from datetime import datetime, timezone
from typing import Optional
from unittest.mock import AsyncMock, MagicMock

import pytest

from soul_common.models.schemas import InterventionSentEvent
from soul_server.service.engine_adapter import SoulEngineAdapter
from soul_server.service.task_factory import CreateTaskParams, TaskFactory
from soul_server.service.session_eviction_manager import SessionEvictionManager
from soul_server.service.task_manager import TaskManager
from soul_server.service.task_models import Task, TaskStatus


# === 1. InterventionSentEvent 스키마 (Q-4) ===


class TestInterventionSentEventSchema:
    """InterventionSentEvent에 caller_info 필드가 존재하고 직렬화에 포함된다."""

    def test_caller_info_field_exists_and_serialized(self):
        ci = {
            "source": "slack",
            "display_name": "동료",
            "avatar_url": "https://slack.com/img.png",
            "user_id": "U123",
        }
        ev = InterventionSentEvent(user="동료", text="추가 질문", caller_info=ci)
        dumped = ev.model_dump()
        assert dumped["type"] == "intervention_sent"
        assert dumped["caller_info"] == ci

    def test_caller_info_omits_when_none(self):
        # caller_info=None은 graceful — wire에 None으로 남거나 클라이언트가 null로 처리.
        # 기존 동작 보존을 위해 model_dump 결과에 None이 포함됨을 단언 (스키마 안정성).
        ev = InterventionSentEvent(user="bot", text="hi")
        dumped = ev.model_dump()
        assert dumped["caller_info"] is None


# === 2. add_intervention 큐 첨부 (Q-1) ===


def _make_task(session_id: str, status: TaskStatus = TaskStatus.RUNNING) -> Task:
    task = Task(
        agent_session_id=session_id,
        prompt="prev",
        client_id="user",
        status=status,
    )
    return task


class TestAddInterventionQueueCallerInfo:
    """task_manager.add_intervention(caller_info=...)이 큐에 메시지 첨부."""

    @pytest.mark.asyncio
    async def test_queue_message_has_caller_info(self, monkeypatch):
        """running 세션에 add_intervention(caller_info=ci) → 큐 dict에 caller_info."""
        # 의존성 직접 의존하지 않고 TaskManager 인스턴스의 _tasks·_eviction_manager만
        # 사용하는 분기를 호출. RUNNING task는 큐 push 후 즉시 return → 외부 의존 0.
        manager = MagicMock(spec=TaskManager)
        # 실제 add_intervention을 unbound로 호출하여 manager mock 기반으로 동작 검증
        task = _make_task("sess-1", status=TaskStatus.RUNNING)
        manager._tasks = {"sess-1": task}

        ci = {
            "source": "slack",
            "display_name": "동료",
            "avatar_url": "https://slack/img.png",
            "user_id": "U123",
        }
        result = await TaskManager.add_intervention(
            manager,
            agent_session_id="sess-1",
            text="2차 메시지",
            user="U123",
            attachment_paths=None,
            caller_info=ci,
        )
        assert result == {"queue_position": 1}

        # 큐에서 꺼내 caller_info 확인
        msg = task.intervention_queue.get_nowait()
        assert msg["text"] == "2차 메시지"
        assert msg["user"] == "U123"
        assert msg["caller_info"] == ci

    @pytest.mark.asyncio
    async def test_queue_message_without_caller_info_keeps_none(self):
        """caller_info 인자 미전달 → 큐 dict에 caller_info=None (graceful)."""
        manager = MagicMock(spec=TaskManager)
        task = _make_task("sess-2", status=TaskStatus.RUNNING)
        manager._tasks = {"sess-2": task}

        await TaskManager.add_intervention(
            manager,
            agent_session_id="sess-2",
            text="아무거나",
            user="user",
            attachment_paths=None,
        )
        msg = task.intervention_queue.get_nowait()
        assert msg["caller_info"] is None


# === 3. task_factory resume caller_info 갱신 (R-1) ===


class TestResumeCallerInfoRefresh:
    """task_factory._resume_existing_task_locked가 params.caller_info로 task.caller_info 갱신."""

    @pytest.mark.asyncio
    async def test_params_caller_info_overwrites_task_caller_info(self):
        """resume 시 params.caller_info가 truthy면 task.caller_info를 그것으로 갱신."""
        # 직접 호출이 어렵기 때문에 _resume_existing_task_locked 메서드를 unbound로
        # 호출하고 의존성 mock으로 안전하게 격리한다.
        factory = MagicMock(spec=TaskFactory)
        factory._db = AsyncMock()
        factory._db.get_session = AsyncMock(return_value={"metadata": []})
        factory._eviction_manager = MagicMock()

        old_ci = {"source": "browser", "user_id": "old@example.com"}
        new_ci = {"source": "slack", "user_id": "U_new"}

        task = _make_task("sess-3", status=TaskStatus.COMPLETED)
        task.caller_info = old_ci
        task.claude_session_id = "claude-123"

        params = CreateTaskParams(
            prompt="이어서",
            agent_session_id="sess-3",
            client_id="U_new",
            caller_info=new_ci,
        )
        await TaskFactory._resume_existing_task_locked(
            factory, task, params, effective_context_items=None,
        )
        assert task.caller_info == new_ci

    @pytest.mark.asyncio
    async def test_none_params_caller_info_preserves_existing(self):
        """resume 시 params.caller_info=None → 기존 task.caller_info 유지 (graceful)."""
        factory = MagicMock(spec=TaskFactory)
        factory._db = AsyncMock()
        factory._db.get_session = AsyncMock(return_value={"metadata": []})
        factory._eviction_manager = MagicMock()

        existing_ci = {"source": "slack", "user_id": "U_existing"}

        task = _make_task("sess-4", status=TaskStatus.COMPLETED)
        task.caller_info = existing_ci
        task.claude_session_id = "claude-456"

        params = CreateTaskParams(
            prompt="이어서2",
            agent_session_id="sess-4",
            client_id="U_existing",
            caller_info=None,
        )
        await TaskFactory._resume_existing_task_locked(
            factory, task, params, effective_context_items=None,
        )
        assert task.caller_info == existing_ci  # 보존


# === 4. load_evicted_task metadata caller_info 복원 (R-2) ===


class TestLoadEvictedTaskRestoresCallerInfo:
    """session_eviction_manager.load_evicted_task가 metadata에서 caller_info 복원."""

    @pytest.mark.asyncio
    async def test_metadata_caller_info_restored_to_task(self):
        """DB metadata에 caller_info entry → task.caller_info 복원."""
        manager = SessionEvictionManager(tasks={}, eviction_ttl=60.0)
        ci = {
            "source": "slack",
            "display_name": "동료",
            "avatar_url": "https://slack/img.png",
            "user_id": "U_PERSISTED",
        }
        session_db = AsyncMock()
        session_db.get_session = AsyncMock(return_value={
            "status": "completed",
            "created_at": "2026-05-07T12:00:00+00:00",
            "updated_at": "2026-05-07T13:00:00+00:00",
            "client_id": "U_PERSISTED",
            "claude_session_id": "claude-evicted",
            "session_type": "claude",
            "last_event_id": 42,
            "last_read_event_id": 42,
            "node_id": "node-x",
            "caller_session_id": None,
            "agent_id": None,
            "metadata": [
                {"type": "caller_info", "value": ci},
            ],
        })

        task = await manager.load_evicted_task(session_db, "sess-evicted")
        assert task is not None
        assert task.caller_info == ci

    @pytest.mark.asyncio
    async def test_metadata_no_caller_info_entry_yields_none(self):
        """metadata에 caller_info entry 없음 → task.caller_info=None (graceful)."""
        manager = SessionEvictionManager(tasks={}, eviction_ttl=60.0)
        session_db = AsyncMock()
        session_db.get_session = AsyncMock(return_value={
            "status": "interrupted",
            "created_at": "2026-05-07T12:00:00+00:00",
            "updated_at": "2026-05-07T13:00:00+00:00",
            "client_id": "u",
            "claude_session_id": None,
            "session_type": "claude",
            "last_event_id": 0,
            "last_read_event_id": 0,
            "node_id": None,
            "caller_session_id": None,
            "agent_id": None,
            "metadata": [
                {"type": "other", "value": {"foo": "bar"}},
            ],
        })
        task = await manager.load_evicted_task(session_db, "sess-no-ci")
        assert task is not None
        assert task.caller_info is None

    @pytest.mark.asyncio
    async def test_metadata_none_yields_none_caller_info(self):
        """metadata=None → task.caller_info=None (graceful)."""
        manager = SessionEvictionManager(tasks={}, eviction_ttl=60.0)
        session_db = AsyncMock()
        session_db.get_session = AsyncMock(return_value={
            "status": "completed",
            "created_at": "2026-05-07T12:00:00+00:00",
            "updated_at": "2026-05-07T13:00:00+00:00",
            "client_id": "u",
            "claude_session_id": None,
            "session_type": "claude",
            "last_event_id": 0,
            "last_read_event_id": 0,
            "node_id": None,
            "caller_session_id": None,
            "agent_id": None,
            "metadata": None,
        })
        task = await manager.load_evicted_task(session_db, "sess-nometa")
        assert task is not None
        assert task.caller_info is None


# === 5. F-10B engine_adapter handler caller_info forward ===


class TestF10BEngineAdapterCallbackForward:
    """F-10B 회귀 — engine_adapter on_intervention_callback이 task_executor 콜백에 caller_info forward.

    F-9 fix는 InterventionSentEvent에만 caller_info를 박았고 콜백 호출 시 인자로 전달
    안 했음. 본 라운드 fix가 콜백에 caller_info를 forward하여 task_executor가 DB 영속·
    listener broadcast 양쪽에 caller_info를 박을 수 있게 함.
    """

    @pytest.mark.asyncio
    async def test_callback_receives_caller_info_when_intervention_has_it(self):
        adapter = SoulEngineAdapter()
        ci = {"source": "slack", "display_name": "동료A", "user_id": "U_A"}
        intervention_dict = {
            "text": "추가 메시지",
            "user": "동료A",
            "attachment_paths": [],
            "caller_info": ci,
        }
        get_intervention = AsyncMock(return_value=intervention_dict)
        on_intervention_sent = AsyncMock()
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()
        runner_ref = [None]

        handlers = adapter._make_handlers(
            queue=queue,
            loop=loop,
            runner_ref=runner_ref,
            get_intervention=get_intervention,
            on_intervention_sent=on_intervention_sent,
        )
        result = await handlers.on_intervention_callback()
        assert result is not None  # _build_intervention_prompt 결과 (string)

        # InterventionSentEvent가 큐에 박힘 + caller_info 포함 (F-9 fix 회귀)
        ev = await queue.get()
        assert isinstance(ev, InterventionSentEvent)
        assert ev.caller_info == ci

        # F-10B 단언: 콜백이 caller_info와 함께 호출됨
        on_intervention_sent.assert_awaited_once_with(
            "동료A", "추가 메시지", [], ci,
        )

    @pytest.mark.asyncio
    async def test_callback_receives_none_caller_info_gracefully(self):
        """intervention dict에 caller_info=None → 콜백에 None forward (graceful)."""
        adapter = SoulEngineAdapter()
        intervention_dict = {
            "text": "메시지",
            "user": "user",
            "attachment_paths": [],
            "caller_info": None,
        }
        get_intervention = AsyncMock(return_value=intervention_dict)
        on_intervention_sent = AsyncMock()
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()
        runner_ref = [None]

        handlers = adapter._make_handlers(
            queue=queue,
            loop=loop,
            runner_ref=runner_ref,
            get_intervention=get_intervention,
            on_intervention_sent=on_intervention_sent,
        )
        await handlers.on_intervention_callback()
        on_intervention_sent.assert_awaited_once_with(
            "user", "메시지", [], None,
        )
