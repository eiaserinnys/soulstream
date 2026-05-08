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


# Phase 2-B-1(2026-05-08): TestTaskExecutorSubtreeUpdateBroadcast 4개 테스트 폐기.
# subtree_update SSE 발신 자체가 폐기되어 회귀 의미가 사라졌다. 대체 회귀 보호는
# 아래 TestNoSubtreeUpdateAfterFlattening 3개 테스트가 담당한다 (broadcast 0회 보장 등).


class TestNoSubtreeUpdateAfterFlattening:
    """Phase 2-B-1 회귀 보호 — subtree_update 발신 + parent_event_id fallback 모두 제거됨.

    🔴 #1 (task_executor.py:207-209 fallback 채움 라인 제거)
    🔴 #2 (event_persistence.persist_with_subtree 메서드 폐기 + broadcast 분기 제거)
    """

    @pytest.mark.asyncio
    async def test_no_subtree_update_broadcast(self):
        """🔴 #2: 어떤 이벤트 입력에서도 broadcast에 subtree_update 0회."""
        session_db = _make_mock_session_db()
        task = _make_task()
        tasks = {task.agent_session_id: task}

        # parent_event_id를 명시한 tool_start (변경 전이라면 subtree_update가 broadcast됨)
        runner = FakeClaudeRunner(events=[
            ToolStartSSEEvent(tool_name="Read", timestamp=1.0, parent_event_id=1),
            CompleteEvent(result="done", parent_event_id=1),
        ])
        executor, broadcasts = _make_executor(tasks, session_db=session_db)
        await executor._run_execution(task, runner, FakeResourceManager())

        subtree = [
            ev for _, ev in broadcasts
            if isinstance(ev, dict) and ev.get("type") == "subtree_update"
        ]
        assert len(subtree) == 0, (
            f"subtree_update broadcast 0회여야 함. 실제 type 시퀀스: "
            f"{[ev.get('type') for _, ev in broadcasts if isinstance(ev, dict)]}"
        )

    @pytest.mark.asyncio
    async def test_parent_event_id_passes_through_unmodified(self):
        """🔴 #1: parent_event_id=None 입력 시 broadcast event_dict의 parent_event_id가 None 그대로.

        변경 전에는 fallback이 user_request_id로 채워서 None이 아닌 값이 됨.
        변경 후에는 None 그대로 passthrough.
        """
        session_db = _make_mock_session_db()
        task = _make_task()
        tasks = {task.agent_session_id: task}

        runner = FakeClaudeRunner(events=[
            CompleteEvent(result="ok", parent_event_id=None),
        ])
        executor, broadcasts = _make_executor(tasks, session_db=session_db)
        await executor._run_execution(task, runner, FakeResourceManager())

        complete_evs = [
            ev for _, ev in broadcasts
            if isinstance(ev, dict) and ev.get("type") == "complete"
        ]
        assert len(complete_evs) >= 1
        assert complete_evs[0].get("parent_event_id") is None, (
            f"parent_event_id가 None으로 송출되어야 함 (fallback 채움 폐기). "
            f"실제: {complete_evs[0].get('parent_event_id')!r}"
        )

    @pytest.mark.asyncio
    async def test_persist_event_id_injected(self):
        """🔴 #2 단순화 후: persist_event 결과로 event_dict[_event_id]·task.last_event_id 갱신.

        persist_with_subtree 폐기 후 _event_id 주입 + last_event_id 갱신 책임이
        task_executor inline으로 이동했음을 검증한다.
        """
        session_db = _make_mock_session_db()
        task = _make_task()
        tasks = {task.agent_session_id: task}

        runner = FakeClaudeRunner(events=[
            CompleteEvent(result="done", parent_event_id=None),
        ])
        executor, broadcasts = _make_executor(tasks, session_db=session_db)
        await executor._run_execution(task, runner, FakeResourceManager())

        complete_evs = [
            ev for _, ev in broadcasts
            if isinstance(ev, dict) and ev.get("type") == "complete"
        ]
        assert complete_evs and "_event_id" in complete_evs[0], (
            f"complete 이벤트에 _event_id가 주입되어야 함. 실제 keys: "
            f"{list(complete_evs[0].keys()) if complete_evs else 'no complete events'}"
        )
        assert task.last_event_id is not None, (
            f"task.last_event_id가 갱신되어야 함. 실제: {task.last_event_id!r}"
        )

    @pytest.mark.asyncio
    async def test_existing_parent_event_id_preserved_unchanged(self):
        """🔴 #1 보강: runner가 명시한 parent_event_id 값은 fallback에 의해 덮어쓰이지 않는다.

        Phase 2-B-1 이전 fallback은 None만 채웠지만, 폐기된 fallback이 *기존 값을 덮어쓰지
        않는다*는 invariant는 그대로 유지되어야 한다. 서브에이전트 블록(parent_event_id=명시값)이
        wire에 그대로 전달되어 향후 다른 wire 컨슈머가 활용할 수 있다.
        """
        session_db = _make_mock_session_db()
        task = _make_task()
        tasks = {task.agent_session_id: task}

        runner = FakeClaudeRunner(events=[
            ToolStartSSEEvent(tool_name="Read", timestamp=1.0, parent_event_id=42),
        ])
        executor, broadcasts = _make_executor(tasks, session_db=session_db)
        await executor._run_execution(task, runner, FakeResourceManager())

        tool_evs = [
            ev for _, ev in broadcasts
            if isinstance(ev, dict) and ev.get("type") == "tool_start"
        ]
        assert len(tool_evs) == 1
        assert tool_evs[0].get("parent_event_id") == 42, (
            f"명시된 parent_event_id=42가 그대로 broadcast되어야 함. "
            f"실제: {tool_evs[0].get('parent_event_id')!r}"
        )


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
        db._pool.fetchval = AsyncMock(return_value=1)  # root_count

        messages, cursor = await db.read_messages("s1", before=None, limit=3)

        # limit개만 반환 (ancestor 추가 가능하나 parent_event_id=None → missing_parents 없음)
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
        db._pool.fetchval = AsyncMock(return_value=1)

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
        db._pool.fetchval = AsyncMock(return_value=1)

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
        db._pool.fetchval = AsyncMock(return_value=1)

        from datetime import timezone
        before_dt = datetime(2026, 5, 2, 5, 28, 3, tzinfo=timezone.utc)
        await db.read_messages("s1", before=before_dt, limit=50)  # type: ignore[arg-type]

        params = db._pool.fetch.call_args[0][1:]
        assert params[1] is before_dt


