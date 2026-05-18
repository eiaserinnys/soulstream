"""P2-2 (260518.06) T-8 분류 처리: 정적 가드 1건 유지 + 동작 invariant 3건 통합 대체.

## 구조

- `TestInterventionMsgVariableRemoved` (1 case): T-8.1 *구조적 회귀 가드* — `intervention_msg`
  변수 재도입 금지. payload는 동일해도 두 dict가 다시 분리되면 정본 둘 회로가 재발하므로
  통합 테스트로는 대체 불가능 (외부 payload만 검증). atom d7a1ad86 회로 차단 정본.

- `TestOnInterventionSentPayloadIntegration` (4 case): T-8.2/T-8.3/T-8.4 *동작 invariant*를
  통합 시나리오로 대체. `test_task_executor_multiturn.py` L21-99 패턴 차용. design-principles
  §10(외부 관찰 가능한 payload 검사) + §3(invariant 이중검사 회피)의 균형.

## DB mock 패턴

`self._db is not None` path 진입 시 `_make_db_mock()` = `AsyncMock(spec=PostgresSessionDB)` 사용.
plain `MagicMock()`은 `await self._db.get_session(...)`(`execution_context_builder.py:90`)에서
TypeError. spec으로 await 호환 + 반환값 None 기본이라 `_resolve_folder`는 L91 가드에서 조기 반환
— DB 동작 우회하면서 `_db is not None` 경로 진입.
"""

import copy
import inspect
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Optional
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from soul_server.service import task_executor as task_executor_module
from soul_server.service.postgres_session_db import PostgresSessionDB
from soul_server.service.task_executor import TaskExecutor
from soul_server.service.task_models import Task


# ── T-8.1: 구조적 회귀 가드 (정적 가드 유지) ──────────────────────────────


class TestInterventionMsgVariableRemoved:
    """T-8.1 구조적 회귀 가드 — 통합 테스트로 대체 불가능 (atom d7a1ad86 정본 둘 안티패턴)."""

    def test_intervention_msg_variable_not_reintroduced(self):
        """`intervention_msg = {...}` 분리 dict가 재도입되지 않는다.

        payload는 동일해도 두 dict가 다시 분리되면 정본 둘 회로가 재발한다.
        통합 테스트가 외부 payload만 검증하므로 이 invariant는 정적 가드만 잡을 수 있다.
        """
        source = inspect.getsource(task_executor_module)
        assert "intervention_msg = {" not in source, (
            "Y-4 정본 둘 안티패턴 재발: intervention_msg dict 분리 — atom d7a1ad86. "
            "단일 event dict 유지하라."
        )


# ── T-8.2/T-8.3/T-8.4: 통합 시나리오 ────────────────────────────────────


@dataclass
class _MockEvent:
    """claude_runner.execute()가 yield하는 이벤트 mock (multiturn 테스트 패턴 차용)."""
    type: str
    result: Optional[str] = None
    _extra: dict = field(default_factory=dict)

    def model_dump(self):
        d: dict = {"type": self.type, "parent_event_id": None}
        if self.result is not None:
            d["result"] = self.result
        d.update(self._extra)
        return d


@asynccontextmanager
async def _acquire(**_kwargs):
    yield


def _make_rm():
    rm = MagicMock()
    rm.acquire = _acquire
    return rm


def _make_db_mock():
    """`_db is not None` path 진입용 mock.

    `_resolve_folder`(execution_context_builder.py:87-92)가 self._db is None이면 조기 반환,
    아니면 `await self._db.get_session(...)`를 호출한다. MagicMock()은 코루틴이 아니라
    `await` 시 TypeError를 일으키므로 `AsyncMock(spec=PostgresSessionDB)`를 사용한다.

    get_session의 반환값을 명시적으로 None으로 설정 → _resolve_folder는 session_row 가드
    (L91)에서 조기 반환 (folder_row 조회 회피 — coroutine leak 방지). 그래도 self._db 자체는
    None이 아니므로 task_executor의 `_db is not None` 경로(system_prompt/user_message persist
    포함)는 모두 진입한다.
    """
    db = AsyncMock(spec=PostgresSessionDB)
    db.get_session = AsyncMock(return_value=None)
    return db


def _make_executor(*, session_db, listener):
    """`_db` path 분기를 위해 session_db 명시.

    session_db 값:
      - None: self._db = None → _resolve_folder 조기 반환 (DB 호출 0)
      - _make_db_mock(): self._db is not None path 진입. await 호환.

    plain MagicMock()은 await 호환되지 않으므로 사용 금지 — _make_db_mock() 사용.
    """
    ex = TaskExecutor(
        tasks={},
        listener_manager=listener,
        get_intervention_func=AsyncMock(return_value=None),
        finalize_task_func=AsyncMock(return_value=None),
        session_db=session_db,
    )
    # _persistence는 __init__에서 생성되므로 외부에서 mock 교체
    ex._persistence = MagicMock(
        persist_event=AsyncMock(return_value=42),
        update_last_message=AsyncMock(),
        handle_side_effects=AsyncMock(),
    )
    return ex


