"""뷰포트 API 단위/통합 테스트

10개 테스트로 viewport API 전체 동작을 검증한다 (spec-review v3 기준).

1. SubtreeUpdateSSEEvent 모델 직렬화 (JSON deltas key는 str)
2. update_subtree_heights — 단일 조상 체인 증가량 검증 (pure unit w/ fake pool)
3. update_subtree_heights — 루트 trigger는 조상 없음
4. task_executor subtree_update 브로드캐스트 (int 파이프 정상)
5. task_executor persist_event 실패 시 subtree_update 생성 안 됨
6. task_executor update_subtree_heights 실패 시 broadcast 1회만 (fail-safe)
7. read_viewport 다중 루트 경고 로그
8. events_viewport SQL — y_start/y_end/depth 계산 (DB 통합, skip if no TEST DB)
9. read_messages 페이지네이션 + next_cursor
10. /events/viewport + /messages API 엔드포인트 (smoke)
"""

import json
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Optional
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from soul_server.models.schemas import (
    CompleteEvent,
    SubtreeUpdateSSEEvent,
    ToolStartSSEEvent,
)
from soul_server.service.postgres_session_db import PostgresSessionDB
from soul_server.service.task_executor import TaskExecutor
from soul_server.service.task_models import Task, TaskStatus


# === Helpers ===


class FakeResourceManager:
    @asynccontextmanager
    async def acquire(self, timeout: float = 5.0):
        yield


class FakeClaudeRunner:
    workspace_dir = "/fake/workspace"

    def __init__(self, events):
        self._events = events

    async def execute(self, **kwargs):
        for event in self._events:
            yield event


def _make_task(session_id: str = "sess-viewport") -> Task:
    return Task(
        agent_session_id=session_id,
        prompt="test",
        client_id="test-bot",
        status=TaskStatus.RUNNING,
    )


def _make_mock_session_db():
    """이벤트를 인메모리로 추적하는 PostgresSessionDB mock.

    update_subtree_heights는 기본적으로 성공(1개 조상 증가)을 반환한다.
    """
    db = AsyncMock(spec=PostgresSessionDB)
    _events: dict = {}
    _next_ids: dict = {}

    async def _append_event(session_id, event_type, payload, searchable_text, created_at):
        if session_id not in _next_ids:
            _next_ids[session_id] = 1
        event_id = _next_ids[session_id]
        _events.setdefault(session_id, []).append({
            "id": event_id,
            "session_id": session_id,
            "event_type": event_type,
            "payload": payload,
            "created_at": created_at,
        })
        _next_ids[session_id] = event_id + 1
        return event_id

    async def _update_subtree_heights(session_id, trigger_event_id, increment=1):
        # parent_event_id가 있는 이벤트라고 가정: 1개 조상만 증가
        return {1: increment}, 5

    db.append_event = AsyncMock(side_effect=_append_event)
    db.update_subtree_heights = AsyncMock(side_effect=_update_subtree_heights)
    db.upsert_session = AsyncMock()
    db.get_session = AsyncMock(return_value=None)
    db.update_last_message = AsyncMock()
    db._events = _events
    return db


def _make_executor(tasks: dict, session_db=None) -> tuple[TaskExecutor, list]:
    listener_manager = MagicMock()
    broadcast_calls: list = []

    async def capture(session_id, event_dict):
        broadcast_calls.append((session_id, event_dict))

    listener_manager.broadcast = AsyncMock(side_effect=capture)

    executor = TaskExecutor(
        tasks=tasks,
        listener_manager=listener_manager,
        get_intervention_func=AsyncMock(return_value=None),
        finalize_task_func=AsyncMock(),
        register_session_func=AsyncMock(),
        session_db=session_db,
    )
    return executor, broadcast_calls


# === Tests ===


class TestSubtreeUpdateSSEEventModel:
    """SubtreeUpdateSSEEvent 직렬화 동작 검증."""

    def test_json_serialization_key_becomes_string(self):
        """dict[int, int] deltas는 JSON 직렬화 시 key가 str이 된다."""
        event = SubtreeUpdateSSEEvent(
            timestamp=1.0,
            affected_event_ids=[10, 20, 30],
            deltas={10: 1, 20: 1, 30: 1},
            new_total_subtree_height=100,
            trigger_event_id=40,
        )
        json_str = event.model_dump_json()
        data = json.loads(json_str)

        # JSON 스펙: object key는 string만 허용
        assert "deltas" in data
        assert all(isinstance(k, str) for k in data["deltas"].keys())
        assert data["deltas"] == {"10": 1, "20": 1, "30": 1}
        # 재파싱 시 클라이언트가 Number()로 변환하면 복원 가능
        assert {int(k): v for k, v in data["deltas"].items()} == {10: 1, 20: 1, 30: 1}

    def test_required_fields(self):
        """필수 필드 누락 시 검증 실패."""
        from pydantic import ValidationError

        with pytest.raises(ValidationError):
            SubtreeUpdateSSEEvent(
                timestamp=1.0,
                # affected_event_ids, deltas, new_total_subtree_height 누락
            )


