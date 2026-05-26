"""Task Tree API regression tests."""

import re
from datetime import datetime, timezone

import pytest

from soulstream_server.api.tasks import (
    ArchiveRequest,
    CreateTaskRequest,
    HoldRequest,
    LinkRequest,
    MoveRequest,
    PinRequest,
    StatusRequest,
    create_tasks_router,
)


def _task_row(**overrides):
    base = {
        "id": "task-1",
        "parent_id": None,
        "position_key": 1.0,
        "title": "Child task",
        "description": "",
        "acceptance_criteria": "",
        "verification_owner": "agent",
        "status": "in_progress",
        "linked_session_id": "child-session",
        "linked_node_id": "node-child",
        "active_for_session_id": "child-session",
        "created_from_session_id": "parent-session",
        "created_from_event_id": 55,
        "navigation_session_id": "child-session",
        "navigation_node_id": "node-child",
        "navigation_event_id": 77,
        "archived": False,
        "pinned": False,
        "version": 1,
        "created_at": datetime(2026, 5, 26, tzinfo=timezone.utc),
        "updated_at": datetime(2026, 5, 26, tzinfo=timezone.utc),
    }
    base.update(overrides)
    return base


class FakeTaskPool:
    def __init__(self):
        self.task = _task_row()
        self.operation = {
            "id": "operation-1",
            "task_id": "task-1",
            "operation_type": "set_task_status",
            "actor_kind": "agent",
            "actor_session_id": "parent-session",
            "actor_event_id": None,
            "actor_user_id": None,
            "idempotency_key": None,
            "payload_json": {},
            "reason": None,
            "created_at": datetime(2026, 5, 26, tzinfo=timezone.utc),
        }

    async def fetchrow(self, query, *args):
        normalized = " ".join(str(query).split())
        if "SELECT * FROM task_operations WHERE idempotency_key" in normalized:
            return None
        if "INSERT INTO task_items" in normalized:
            self.task = _task_row(
                id=args[0],
                parent_id=args[1],
                position_key=args[2],
                title=args[3],
                description=args[4],
                acceptance_criteria=args[5],
                verification_owner=args[6],
                status=args[7],
                linked_session_id=args[8],
                linked_node_id=args[9],
                active_for_session_id=args[10],
                created_from_session_id=args[11],
                navigation_session_id=args[12],
                navigation_node_id=args[13],
                navigation_event_id=args[14],
            )
            return self.task
        if "INSERT INTO task_operations" in normalized:
            self.operation = {
                **self.operation,
                "id": args[0],
                "task_id": args[1],
                "operation_type": args[2],
                "actor_session_id": args[3],
                "idempotency_key": args[4],
                "payload_json": args[5],
                "reason": args[6],
            }
            return self.operation
        if "UPDATE task_operations SET actor_event_id" in normalized:
            self.operation = {**self.operation, "actor_event_id": args[0]}
            return self.operation
        if "UPDATE task_items" in normalized:
            assignments = re.findall(r"([a-z_]+) = \$\d+", normalized.split(" updated_at = NOW()")[0])
            for key, value in zip(assignments, args[2:]):
                self.task[key] = value
            self.task["version"] += 1
            return self.task
        if "SELECT * FROM task_items WHERE id" in normalized:
            return self.task
        raise AssertionError(f"unhandled fetchrow query: {normalized}")

    async def fetchval(self, query, *args):
        normalized = " ".join(str(query).split())
        if "SELECT EXISTS" in normalized:
            return False
        return 2.0


class FakeTaskDB:
    def __init__(self):
        self.pool = FakeTaskPool()

    async def append_event(self, *args):
        return 101


def _endpoint(path: str, method: str = "POST"):
    router = create_tasks_router(FakeTaskDB())
    return next(
        route.endpoint
        for route in router.routes
        if getattr(route, "path", "") == path
        and method in getattr(route, "methods", set())
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("path", "body"),
    [
        (
            "/api/tasks/{task_id}/status",
            StatusRequest(sessionId="parent-session", status="agent_done"),
        ),
        (
            "/api/tasks/{task_id}/move",
            MoveRequest(
                sessionId="parent-session",
                newParentTaskId="new-parent",
                positionKey=2.0,
            ),
        ),
        (
            "/api/tasks/{task_id}/archive",
            ArchiveRequest(sessionId="parent-session"),
        ),
        (
            "/api/tasks/{task_id}/pin",
            PinRequest(sessionId="parent-session", pinned=True),
        ),
        (
            "/api/tasks/{task_id}/hold",
            HoldRequest(sessionId="parent-session"),
        ),
    ],
)
async def test_mutation_operations_preserve_navigation_anchor(path, body):
    endpoint = _endpoint(path)

    result = await endpoint("task-1", body)

    assert result["task"]["navigationSessionId"] == "child-session"
    assert result["task"]["navigationNodeId"] == "node-child"
    assert result["task"]["navigationEventId"] == 77
    assert result["operation"]["actorEventId"] == 101


@pytest.mark.asyncio
async def test_link_without_navigation_event_targets_linked_session_top():
    endpoint = _endpoint("/api/tasks/{task_id}/link")

    result = await endpoint(
        "task-1",
        LinkRequest(
            sessionId="parent-session",
            linkedSessionId="linked-session",
            linkedNodeId="node-linked",
        ),
    )

    assert result["task"]["linkedSessionId"] == "linked-session"
    assert result["task"]["navigationSessionId"] == "linked-session"
    assert result["task"]["navigationNodeId"] == "node-linked"
    assert result["task"]["navigationEventId"] is None


@pytest.mark.asyncio
async def test_create_with_linked_session_defaults_navigation_to_linked_session_top():
    endpoint = _endpoint("/api/tasks", method="POST")

    result = await endpoint(
        CreateTaskRequest(
            sessionId="parent-session",
            title="Completed historical task",
            status="verified_done",
            linkedSessionId="historical-session",
            linkedNodeId="node-linked",
        ),
    )

    assert result["task"]["linkedSessionId"] == "historical-session"
    assert result["task"]["navigationSessionId"] == "historical-session"
    assert result["task"]["navigationNodeId"] == "node-linked"
    assert result["task"]["navigationEventId"] is None
    assert result["task"]["createdFromEventId"] == 101