def _runner_calling_intervention(*, user="alice", text="stop",
                                 attachment_paths=None, caller_info=None):
    """execute()가 on_intervention_sent 콜백을 *직접* 호출하여 broadcast/persist 트리거.

    intervention_sent type 이벤트는 _run_execution 메인 루프에서 continue되므로
    yield와 별개로 콜백 호출을 통해 broadcast/persist 흐름을 발동한다.
    종료는 yield _MockEvent(type="complete")로.
    """
    runner = MagicMock()
    runner.workspace_dir = "/test/workspace"

    async def fake_execute(**kwargs):
        cb = kwargs["on_intervention_sent"]
        kwargs_cb = {"user": user, "text": text}
        if attachment_paths is not None:
            kwargs_cb["attachment_paths"] = attachment_paths
        if caller_info is not None:
            kwargs_cb["caller_info"] = caller_info
        await cb(**kwargs_cb)
        yield _MockEvent(type="complete", result="ok")

    runner.execute = fake_execute
    return runner


def _filter_calls(mock_call_list, event_type: str):
    """broadcast/persist call_args_list에서 event type 매칭만 추출."""
    return [c for c in mock_call_list if c.args[1].get("type") == event_type]


class TestOnInterventionSentPayloadIntegration:
    """T-8.2/T-8.3/T-8.4 통합 대체 — broadcast·persist payload 정합 검증."""

    @pytest.mark.asyncio
    @patch("soul_server.service.task_executor.get_session_broadcaster")
    @patch("soul_server.service.execution_context_builder.assemble_prompt",
           return_value="assembled test prompt")
    @patch("soul_server.service.task_executor.build_soulstream_context_item",
           return_value={"key": "soulstream_session", "content": {"mock": True}})
    async def test_normal_path_context_in_both_broadcast_and_persist(
        self, _build, _asm, _bcast
    ):
        """T-8.2/T-8.4 대체: 정상 path(self._db not None) — broadcast event와 persist payload
        모두 동일 context. broadcast에는 `_event_id` 박힘, persist 호출 *시점* dict에는
        부재 (T-8.3, ride-along; deepcopy로 호출 시점 캡처)."""
        _bcast.return_value = MagicMock(
            emit_session_updated=AsyncMock(),
            emit_session_message_updated=AsyncMock(),
        )
        listener = MagicMock()
        listener.broadcast = AsyncMock()
        ex = _make_executor(session_db=_make_db_mock(), listener=listener)

        # dict aliasing 회피: persist_event 호출 *시점* event dict는 deepcopy로 캡처.
        # _run_execution이 시작될 때 system_prompt·user_message도 persist되므로 (각각
        # task_executor.py L140·L167), intervention_sent type만 필터링하여 캡처한다.
        persist_snapshots: list = []

        async def capture_persist(_sid, ev):
            if ev.get("type") == "intervention_sent":
                persist_snapshots.append(copy.deepcopy(ev))
            return 42

        ex._persistence.persist_event = AsyncMock(side_effect=capture_persist)

        task = Task(agent_session_id="sess-test", prompt="test prompt")
        ex._tasks[task.agent_session_id] = task
        await ex._run_execution(
            task=task,
            claude_runner=_runner_calling_intervention(),
            resource_manager=_make_rm(),
        )

        broadcasts = _filter_calls(listener.broadcast.call_args_list, "intervention_sent")
        assert len(broadcasts) == 1, f"intervention_sent broadcast 1회 기대, 실제 {len(broadcasts)}"
        ev = broadcasts[0].args[1]
        assert ev["context"] == [{"key": "soulstream_session", "content": {"mock": True}}], (
            "P2-3/T-8.2: broadcast event에 context 키 누락"
        )
        assert ev["_event_id"] == 42, (
            "T-8.3 ride-along: persist 이후 _event_id가 broadcast event에 박혀야 함"
        )

        assert len(persist_snapshots) == 1, (
            f"T-8.4: persist_event(event) 1회 호출 기대, 실제 {len(persist_snapshots)}"
        )
        assert persist_snapshots[0]["context"] == [
            {"key": "soulstream_session", "content": {"mock": True}}
        ], "T-8.2/§3: persist payload에 context 키 누락 (broadcast와 정합 필수)"
        assert "_event_id" not in persist_snapshots[0], (
            "T-8.3 ride-along: persist 호출 *시점* event dict에는 _event_id 부재여야 함 "
            "(DB 컬럼에 미저장)"
        )

    @pytest.mark.asyncio
    @patch("soul_server.service.task_executor.get_session_broadcaster")
    @patch("soul_server.service.execution_context_builder.assemble_prompt",
           return_value="assembled test prompt")
    @patch("soul_server.service.task_executor.build_soulstream_context_item",
           return_value={"key": "soulstream_session", "content": {"mock": True}})
    async def test_db_none_context_still_in_broadcast(self, _build, _asm, _bcast):
        """P2-3 핵심: self._db is None — persist 0회, broadcast에 context 박힘."""
        _bcast.return_value = MagicMock(
            emit_session_updated=AsyncMock(),
            emit_session_message_updated=AsyncMock(),
        )
        listener = MagicMock()
        listener.broadcast = AsyncMock()
        ex = _make_executor(session_db=None, listener=listener)

        task = Task(agent_session_id="sess-test", prompt="test prompt")
        ex._tasks[task.agent_session_id] = task
        await ex._run_execution(
            task=task,
            claude_runner=_runner_calling_intervention(),
            resource_manager=_make_rm(),
        )

        broadcasts = _filter_calls(listener.broadcast.call_args_list, "intervention_sent")
        assert len(broadcasts) == 1
        ev = broadcasts[0].args[1]
        assert ev["context"] == [{"key": "soulstream_session", "content": {"mock": True}}], (
            "P2-3: _db is None path에서도 broadcast event에 context 운반 필수 "
            "(직전 사이클은 _db None시 미박힘 — 본 사이클 wire 마무리)"
        )
        assert "_event_id" not in ev, "_db None이면 intervention persist 0회, _event_id 부재"
        # _run_execution 메인 루프(L245)는 _db 가드 없이 모든 이벤트(complete 등)를 persist
        # 시도하므로 assert_not_called()는 부적합. intervention_sent type persist만 0회 검증.
        intervention_persist = _filter_calls(
            ex._persistence.persist_event.call_args_list, "intervention_sent"
        )
        assert len(intervention_persist) == 0, (
            "_db is None path: intervention_sent type persist 0회 기대 — "
            "on_intervention_sent의 if self._db is not None 가드 안에서만 persist."
        )

    @pytest.mark.asyncio
    @patch("soul_server.service.task_executor.get_session_broadcaster")
    @patch("soul_server.service.execution_context_builder.assemble_prompt",
           return_value="assembled test prompt")
    @patch("soul_server.service.task_executor.build_soulstream_context_item",
           return_value={"key": "soulstream_session", "content": {"mock": True}})
    async def test_persist_failure_context_still_in_broadcast(
        self, _build, _asm, _bcast
    ):
        """§8 실패 격리: persist_event raise — broadcast에 context 박힘, `_event_id` 부재."""
        _bcast.return_value = MagicMock(
            emit_session_updated=AsyncMock(),
            emit_session_message_updated=AsyncMock(),
        )
        listener = MagicMock()
        listener.broadcast = AsyncMock()
        ex = _make_executor(session_db=_make_db_mock(), listener=listener)
        ex._persistence.persist_event = AsyncMock(side_effect=RuntimeError("DB down"))

        task = Task(agent_session_id="sess-test", prompt="test prompt")
        ex._tasks[task.agent_session_id] = task
        await ex._run_execution(
            task=task,
            claude_runner=_runner_calling_intervention(),
            resource_manager=_make_rm(),
        )

        broadcasts = _filter_calls(listener.broadcast.call_args_list, "intervention_sent")
        assert len(broadcasts) == 1
        ev = broadcasts[0].args[1]
        assert ev["context"] == [{"key": "soulstream_session", "content": {"mock": True}}], (
            "§8 실패 격리: persist 실패해도 broadcast에 context 운반 — P2-3 wire 마무리"
        )
        assert "_event_id" not in ev, "persist 실패 시 _event_id carry 안 됨"

    @pytest.mark.asyncio
    @patch("soul_server.service.task_executor.get_session_broadcaster")
    @patch("soul_server.service.execution_context_builder.assemble_prompt",
           return_value="assembled test prompt")
    @patch("soul_server.service.task_executor.build_soulstream_context_item",
           return_value={"key": "soulstream_session", "content": {"mock": True}})
    async def test_caller_info_attachments_coexist_with_context(
        self, _build, _asm, _bcast
    ):
        """호환성 회귀: caller_info·attachments·context 동시 운반."""
        _bcast.return_value = MagicMock(
            emit_session_updated=AsyncMock(),
            emit_session_message_updated=AsyncMock(),
        )
        listener = MagicMock()
        listener.broadcast = AsyncMock()
        ex = _make_executor(session_db=_make_db_mock(), listener=listener)

        task = Task(agent_session_id="sess-test", prompt="test prompt")
        ex._tasks[task.agent_session_id] = task
        await ex._run_execution(
            task=task,
            claude_runner=_runner_calling_intervention(
                attachment_paths=["/tmp/a.png"],
                caller_info={"source": "slack", "display_name": "서소영"},
            ),
            resource_manager=_make_rm(),
        )

        broadcasts = _filter_calls(listener.broadcast.call_args_list, "intervention_sent")
        assert len(broadcasts) == 1
        ev = broadcasts[0].args[1]
        assert ev["context"] == [{"key": "soulstream_session", "content": {"mock": True}}]
        assert ev["attachments"] == ["/tmp/a.png"]
        assert ev["caller_info"]["display_name"] == "서소영"