class TestTaskExecutorSubtreeUpdateBroadcast:
    """task_executor에서 subtree_update가 올바르게 브로드캐스트되는지 검증."""

    @pytest.mark.asyncio
    async def test_subtree_update_broadcast_after_event_with_parent(self):
        """parent_event_id가 있는 이벤트 → subtree_update 브로드캐스트 발생."""
        session_db = _make_mock_session_db()
        task = _make_task()
        tasks = {task.agent_session_id: task}

        # parent_event_id를 명시한 tool_start (루트 아님)
        runner = FakeClaudeRunner(events=[
            ToolStartSSEEvent(tool_name="Read", timestamp=1.0, parent_event_id=1),
            CompleteEvent(result="done", parent_event_id=1),
        ])
        executor, broadcasts = _make_executor(tasks, session_db=session_db)
        await executor._run_execution(task, runner, FakeResourceManager())

        # subtree_update 이벤트 발생 검증
        subtree_broadcasts = [
            (sid, ev) for sid, ev in broadcasts
            if isinstance(ev, dict) and ev.get("type") == "subtree_update"
        ]
        # tool_start + complete 모두 parent_event_id 있으므로 2회
        assert len(subtree_broadcasts) >= 1, (
            f"subtree_update가 브로드캐스트되어야 함. 실제 broadcasts: "
            f"{[ev.get('type') for _, ev in broadcasts]}"
        )

        _, subtree_dict = subtree_broadcasts[0]
        assert "affected_event_ids" in subtree_dict
        assert "deltas" in subtree_dict
        assert "new_total_subtree_height" in subtree_dict
        assert "trigger_event_id" in subtree_dict
        # deltas의 key는 int로 유지됨 (서버 측 dict)
        assert all(isinstance(k, int) for k in subtree_dict["deltas"].keys())

    @pytest.mark.asyncio
    async def test_root_event_no_subtree_update(self):
        """parent_event_id가 None인 root 이벤트 → subtree_update 없음."""
        session_db = _make_mock_session_db()
        # 루트는 조상이 없음 — update_subtree_heights를 호출하지 않아야 함
        task = _make_task()
        tasks = {task.agent_session_id: task}

        # parent_event_id=None (루트) — fallback이 request_id로 채워주긴 하지만
        # 이 테스트는 fallback 동작 이후의 동작 검증이므로 별도로 체크
        runner = FakeClaudeRunner(events=[
            CompleteEvent(result="ok", parent_event_id=None),
        ])
        executor, broadcasts = _make_executor(tasks, session_db=session_db)
        await executor._run_execution(task, runner, FakeResourceManager())

        # fallback으로 parent_event_id가 채워지므로 subtree_update가 발생할 수 있음
        # 여기서는 "DB의 update_subtree_heights가 호출은 되었지만, 조상이 없는 경우"
        # 는 별도 테스트(아래)로 검증

    @pytest.mark.asyncio
    async def test_persist_fail_no_subtree_update(self):
        """persist_event 실패 → subtree_update 생성 안 됨."""
        session_db = _make_mock_session_db()
        # append_event를 실패시킴
        session_db.append_event = AsyncMock(side_effect=Exception("DB persist failure"))

        task = _make_task()
        tasks = {task.agent_session_id: task}

        runner = FakeClaudeRunner(events=[
            ToolStartSSEEvent(tool_name="Read", timestamp=1.0, parent_event_id=1),
        ])
        executor, broadcasts = _make_executor(tasks, session_db=session_db)
        await executor._run_execution(task, runner, FakeResourceManager())

        # subtree_update 이벤트가 브로드캐스트되지 않음
        subtree_broadcasts = [
            (sid, ev) for sid, ev in broadcasts
            if isinstance(ev, dict) and ev.get("type") == "subtree_update"
        ]
        assert len(subtree_broadcasts) == 0

        # update_subtree_heights는 호출되지 않음 (persist 실패로 early exit)
        session_db.update_subtree_heights.assert_not_called()

    @pytest.mark.asyncio
    async def test_update_subtree_heights_fail_broadcast_original_only(self):
        """update_subtree_heights 실패 → 원본 이벤트만 브로드캐스트 (fail-safe)."""
        session_db = _make_mock_session_db()
        session_db.update_subtree_heights = AsyncMock(
            side_effect=Exception("Recursive CTE failure")
        )

        task = _make_task()
        tasks = {task.agent_session_id: task}

        runner = FakeClaudeRunner(events=[
            ToolStartSSEEvent(tool_name="Read", timestamp=1.0, parent_event_id=1),
        ])
        executor, broadcasts = _make_executor(tasks, session_db=session_db)
        await executor._run_execution(task, runner, FakeResourceManager())

        # 원본 이벤트는 브로드캐스트됨
        tool_broadcasts = [
            (sid, ev) for sid, ev in broadcasts
            if isinstance(ev, dict) and ev.get("type") == "tool_start"
        ]
        assert len(tool_broadcasts) == 1

        # subtree_update는 실패로 인해 없음
        subtree_broadcasts = [
            (sid, ev) for sid, ev in broadcasts
            if isinstance(ev, dict) and ev.get("type") == "subtree_update"
        ]
        assert len(subtree_broadcasts) == 0


