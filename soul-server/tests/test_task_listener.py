"""
test_task_listener - TaskListenerManager 유닛 테스트

broadcast() 정상 동작, QueueFull → dead listener 제거,
세션 없음 시 0 반환을 검증한다.
"""

import asyncio
import pytest

from soul_server.service.task_listener import TaskListenerManager
from soul_server.service.task_models import Task


def _make_task(session_id: str) -> Task:
    """테스트용 Task 인스턴스 생성."""
    return Task(agent_session_id=session_id, prompt="test")


class TestBroadcastNormal:
    """broadcast() 정상 동작 시나리오."""

    async def test_event_received_by_listener(self):
        """리스너 큐에 이벤트가 정상적으로 전달된다."""
        tasks = {"sess-1": _make_task("sess-1")}
        manager = TaskListenerManager(tasks)
        q = asyncio.Queue()
        await manager.add_listener("sess-1", q)

        event = {"type": "text", "data": "hello"}
        count = await manager.broadcast("sess-1", event)

        assert count == 1
        received = q.get_nowait()
        assert received == event

    async def test_multiple_listeners_all_receive(self):
        """여러 리스너가 모두 이벤트를 수신한다."""
        tasks = {"sess-1": _make_task("sess-1")}
        manager = TaskListenerManager(tasks)
        q1, q2, q3 = asyncio.Queue(), asyncio.Queue(), asyncio.Queue()
        await manager.add_listener("sess-1", q1)
        await manager.add_listener("sess-1", q2)
        await manager.add_listener("sess-1", q3)

        count = await manager.broadcast("sess-1", {"type": "ping"})

        assert count == 3
        for q in [q1, q2, q3]:
            assert not q.empty()

    async def test_session_not_found_returns_zero(self):
        """세션이 없으면 0을 반환하고 예외를 발생시키지 않는다."""
        manager = TaskListenerManager({})

        count = await manager.broadcast("nonexistent", {"type": "ping"})

        assert count == 0

    async def test_no_listeners_returns_zero(self):
        """리스너가 없는 세션에 브로드캐스트하면 0을 반환한다."""
        tasks = {"sess-1": _make_task("sess-1")}
        manager = TaskListenerManager(tasks)

        count = await manager.broadcast("sess-1", {"type": "ping"})

        assert count == 0


class TestBroadcastDeadListenerCleanup:
    """QueueFull dead listener 처리 시나리오.

    현재 코드(await queue.put())는 큐가 가득 찼을 때 무기한 블로킹된다.
    asyncio.wait_for(timeout=2.0)으로 블로킹을 검출한다:
      - RED (현재): asyncio.TimeoutError → 테스트 FAIL
      - GREEN (Phase 1 이후): 즉시 완료 → 테스트 PASS

    Windows에서 pytest-timeout의 thread 방식이 프로세스를 종료시키는 이슈를 피하기 위해
    asyncio.wait_for를 사용한다.
    """

    async def test_full_queue_dead_listener_removed(self):
        """큐가 가득 찬 dead listener는 broadcast() 후 목록에서 제거된다.

        현재 코드: await queue.put()이 무기한 블로킹 → asyncio.TimeoutError (RED).
        Phase 1 수정 후: put_nowait()가 QueueFull을 즉시 감지하고 dead_q 제거 (GREEN).
        """
        tasks = {"sess-1": _make_task("sess-1")}
        manager = TaskListenerManager(tasks)

        dead_q = asyncio.Queue(maxsize=1)
        dead_q.put_nowait({"type": "existing"})  # 이미 가득 참
        await manager.add_listener("sess-1", dead_q)

        # 현재 코드: asyncio.TimeoutError (RED) → Phase 1 수정 후 즉시 완료 (GREEN)
        await asyncio.wait_for(
            manager.broadcast("sess-1", {"type": "new_event"}),
            timeout=2.0,
        )

        task = tasks["sess-1"]
        assert dead_q not in task.listeners

    async def test_healthy_listener_kept_when_dead_listener_present(self):
        """dead listener가 있어도 정상 리스너는 유지된다.

        현재 코드: dead_q의 await queue.put()에서 블로킹 → asyncio.TimeoutError (RED).
        Phase 1 수정 후: healthy_q는 이벤트 수신, dead_q는 제거 (GREEN).
        """
        tasks = {"sess-1": _make_task("sess-1")}
        manager = TaskListenerManager(tasks)

        healthy_q = asyncio.Queue()
        dead_q = asyncio.Queue(maxsize=1)
        dead_q.put_nowait({"type": "blocking"})  # 가득 참

        await manager.add_listener("sess-1", healthy_q)
        await manager.add_listener("sess-1", dead_q)

        # 현재 코드: asyncio.TimeoutError (RED) → Phase 1 수정 후 즉시 완료 (GREEN)
        await asyncio.wait_for(
            manager.broadcast("sess-1", {"type": "event"}),
            timeout=2.0,
        )

        task = tasks["sess-1"]
        assert healthy_q in task.listeners
        assert dead_q not in task.listeners
        assert not healthy_q.empty()


class TestAddRemoveListener:
    """add_listener / remove_listener 기본 동작."""

    async def test_add_listener_returns_true_for_existing_session(self):
        """존재하는 세션에 리스너를 추가하면 True를 반환한다."""
        tasks = {"sess-1": _make_task("sess-1")}
        manager = TaskListenerManager(tasks)
        q = asyncio.Queue()

        result = await manager.add_listener("sess-1", q)

        assert result is True
        assert q in tasks["sess-1"].listeners

    async def test_add_listener_returns_false_for_missing_session(self):
        """존재하지 않는 세션에 리스너를 추가하면 False를 반환한다."""
        manager = TaskListenerManager({})
        q = asyncio.Queue()

        result = await manager.add_listener("nonexistent", q)

        assert result is False

    async def test_remove_listener_removes_from_list(self):
        """리스너를 제거하면 목록에서 사라진다."""
        tasks = {"sess-1": _make_task("sess-1")}
        manager = TaskListenerManager(tasks)
        q = asyncio.Queue()
        await manager.add_listener("sess-1", q)
        assert q in tasks["sess-1"].listeners

        await manager.remove_listener("sess-1", q)

        assert q not in tasks["sess-1"].listeners

    async def test_remove_nonexistent_listener_is_safe(self):
        """존재하지 않는 리스너 제거는 예외를 발생시키지 않는다."""
        tasks = {"sess-1": _make_task("sess-1")}
        manager = TaskListenerManager(tasks)
        q = asyncio.Queue()

        # q가 listeners에 없는 상태에서 remove 호출
        await manager.remove_listener("sess-1", q)  # should not raise