class TestReadMessagesAncestor:
    """read_messages ancestor 보강 단위 테스트."""

    def _make_db(self, page_rows, ancestor_rows=None, root_count=1):
        """read_messages 테스트용 mock DB를 구성한다."""
        db = PostgresSessionDB.__new__(PostgresSessionDB)
        db._pool = MagicMock()

        fetch_calls = [page_rows]
        if ancestor_rows is not None:
            fetch_calls.append(ancestor_rows)

        db._pool.fetch = AsyncMock(side_effect=fetch_calls)
        db._pool.fetchval = AsyncMock(return_value=root_count)
        return db

    @pytest.mark.asyncio
    async def test_includes_ancestors(self):
        """부모가 페이지 밖에 있으면 ancestor가 응답에 포함된다."""
        # 페이지: child(id=10, parent=5) — 부모 5는 페이지에 없음
        page_rows = [
            {"id": 10, "parent_event_id": 5, "event_type": "tool_start",
             "payload": {"type": "tool_start"}, "created_at": "2026-05-02T12:10:00+00:00"},
        ]
        # ancestor: parent(id=5)
        ancestor_rows = [
            {"id": 5, "parent_event_id": None, "event_type": "user_message",
             "payload": {"type": "user_message"}, "created_at": "2026-05-02T12:05:00+00:00"},
        ]
        db = self._make_db(page_rows, ancestor_rows)

        messages, cursor = await db.read_messages("s1", before=None, limit=50)

        # ancestor(id=5)가 포함되어야 함
        ids = [m["id"] for m in messages]
        assert 5 in ids
        assert 10 in ids
        # DESC 순서: 10이 먼저, 5가 나중 (어댑터가 reverse→ASC하면 5→10)
        assert ids.index(10) < ids.index(5)

    @pytest.mark.asyncio
    async def test_next_cursor_excludes_ancestors(self):
        """next_cursor는 페이지 이벤트 기준이며 ancestor를 포함하지 않는다."""
        # 4개 반환 (limit=3이므로 has_more=True, page_rows=3개)
        page_rows = [
            {"id": 10, "parent_event_id": 5, "event_type": "tool_start",
             "payload": {}, "created_at": "2026-05-02T12:10:00+00:00"},
            {"id": 9, "parent_event_id": 5, "event_type": "text_start",
             "payload": {}, "created_at": "2026-05-02T12:09:00+00:00"},
            {"id": 8, "parent_event_id": 5, "event_type": "text_delta",
             "payload": {}, "created_at": "2026-05-02T12:08:00+00:00"},
            {"id": 7, "parent_event_id": 5, "event_type": "progress",
             "payload": {}, "created_at": "2026-05-02T12:07:00+00:00"},
        ]
        ancestor_rows = [
            {"id": 5, "parent_event_id": None, "event_type": "user_message",
             "payload": {}, "created_at": "2026-05-02T12:05:00+00:00"},
        ]
        db = self._make_db(page_rows, ancestor_rows)

        messages, cursor = await db.read_messages("s1", before=None, limit=3)

        # cursor는 페이지 마지막(id=8)의 created_at — ancestor(id=5)가 아님
        assert cursor == "2026-05-02T12:08:00+00:00"

    @pytest.mark.asyncio
    async def test_multi_root_warning(self, caplog):
        """parent_event_id IS NULL이 2개 이상이면 경고 로그를 남긴다."""
        page_rows = [
            {"id": 10, "parent_event_id": None, "event_type": "user_message",
             "payload": {}, "created_at": "2026-05-02T12:10:00+00:00"},
        ]
        db = self._make_db(page_rows, root_count=3)

        with caplog.at_level(logging.WARNING):
            await db.read_messages("s1", before=None, limit=50)

        assert any("3 root events" in r.message for r in caplog.records)

    @pytest.mark.asyncio
    async def test_orphaned_parent_warning(self, caplog):
        """parent_event_id가 가리키는 행이 DB에 없으면 경고 로그를 남긴다."""
        page_rows = [
            {"id": 10, "parent_event_id": 999, "event_type": "tool_start",
             "payload": {}, "created_at": "2026-05-02T12:10:00+00:00"},
        ]
        # ancestor fetch가 빈 배열 반환 → 999는 orphan
        ancestor_rows = []
        db = self._make_db(page_rows, ancestor_rows)

        with caplog.at_level(logging.WARNING):
            await db.read_messages("s1", before=None, limit=50)

        assert any("orphaned parent refs" in r.message for r in caplog.records)

    @pytest.mark.asyncio
    async def test_prepend_includes_ancestors(self):
        """before 커서로 두 번째 페이지 요청 시에도 ancestor가 동봉된다."""
        page_rows = [
            {"id": 20, "parent_event_id": 15, "event_type": "tool_result",
             "payload": {}, "created_at": "2026-05-02T12:20:00+00:00"},
        ]
        ancestor_rows = [
            {"id": 15, "parent_event_id": None, "event_type": "user_message",
             "payload": {}, "created_at": "2026-05-02T12:15:00+00:00"},
        ]
        db = self._make_db(page_rows, ancestor_rows)

        messages, cursor = await db.read_messages(
            "s1", before="2026-05-02T12:25:00+00:00", limit=50,
        )

        ids = [m["id"] for m in messages]
        assert 15 in ids, "prepend 페이지에도 ancestor가 동봉되어야 한다"
        assert 20 in ids


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