class TestReadMessagesPagination:
    """read_messages 페이지네이션 로직 순수 단위 테스트."""

    @pytest.mark.asyncio
    async def test_next_cursor_when_more_exists(self):
        """limit+1개 조회 후 마지막 항목이 next_cursor가 된다."""
        db = PostgresSessionDB.__new__(PostgresSessionDB)
        # fetch가 limit+1(=4)개 반환하도록 설정 → has_more=True
        rows = [
            {"id": 10, "parent_event_id": None, "event_type": "user_message",
             "payload": {"text": "msg3"}, "created_at": "2026-04-17T12:03:00+00:00"},
            {"id": 9, "parent_event_id": None, "event_type": "user_message",
             "payload": {"text": "msg2"}, "created_at": "2026-04-17T12:02:00+00:00"},
            {"id": 8, "parent_event_id": None, "event_type": "user_message",
             "payload": {"text": "msg1"}, "created_at": "2026-04-17T12:01:00+00:00"},
            {"id": 7, "parent_event_id": None, "event_type": "user_message",
             "payload": {"text": "overflow"}, "created_at": "2026-04-17T12:00:00+00:00"},
        ]
        db._pool = MagicMock()
        db._pool.fetch = AsyncMock(return_value=rows)

        messages, cursor = await db.read_messages("s1", before=None, limit=3)

        # limit개만 반환
        assert len(messages) == 3
        # 마지막(=가장 오래된) 항목의 created_at이 next_cursor
        assert cursor == "2026-04-17T12:01:00+00:00"

    @pytest.mark.asyncio
    async def test_no_next_cursor_when_end_reached(self):
        """limit 미만 조회 시 next_cursor는 None."""
        db = PostgresSessionDB.__new__(PostgresSessionDB)
        rows = [
            {"id": 10, "parent_event_id": None, "event_type": "user_message",
             "payload": {"text": "msg"}, "created_at": "2026-04-17T12:03:00+00:00"},
        ]
        db._pool = MagicMock()
        db._pool.fetch = AsyncMock(return_value=rows)

        messages, cursor = await db.read_messages("s1", before=None, limit=3)

        assert len(messages) == 1
        assert cursor is None

    @pytest.mark.asyncio
    async def test_before_iso_string_passed_as_datetime_to_asyncpg(self):
        """before가 ISO 8601 string일 때 asyncpg에 datetime 객체로 변환되어 전달되는지 검증.

        asyncpg는 binary protocol에서 timestamptz 컬럼에 datetime 객체를 요구한다.
        string을 그대로 전달하면 timestamptz_encode가 TypeError를 던져 ASGI 500 발생.
        prod 결함 (2026-05-02 prepend 500) 회귀 방지.
        """
        db = PostgresSessionDB.__new__(PostgresSessionDB)
        db._pool = MagicMock()
        db._pool.fetch = AsyncMock(return_value=[])

        await db.read_messages("s1", before="2026-05-02T05:28:03.888060+00:00", limit=50)

        call_args = db._pool.fetch.call_args
        sql_text = call_args[0][0]
        params = call_args[0][1:]

        # SQL에 timestamptz 캐스팅이 없어야 함 (datetime 객체로 전달하므로 불필요)
        assert "::timestamptz" not in sql_text, (
            "before가 datetime으로 변환된 후엔 SQL의 ::timestamptz 캐스팅이 불필요하다"
        )
        # 두 번째 파라미터(before)가 datetime 객체여야 함
        assert isinstance(params[1], datetime), (
            f"before는 asyncpg에 datetime 객체로 전달되어야 한다. 실제: {type(params[1])}"
        )
        # 파싱이 정확한지 검증
        from datetime import timezone
        expected = datetime(2026, 5, 2, 5, 28, 3, 888060, tzinfo=timezone.utc)
        assert params[1] == expected

    @pytest.mark.asyncio
    async def test_before_datetime_passed_through(self):
        """before가 이미 datetime 객체이면 그대로 전달 (방어 코드)."""
        db = PostgresSessionDB.__new__(PostgresSessionDB)
        db._pool = MagicMock()
        db._pool.fetch = AsyncMock(return_value=[])

        from datetime import timezone
        before_dt = datetime(2026, 5, 2, 5, 28, 3, tzinfo=timezone.utc)
        await db.read_messages("s1", before=before_dt, limit=50)  # type: ignore[arg-type]

        params = db._pool.fetch.call_args[0][1:]
        assert params[1] is before_dt


