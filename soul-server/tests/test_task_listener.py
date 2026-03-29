"""
test_task_listener - TaskListenerManager 유닛 테스트

session_id → list[Queue] 레지스트리 기반 설계를 검증한다.
Task 생명주기(evict/resume)와 독립적으로 동작한다.
"""

import asyncio
import pytest

from soul_server.service.task_listener import TaskListenerManager


class TestBroadcastNormal:
    """broadcast() 정상 동작 시나리오."""

    async def test_event_received_by_listener(self):
        """리스너 큐에 이벤트가 정상적으로 전달된다."""
        manager = TaskListenerManager()
        q = asyncio.Queue()
        await manager.add_listener("sess-1", q)

        event = {"type": "text", "data": "hello"}
        count = await manager.broadcast("sess-1", event)

        assert count == 1
        received = q.get_nowait()
        assert received == event

    async def test_session_not_in_tasks_still_delivers(self):
        """핵심: Task가 없어도 add_listener 성공 → broadcast 전달."""
        manager = TaskListenerManager()
        q = asyncio.Queue()
        # Task 없이 add_listener
        await manager.add_listener("evicted-session", q)
        # 이후 broadcast → 큐에 이벤트 도달해야 함
        count = await manager.broadcast("evicted-session", {"type": "resumed"})
        assert count == 1
        assert not q.empty()

    async def test_multiple_listeners_all_receive(self):
        """여러 리스너가 모두 이벤트를 수신한다."""
        manager = TaskListenerManager()
        q1, q2, q3 = asyncio.Queue(), asyncio.Queue(), asyncio.Queue()
        await manager.add_listener("sess-1", q1)
        await manager.add_listener("sess-1", q2)
        await manager.add_listener("sess-1", q3)

        count = await manager.broadcast("sess-1", {"type": "ping"})

        assert count == 3
        for q in [q1, q2, q3]:
            assert not q.empty()

    async def test_no_listeners_returns_zero(self):
        """리스너가 없는 세션에 브로드캐스트하면 0을 반환한다."""
        manager = TaskListenerManager()

        count = await manager.broadcast("nonexistent", {"type": "ping"})

        assert count == 0


class TestBroadcastDeadListenerCleanup:
    """QueueFull dead listener 자동 정리 시나리오."""

    async def test_full_queue_dead_listener_removed(self):
        """큐가 가득 찬 dead listener는 broadcast() 후 manager._listeners에서 제거된다."""
        manager = TaskListenerManager()
        dead_q = asyncio.Queue(maxsize=1)
        dead_q.put_nowait({"type": "existing"})  # 이미 가득 참
        await manager.add_listener("sess-1", dead_q)

        await asyncio.wait_for(
            manager.broadcast("sess-1", {"type": "new_event"}),
            timeout=2.0,
        )

        assert dead_q not in manager._listeners.get("sess-1", [])

    async def test_healthy_listener_kept_when_dead_listener_present(self):
        """dead listener가 있어도 정상 리스너는 유지되고 이벤트를 수신한다."""
        manager = TaskListenerManager()
        healthy_q = asyncio.Queue()
        dead_q = asyncio.Queue(maxsize=1)
        dead_q.put_nowait({"type": "blocking"})  # 가득 참

        await manager.add_listener("sess-1", healthy_q)
        await manager.add_listener("sess-1", dead_q)

        await asyncio.wait_for(
            manager.broadcast("sess-1", {"type": "event"}),
            timeout=2.0,
        )

        assert healthy_q in manager._listeners.get("sess-1", [])
        assert dead_q not in manager._listeners.get("sess-1", [])
        assert not healthy_q.empty()


class TestAddRemoveListener:
    """add_listener / remove_listener 기본 동작."""

    async def test_add_listener_always_succeeds(self):
        """Task 없이도 add_listener 성공 (반환값 없음)."""
        manager = TaskListenerManager()
        q = asyncio.Queue()
        await manager.add_listener("any-session", q)  # 예외 없음
        assert q in manager._listeners["any-session"]

    async def test_add_listener_multiple_sessions(self):
        """서로 다른 세션에 리스너를 추가하면 각각 분리된 목록에 등록된다."""
        manager = TaskListenerManager()
        q1, q2 = asyncio.Queue(), asyncio.Queue()
        await manager.add_listener("sess-1", q1)
        await manager.add_listener("sess-2", q2)
        assert q1 in manager._listeners["sess-1"]
        assert q2 in manager._listeners["sess-2"]
        assert q1 not in manager._listeners.get("sess-2", [])

    async def test_remove_listener_removes_from_registry(self):
        """리스너를 제거하면 _listeners 레지스트리에서 사라진다."""
        manager = TaskListenerManager()
        q = asyncio.Queue()
        await manager.add_listener("sess-1", q)
        await manager.remove_listener("sess-1", q)
        assert q not in manager._listeners.get("sess-1", [])

    async def test_remove_nonexistent_listener_is_safe(self):
        """존재하지 않는 리스너/세션 제거는 예외를 발생시키지 않는다."""
        manager = TaskListenerManager()
        q = asyncio.Queue()
        await manager.remove_listener("nonexistent", q)  # should not raise

    async def test_remove_listener_from_wrong_session_is_safe(self):
        """다른 세션의 큐를 제거 시도해도 예외 없이 무시한다."""
        manager = TaskListenerManager()
        q = asyncio.Queue()
        await manager.add_listener("sess-1", q)
        await manager.remove_listener("sess-2", q)  # should not raise
        assert q in manager._listeners["sess-1"]  # sess-1에는 그대로
