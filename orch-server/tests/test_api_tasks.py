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
    UpdateTaskRequest,
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


def _session_row(**overrides):
    base = {
        "session_id": "child-session",
        "status": "running",
        "prompt": "Work on child task",
        "created_at": datetime(2026, 5, 26, tzinfo=timezone.utc),
        "updated_at": datetime(2026, 5, 26, tzinfo=timezone.utc),
        "session_type": "codex",
        "last_message": None,
        "client_id": None,
        "metadata": None,
        "display_name": "Child task session",
        "node_id": "node-child",
        "folder_id": None,
        "last_event_id": 10,
        "last_read_event_id": 0,
        "caller_session_id": "parent-session",
        "agent_id": "agent-child",
    }
    base.update(overrides)
    return base


class FakeNodeManager:
    def find_agent_profile(self, agent_id, node_id):
        if agent_id == "agent-child":
            return (
                {
                    "name": "Child Agent",
                    "backend": "codex",
                    "portrait_url": "/portrait.png",
                },
                node_id,
            )
        return None

    def get_user_info(self, node_id):
        return {}


class FakeTaskPool:
    def __init__(self):
        self.task = _task_row()
        self.session = _session_row()
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

    async def fetch(self, query, *args):
        normalized = " ".join(str(query).split())
        if "FROM task_items" in normalized:
            return [self.task]
        if "FROM sessions WHERE session_id = ANY" in normalized:
            return [self.session] if self.session["session_id"] in set(args[0]) else []
        raise AssertionError(f"unhandled fetch query: {normalized}")

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


def _endpoint(path: str, method: str = "POST", db=None, node_manager=None):
    router = create_tasks_router(db or FakeTaskDB(), node_manager=node_manager)
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
        (
            "/api/tasks/{task_id}",
            UpdateTaskRequest(
                sessionId="parent-session",
                title="Renamed task",
                description="New description",
                acceptanceCriteria="New criteria",
            ),
        ),
    ],
)
async def test_mutation_operations_preserve_navigation_anchor(path, body):
    method = "PATCH" if path == "/api/tasks/{task_id}" else "POST"
    endpoint = _endpoint(path, method=method)

    result = await endpoint("task-1", body)

    assert result["task"]["navigationSessionId"] == "child-session"
    assert result["task"]["navigationNodeId"] == "node-child"
    assert result["task"]["navigationEventId"] == 77
    assert result["operation"]["actorEventId"] == 101


@pytest.mark.asyncio
async def test_update_task_changes_only_editable_detail_fields():
    endpoint = _endpoint("/api/tasks/{task_id}", method="PATCH")

    result = await endpoint(
        "task-1",
        UpdateTaskRequest(
            sessionId="parent-session",
            title="  Renamed task  ",
            description="New description",
            acceptanceCriteria="New criteria",
        ),
    )

    assert result["task"]["title"] == "Renamed task"
    assert result["task"]["description"] == "New description"
    assert result["task"]["acceptanceCriteria"] == "New criteria"
    assert result["task"]["linkedSessionId"] == "child-session"
    assert result["operation"]["operationType"] == "update_task_item"


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


@pytest.mark.asyncio
async def test_list_tasks_embeds_linked_session_summary_for_unloaded_client_page():
    db = FakeTaskDB()
    endpoint = _endpoint("/api/tasks", method="GET", db=db, node_manager=FakeNodeManager())

    result = await endpoint(
        query=None,
        status=None,
        rootTaskId=None,
        linkedSessionId=None,
        includeArchived=False,
        limit=500,
    )

    task = result["tasks"][0]
    assert task["linkedSessionId"] == "child-session"
    assert task["linkedSession"]["agentSessionId"] == "child-session"
    assert task["linkedSession"]["nodeId"] == "node-child"
    assert task["linkedSession"]["agentId"] == "agent-child"
    assert task["linkedSession"]["agentName"] == "Child Agent"
    assert task["linkedSession"]["agentPortraitUrl"] == "/api/nodes/node-child/agents/agent-child/portrait"