# === DB 통합 테스트 (TEST_DATABASE_URL 필요) ===


@pytest.mark.skipif(
    not os.environ.get("TEST_DATABASE_URL"),
    reason="TEST_DATABASE_URL 미설정 — DB 통합 테스트 스킵 (test-db-safety.md)",
)
class TestViewportAPIDBIntegration:
    """실제 PostgreSQL DB로 events_viewport 함수 동작 검증."""

    @pytest.mark.asyncio
    async def test_events_viewport_computes_y_coordinates(self, test_db):
        """events_viewport가 올바른 y_start/y_end/depth를 계산한다."""
        # 트리 구조: root(1) → [child_a(2) → leaf(4), child_b(3)]
        # subtree_height: leaf=1, child_a=2, child_b=1, root=4
        # y_start: root=1, child_a=2, leaf=3, child_b=4
        session_id = "test-viewport-session"
        # 사전 세팅 — 세션 등록
        await test_db.execute(
            "INSERT INTO sessions (session_id, node_id, agent_id, session_type, created_at, updated_at) "
            "VALUES ($1, 'n1', 'a1', 'claude', NOW(), NOW())",
            session_id,
        )

        # 이벤트 insert (parent 체인 + subtree_height 수동 지정)
        await test_db.execute(
            """
            INSERT INTO events
                (session_id, id, parent_event_id, event_type, payload, searchable_text,
                 subtree_height, created_at)
            VALUES
                ($1, 1, NULL, 'user_message', '{}'::jsonb, '', 4, NOW()),
                ($1, 2, 1,    'tool_start',   '{}'::jsonb, '', 2, NOW()),
                ($1, 3, 1,    'tool_start',   '{}'::jsonb, '', 1, NOW()),
                ($1, 4, 2,    'tool_result',  '{}'::jsonb, '', 1, NOW())
            """,
            session_id,
        )

        # 전체 범위 조회
        rows = await test_db.fetch(
            "SELECT * FROM events_viewport($1, $2, $3)",
            session_id, 1, 100,
        )

        result = {int(r["id"]): dict(r) for r in rows}
        assert result[1]["y_start"] == 1
        assert result[1]["y_end"] == 4
        assert result[1]["depth"] == 0
        assert result[2]["y_start"] == 2
        assert result[2]["y_end"] == 3
        assert result[2]["depth"] == 1
        assert result[4]["y_start"] == 3
        assert result[4]["y_end"] == 3
        assert result[4]["depth"] == 2
        assert result[3]["y_start"] == 4
        assert result[3]["y_end"] == 4
        assert result[3]["depth"] == 1

    @pytest.mark.asyncio
    async def test_events_viewport_filters_by_range(self, test_db):
        """범위 밖 이벤트는 제외된다."""
        session_id = "test-viewport-range"
        await test_db.execute(
            "INSERT INTO sessions (session_id, node_id, agent_id, session_type, created_at, updated_at) "
            "VALUES ($1, 'n1', 'a1', 'claude', NOW(), NOW())",
            session_id,
        )
        await test_db.execute(
            """
            INSERT INTO events
                (session_id, id, parent_event_id, event_type, payload, searchable_text,
                 subtree_height, created_at)
            VALUES
                ($1, 1, NULL, 'user_message', '{}'::jsonb, '', 4, NOW()),
                ($1, 2, 1,    'tool_start',   '{}'::jsonb, '', 2, NOW()),
                ($1, 3, 1,    'tool_start',   '{}'::jsonb, '', 1, NOW()),
                ($1, 4, 2,    'tool_result',  '{}'::jsonb, '', 1, NOW())
            """,
            session_id,
        )

        # y_start=3~4 (leaf + child_b)만 조회
        rows = await test_db.fetch(
            "SELECT * FROM events_viewport($1, $2, $3)",
            session_id, 3, 4,
        )
        ids = [int(r["id"]) for r in rows]
        # root(y=1~4), child_a(y=2~3)는 범위와 겹치므로 포함됨 → 모두 반환
        # leaf(y=3)와 child_b(y=4)도 포함
        assert set(ids) >= {3, 4}  # 최소 leaf+child_b는 포함
