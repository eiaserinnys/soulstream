"""Tests for Sessions API (/api/sessions)."""

from datetime import datetime, timezone
from unittest.mock import AsyncMock

import pytest

from soulstream_server.api.task_scoped_sessions import existing_task_scoped_session_response


DEFAULT_AGENT_REGISTRATION = {
    "agents": [
        {
            "id": "default-agent",
            "name": "Default Agent",
            "backend": "claude",
        }
    ]
}


def _mock_session_owner(mock_db, node, session_id="test-session"):
    mock_db.get_session = AsyncMock(
        return_value={"session_id": session_id, "node_id": node.node_id}
    )


def _task_row(**overrides):
    base = {
        "id": "parent-task",
        "parent_id": None,
        "position_key": 1.0,
        "title": "Parent task",
        "description": "Parent description",
        "acceptance_criteria": "Parent criteria",
        "verification_owner": "both",
        "status": "verified_done",
        "linked_session_id": "parent-linked",
        "linked_node_id": "node-parent",
        "active_for_session_id": None,
        "created_from_session_id": "parent-session",
        "created_from_event_id": 10,
        "navigation_session_id": "parent-session",
        "navigation_node_id": "node-parent",
        "navigation_event_id": 11,
        "archived": False,
        "pinned": False,
        "version": 1,
        "created_at": datetime(2026, 5, 27, tzinfo=timezone.utc),
        "updated_at": datetime(2026, 5, 27, tzinfo=timezone.utc),
    }
    base.update(overrides)
    return base


class FakeTaskScopedPool:
    def __init__(self):
        self.parent = _task_row()
        self.child = None
        self.operation = None

    async def fetchrow(self, query, *args):
        normalized = " ".join(str(query).split())
        if "SELECT * FROM task_operations WHERE idempotency_key" in normalized:
            return None
        if "SELECT * FROM task_items WHERE id = $1 AND archived = FALSE" in normalized:
            return self.parent if args[0] == self.parent["id"] else None
        if "INSERT INTO task_items" in normalized:
            self.child = _task_row(
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
            return self.child
        if "INSERT INTO task_operations" in normalized:
            self.operation = {
                "id": args[0],
                "task_id": args[1],
                "operation_type": args[2],
                "actor_kind": "agent",
                "actor_session_id": args[3],
                "actor_event_id": None,
                "actor_user_id": None,
                "idempotency_key": args[4],
                "payload_json": args[5],
                "reason": args[6],
                "created_at": datetime(2026, 5, 27, tzinfo=timezone.utc),
            }
            return self.operation
        if "UPDATE task_operations SET actor_event_id" in normalized:
            self.operation = {**self.operation, "actor_event_id": args[0]}
            return self.operation
        if "UPDATE task_items" in normalized:
            self.child = {**self.child, "created_from_event_id": args[2]}
            return self.child
        if "SELECT * FROM task_items WHERE id" in normalized:
            return self.child
        raise AssertionError(f"unhandled fetchrow query: {normalized}")

    async def fetch(self, query, *args):
        normalized = " ".join(str(query).split())
        if "SELECT * FROM sessions WHERE session_id = ANY" in normalized:
            return []
        raise AssertionError(f"unhandled fetch query: {normalized}")

    async def fetchval(self, query, *args):
        return 2.0


class TestListSessions:
    """GET /api/sessions tests."""

    async def test_returns_empty_list(self, client, mock_db, auth_headers):
        """Returns empty session list when no sessions exist."""
        mock_db.get_all_sessions.return_value = ([], 0)

        resp = await client.get("/api/sessions", headers=auth_headers)

        assert resp.status_code == 200
        body = resp.json()
        assert body["sessions"] == []
        assert body["total"] == 0
        assert body["cursor"] is None

    async def test_returns_sessions_with_camel_case(self, client, mock_db):
        """Returns sessions with camelCase field names."""
        mock_db.get_all_sessions.return_value = (
            [
                {
                    "session_id": "s1",
                    "status": "running",
                    "prompt": "hello",
                    "created_at": "2026-01-01T00:00:00",
                    "updated_at": "2026-01-01T00:00:00",
                    "session_type": "claude",
                    "last_message": None,
                    "client_id": None,
                    "metadata": None,
                    "display_name": "Test",
                    "node_id": "n1",
                    "folder_id": None,
                },
            ],
            1,
        )

        resp = await client.get("/api/sessions")

        assert resp.status_code == 200
        body = resp.json()
        assert len(body["sessions"]) == 1
        s = body["sessions"][0]
        assert s["agentSessionId"] == "s1"
        assert s["displayName"] == "Test"
        assert s["nodeId"] == "n1"

    async def test_pagination_cursor(self, client, mock_db):
        """Returns cursor when more results are available."""
        mock_db.get_all_sessions.return_value = (
            [{"session_id": f"s{i}", "status": "idle"} for i in range(50)],
            100,
        )

        resp = await client.get("/api/sessions?limit=50")

        body = resp.json()
        assert body["cursor"] == "50"
        assert body["total"] == 100

    async def test_folder_filter(self, client, mock_db):
        """Passes folderId filter to DB query."""
        mock_db.get_all_sessions.return_value = ([], 0)

        await client.get("/api/sessions?folderId=folder-abc")

        mock_db.get_all_sessions.assert_called_once_with(
            offset=0, limit=50, folder_id="folder-abc"
        )

    async def test_feed_only_passes_feed_scope_to_db(self, client, mock_db):
        """feed_only=true delegates excludeFromFeed filtering to the DB query."""
        mock_db.get_all_sessions.return_value = ([], 0)

        await client.get("/api/sessions?feed_only=true")

        mock_db.get_all_sessions.assert_called_once_with(
            offset=0, limit=50, feed_only=True
        )


class TestCreateSession:
    """POST /api/sessions tests."""

    async def test_creates_session_returns_201(self, client, mock_db, node_manager):
        """Creates a session and returns 201 with session/node IDs."""
        # Register a node so routing works
        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()

        node = await node_manager.register_node(
            ws,
            {"node_id": "api-node", **DEFAULT_AGENT_REGISTRATION},
        )

        async def resolve_on_send(data):
            req_id = data.get("requestId")
            if req_id and req_id in node._pending:
                node._pending[req_id].set_result({"agentSessionId": "new-sess-id"})

        ws.send_json.side_effect = resolve_on_send

        resp = await client.post(
            "/api/sessions",
            json={"prompt": "test prompt"},
        )

        assert resp.status_code == 201
        body = resp.json()
        assert body["agentSessionId"] == "new-sess-id"
        assert body["nodeId"] == "api-node"

    async def test_create_session_no_nodes_returns_503(self, client):
        """Returns 503 when no nodes are available."""
        resp = await client.post(
            "/api/sessions",
            json={"prompt": "test"},
        )

        assert resp.status_code == 503

    async def test_create_session_invalid_node_returns_404(self, client, node_manager):
        """Returns 404 when specified node doesn't exist."""
        # Register a different node
        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()
        await node_manager.register_node(
            ws,
            {"node_id": "other-node", **DEFAULT_AGENT_REGISTRATION},
        )

        resp = await client.post(
            "/api/sessions",
            json={"prompt": "test", "nodeId": "nonexistent"},
        )

        assert resp.status_code == 404

    async def test_create_session_broadcasts_catalog_with_folder_id(
        self, client, mock_db, node_manager, mock_catalog_service
    ):
        """folderId 있을 때 broadcast_catalog()가 호출되어야 한다."""
        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()

        node = await node_manager.register_node(
            ws,
            {"node_id": "api-node", **DEFAULT_AGENT_REGISTRATION},
        )

        async def resolve_on_send(data):
            req_id = data.get("requestId")
            if req_id and req_id in node._pending:
                node._pending[req_id].set_result({"agentSessionId": "sess-with-folder"})

        ws.send_json.side_effect = resolve_on_send

        resp = await client.post(
            "/api/sessions",
            json={"prompt": "test", "folderId": "f-123"},
        )

        assert resp.status_code == 201
        mock_catalog_service.broadcast_catalog.assert_awaited_once()

    async def test_create_session_broadcasts_catalog_without_folder_id(
        self, client, mock_db, node_manager, mock_catalog_service
    ):
        """folderId 없을 때도 broadcast_catalog()가 호출되어야 한다.

        soul-server는 folderId=None이어도 _assign_default_folder_and_broadcast()로
        기본 폴더를 배정하므로, broadcast_catalog()가 반드시 호출되어야 한다.
        이 테스트는 버그(if body.folderId and catalog_service:)가 재발하지 않음을 검증한다.
        """
        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()

        node = await node_manager.register_node(
            ws,
            {"node_id": "api-node", **DEFAULT_AGENT_REGISTRATION},
        )

        async def resolve_on_send(data):
            req_id = data.get("requestId")
            if req_id and req_id in node._pending:
                node._pending[req_id].set_result({"agentSessionId": "sess-no-folder"})

        ws.send_json.side_effect = resolve_on_send

        resp = await client.post(
            "/api/sessions",
            json={"prompt": "test"},
        )

        assert resp.status_code == 201
        mock_catalog_service.broadcast_catalog.assert_awaited_once()

    async def test_create_session_with_parent_task_creates_linked_child_task(
        self, client, mock_db, node_manager
    ):
        """Task Tree 하위 대화 시작은 세션 생성과 child task link를 서버에서 묶는다."""
        mock_db.pool = FakeTaskScopedPool()
        mock_db.append_event = AsyncMock(return_value=303)
        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()
        node = await node_manager.register_node(
            ws,
            {"node_id": "api-node", **DEFAULT_AGENT_REGISTRATION},
        )

        async def resolve_on_send(data):
            assert data["extra_context_items"][0]["key"] == "task_tree_parent"
            assert "Parent task" in data["extra_context_items"][0]["content"]
            req_id = data.get("requestId")
            if req_id and req_id in node._pending:
                node._pending[req_id].set_result({"agentSessionId": "child-session"})

        ws.send_json.side_effect = resolve_on_send

        resp = await client.post(
            "/api/sessions",
            json={
                "prompt": "하위 대화 내용",
                "parentTaskId": "parent-task",
                "taskIdempotencyKey": "idem-child",
            },
        )

        assert resp.status_code == 201
        body = resp.json()
        assert body["agentSessionId"] == "child-session"
        assert body["task"]["parentId"] == "parent-task"
        assert body["task"]["linkedSessionId"] == "child-session"
        assert body["task"]["status"] == "in_progress"
        assert body["task"]["verificationOwner"] == "both"
        assert body["taskOperation"]["operationType"] == "start_child_session"

    def test_task_scoped_idempotent_response_uses_create_session_keys(self):
        """중복 제출 응답도 일반 create session 성공 응답과 같은 task 키를 쓴다."""
        existing = {
            "agentSessionId": "child-session",
            "nodeId": "api-node",
            "task": {"id": "child-task"},
            "operation": {"operationType": "start_child_session"},
            "eventId": 303,
            "idempotent": True,
        }

        response = existing_task_scoped_session_response(existing)

        assert response == {
            "agentSessionId": "child-session",
            "nodeId": "api-node",
            "task": {"id": "child-task"},
            "taskOperation": {"operationType": "start_child_session"},
            "taskEventId": 303,
            "idempotent": True,
        }


class TestIntervene:
    """POST /api/sessions/{session_id}/intervene tests."""

    @pytest.mark.parametrize(
        "node_error",
        [
            "Task hydration failed: sess-owned",
            "Task owned by another node: sess-owned owner=owner-node current=wrong-node",
        ],
    )
    async def test_node_resume_internal_errors_map_to_503(
        self, client, mock_db, node_manager, node_error
    ):
        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()
        node = await node_manager.register_node(
            ws,
            {"node_id": "owner-node", **DEFAULT_AGENT_REGISTRATION},
        )
        node.send_intervene = AsyncMock(side_effect=RuntimeError(node_error))
        mock_db.get_session = AsyncMock(
            return_value={"session_id": "sess-owned", "node_id": "owner-node"}
        )

        resp = await client.post(
            "/api/sessions/sess-owned/intervene",
            json={"text": "resume", "user": "browser"},
        )

        assert resp.status_code == 503
        assert node_error in resp.json()["detail"]


class TestRespond:
    """POST /api/sessions/{session_id}/respond tests."""

    @staticmethod
    def _make_resolve_by_request_id(node, result=None):
        """send_respond payload는 'inputRequestId' 별도 키로 input_request의 request_id를
        보내고, 'requestId'는 _send_command가 생성한 WS 명령 ID로 유지된다.
        _pending 키(WS 명령 ID)와 정확히 매칭되는 future를 resolve하는 side_effect를 반환한다.
        """
        result = result or {"success": True}

        async def resolve_on_send(data):
            ws_command_id = data.get("requestId", "")
            future = node._pending.get(ws_command_id)
            if future is not None and not future.done():
                future.set_result(result)
        return resolve_on_send

    async def test_camel_case_request_id(self, client, mock_db, node_manager):
        """camelCase requestId 필드로 응답 전송 시 200 반환."""
        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()
        node = await node_manager.register_node(ws, {"node_id": "resp-node"})
        _mock_session_owner(mock_db, node)
        ws.send_json.side_effect = self._make_resolve_by_request_id(node)

        resp = await client.post(
            "/api/sessions/test-session/respond",
            json={"requestId": "r123", "answers": {"question": "answer"}},
        )

        assert resp.status_code == 200
        assert resp.json() == {"success": True}

        # send_respond가 inputRequestId 키로 input_request의 request_id를 보냈는지 검증.
        # 'requestId'는 _send_command가 덮어쓴 WS 명령 ID(req-N)이며 분리되어 있어야 한다.
        sent_payloads = [call.args[0] for call in ws.send_json.await_args_list]
        respond_payloads = [p for p in sent_payloads if p.get("type") == "respond"]
        assert len(respond_payloads) == 1
        assert respond_payloads[0].get("inputRequestId") == "r123"
        # WS 명령 ID는 _send_command가 부여한 형식 (input_request hex가 아님)
        assert respond_payloads[0].get("requestId") != "r123"

    async def test_snake_case_request_id_backward_compat(
        self, client, mock_db, node_manager
    ):
        """snake_case request_id 필드로 응답 전송 시 200 반환 (하위 호환)."""
        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()
        node = await node_manager.register_node(ws, {"node_id": "resp-node-2"})
        _mock_session_owner(mock_db, node)
        ws.send_json.side_effect = self._make_resolve_by_request_id(node)

        resp = await client.post(
            "/api/sessions/test-session/respond",
            json={"request_id": "r456", "answers": {"question": "answer"}},
        )

        assert resp.status_code == 200
        assert resp.json() == {"success": True}

        sent_payloads = [call.args[0] for call in ws.send_json.await_args_list]
        respond_payloads = [p for p in sent_payloads if p.get("type") == "respond"]
        assert len(respond_payloads) == 1
        assert respond_payloads[0].get("inputRequestId") == "r456"

    @pytest.mark.parametrize(
        ("code", "expected_status"),
        [
            ("SESSION_NOT_FOUND", 404),
            ("SESSION_NOT_RUNNING", 409),
            ("REQUEST_NOT_PENDING", 422),
            ("INPUT_REQUEST_EXPIRED", 422),
            ("INPUT_REQUEST_ALREADY_RESPONDED", 422),
            ("INPUT_RESPONSE_NOT_SUPPORTED", 422),
        ],
    )
    async def test_respond_ack_error_status_maps_to_http_error(
        self, client, mock_db, node_manager, code, expected_status
    ):
        """TS node가 respond_ack(status=error)를 보내도 orch는 timeout 없이 HTTP 에러로 정규화한다."""
        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()
        node = await node_manager.register_node(ws, {"node_id": "resp-node-error"})
        _mock_session_owner(mock_db, node)
        ws.send_json.side_effect = self._make_resolve_by_request_id(
            node,
            {
                "type": "respond_ack",
                "status": "error",
                "code": code,
                "message": f"{code} message",
                "inputRequestId": "r789",
            },
        )

        resp = await client.post(
            "/api/sessions/test-session/respond",
            json={"requestId": "r789", "answers": {"question": "answer"}},
        )

        assert resp.status_code == expected_status
        assert resp.json()["detail"]["error"]["code"] == code


class TestClaudeBackgroundTasks:
    """Claude runtime background task API tests."""

    @staticmethod
    def _make_resolve_by_request_id(node, result):
        async def resolve_on_send(data):
            ws_command_id = data.get("requestId", "")
            future = node._pending.get(ws_command_id)
            if future is not None and not future.done():
                future.set_result(result)
        return resolve_on_send

    async def test_background_task_list_output_stop_routes_send_ws_commands(
        self, client, mock_db, node_manager
    ):
        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()
        node = await node_manager.register_node(ws, {"node_id": "runtime-node"})
        _mock_session_owner(mock_db, node)
        ws.send_json.side_effect = self._make_resolve_by_request_id(
            node,
            {
                "type": "claude_runtime_list_tasks_ack",
                "status": "ok",
                "tasks": [{"taskId": "bg-1"}],
                "output": "done",
                "stopped": True,
            },
        )

        list_resp = await client.get("/api/sessions/test-session/background-tasks")
        output_resp = await client.get(
            "/api/sessions/test-session/background-tasks/bg-1/output"
        )
        stop_resp = await client.post(
            "/api/sessions/test-session/background-tasks/bg-1/stop"
        )

        assert list_resp.status_code == 200
        assert list_resp.json()["tasks"] == [{"taskId": "bg-1"}]
        assert output_resp.status_code == 200
        assert output_resp.json()["output"] == "done"
        assert stop_resp.status_code == 200
        assert stop_resp.json()["stopped"] is True

        payloads = [call.args[0] for call in ws.send_json.await_args_list]
        assert [payload["type"] for payload in payloads[-3:]] == [
            "claude_runtime_list_tasks",
            "claude_runtime_task_output",
            "claude_runtime_stop_task",
        ]
        assert payloads[-2]["taskId"] == "bg-1"
        assert payloads[-1]["taskId"] == "bg-1"

    async def test_background_tasks_route_accepts_camel_case_tool_use_id(
        self, client, mock_db, node_manager
    ):
        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()
        node = await node_manager.register_node(ws, {"node_id": "runtime-node-2"})
        _mock_session_owner(mock_db, node)
        ws.send_json.side_effect = self._make_resolve_by_request_id(
            node,
            {
                "type": "claude_runtime_background_tasks_ack",
                "status": "ok",
                "backgrounded": True,
            },
        )

        resp = await client.post(
            "/api/sessions/test-session/background-tasks/background",
            json={"toolUseId": "toolu-bash"},
        )

        assert resp.status_code == 200
        assert resp.json()["backgrounded"] is True
        payload = ws.send_json.await_args_list[-1].args[0]
        assert payload["type"] == "claude_runtime_background_tasks"
        assert payload["agentSessionId"] == "test-session"
        assert payload["toolUseId"] == "toolu-bash"

    async def test_schedule_list_delete_routes_send_ws_commands(
        self, client, mock_db, node_manager
    ):
        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()
        node = await node_manager.register_node(ws, {"node_id": "schedule-node"})
        _mock_session_owner(mock_db, node)

        async def resolve_on_send(data):
            ws_command_id = data.get("requestId", "")
            future = node._pending.get(ws_command_id)
            if future is None or future.done():
                return
            if data["type"] == "claude_runtime_list_schedules":
                future.set_result({
                    "type": "claude_runtime_list_schedules_ack",
                    "requestId": ws_command_id,
                    "status": "ok",
                    "sessionId": data["agentSessionId"],
                    "schedules": [{"scheduleId": "sched-1"}],
                    "nextRunAt": "2026-01-01T00:00:00.000Z",
                })
            elif data["type"] == "claude_runtime_delete_schedule":
                future.set_result({
                    "type": "claude_runtime_delete_schedule_ack",
                    "requestId": ws_command_id,
                    "status": "cancelled",
                    "deleted": True,
                    "sessionId": data["agentSessionId"],
                    "scheduleId": data["scheduleId"],
                })

        ws.send_json.side_effect = resolve_on_send

        list_resp = await client.get("/api/sessions/test-session/schedules")
        delete_resp = await client.delete("/api/sessions/test-session/schedules/sched-1")

        assert list_resp.status_code == 200
        assert list_resp.json()["schedules"] == [{"scheduleId": "sched-1"}]
        assert delete_resp.status_code == 200
        assert delete_resp.json()["deleted"] is True
        payloads = [call.args[0] for call in ws.send_json.await_args_list]
        assert payloads[-2]["type"] == "claude_runtime_list_schedules"
        assert payloads[-2]["agentSessionId"] == "test-session"
        assert payloads[-1]["type"] == "claude_runtime_delete_schedule"
        assert payloads[-1]["agentSessionId"] == "test-session"
        assert payloads[-1]["scheduleId"] == "sched-1"

    async def test_schedule_delete_already_firing_returns_conflict(
        self, client, mock_db, node_manager
    ):
        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()
        node = await node_manager.register_node(ws, {"node_id": "schedule-node"})
        _mock_session_owner(mock_db, node)

        async def resolve_on_send(data):
            ws_command_id = data.get("requestId", "")
            future = node._pending.get(ws_command_id)
            if future is None or future.done():
                return
            future.set_result({
                "type": "claude_runtime_delete_schedule_ack",
                "requestId": ws_command_id,
                "status": "already_firing",
                "deleted": False,
                "sessionId": data["agentSessionId"],
                "scheduleId": data["scheduleId"],
            })

        ws.send_json.side_effect = resolve_on_send

        resp = await client.delete("/api/sessions/test-session/schedules/sched-1")

        assert resp.status_code == 409
        assert resp.json()["detail"]["status"] == "already_firing"
        assert resp.json()["detail"]["deleted"] is False


class TestToolApprovals:
    """POST /api/sessions/{session_id}/tool-approvals/{approval_id} tests."""

    @staticmethod
    def _make_resolve_by_request_id(node, result=None):
        result = result or {
            "type": "tool_approval_ack",
            "status": "ok",
            "approvalId": "approval-1",
            "decision": "approved",
            "delivered": True,
        }

        async def resolve_on_send(data):
            ws_command_id = data.get("requestId", "")
            future = node._pending.get(ws_command_id)
            if future is not None and not future.done():
                future.set_result(result)
        return resolve_on_send

    async def test_approve_tool_sends_ws_command(self, client, mock_db, node_manager):
        """approve endpoint는 approve_tool 명령과 approvalId를 노드로 전달한다."""
        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()
        node = await node_manager.register_node(ws, {"node_id": "approval-node"})
        _mock_session_owner(mock_db, node)
        ws.send_json.side_effect = self._make_resolve_by_request_id(
            node,
            {
                "type": "tool_approval_ack",
                "status": "ok",
                "approvalId": "danger-call-1",
                "decision": "approved",
                "delivered": True,
            },
        )

        resp = await client.post(
            "/api/sessions/test-session/tool-approvals/danger-call-1/approve",
            json={"message": "approved once", "alwaysApprove": True},
        )

        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"
        sent_payloads = [call.args[0] for call in ws.send_json.await_args_list]
        approval_payloads = [p for p in sent_payloads if p.get("type") == "approve_tool"]
        assert len(approval_payloads) == 1
        assert approval_payloads[0].get("agentSessionId") == "test-session"
        assert approval_payloads[0].get("approvalId") == "danger-call-1"
        assert approval_payloads[0].get("requestId") != "danger-call-1"
        assert approval_payloads[0].get("message") == "approved once"
        assert approval_payloads[0].get("alwaysApprove") is True

    async def test_reject_tool_sends_ws_command(self, client, mock_db, node_manager):
        """reject endpoint는 reject_tool 명령과 거부 메시지를 노드로 전달한다."""
        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()
        node = await node_manager.register_node(ws, {"node_id": "approval-node-2"})
        _mock_session_owner(mock_db, node)
        ws.send_json.side_effect = self._make_resolve_by_request_id(
            node,
            {
                "type": "tool_approval_ack",
                "status": "ok",
                "approvalId": "danger-call-1",
                "decision": "rejected",
                "delivered": True,
            },
        )

        resp = await client.post(
            "/api/sessions/test-session/tool-approvals/danger-call-1/reject",
            json={"message": "no prod write", "alwaysReject": True},
        )

        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"
        sent_payloads = [call.args[0] for call in ws.send_json.await_args_list]
        approval_payloads = [p for p in sent_payloads if p.get("type") == "reject_tool"]
        assert len(approval_payloads) == 1
        assert approval_payloads[0].get("agentSessionId") == "test-session"
        assert approval_payloads[0].get("approvalId") == "danger-call-1"
        assert approval_payloads[0].get("requestId") != "danger-call-1"
        assert approval_payloads[0].get("message") == "no prod write"
        assert approval_payloads[0].get("alwaysReject") is True

    @pytest.mark.parametrize(
        ("code", "expected_status"),
        [
            ("SESSION_NOT_FOUND", 404),
            ("SESSION_NOT_RUNNING", 409),
            ("TOOL_APPROVAL_NOT_PENDING", 422),
            ("TOOL_APPROVAL_ALREADY_RESOLVED", 422),
            ("TOOL_APPROVAL_NOT_SUPPORTED", 422),
        ],
    )
    async def test_tool_approval_ack_error_status_maps_to_http_error(
        self, client, mock_db, node_manager, code, expected_status
    ):
        """tool_approval_ack(status=error)를 HTTP 에러로 정규화한다."""
        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()
        node = await node_manager.register_node(ws, {"node_id": "approval-node-error"})
        _mock_session_owner(mock_db, node)
        ws.send_json.side_effect = self._make_resolve_by_request_id(
            node,
            {
                "type": "tool_approval_ack",
                "status": "error",
                "code": code,
                "message": f"{code} message",
                "approvalId": "danger-call-1",
                "decision": "rejected",
            },
        )

        resp = await client.post(
            "/api/sessions/test-session/tool-approvals/danger-call-1/reject",
            json={"message": "no prod write"},
        )

        assert resp.status_code == expected_status
        assert resp.json()["detail"]["error"]["code"] == code


class TestRealtimeVoice:
    """POST /api/sessions/{session_id}/realtime/* tests."""

    @staticmethod
    def _make_resolve_by_request_id(node, result):
        async def resolve_on_send(data):
            ws_command_id = data.get("requestId", "")
            future = node._pending.get(ws_command_id)
            if future is not None and not future.done():
                future.set_result(result)
        return resolve_on_send

    async def test_realtime_call_sends_ws_command(self, client, mock_db, node_manager):
        """Realtime call endpoint forwards SDP offer without exposing provider key."""
        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()
        node = await node_manager.register_node(ws, {"node_id": "realtime-node"})
        _mock_session_owner(mock_db, node)
        ws.send_json.side_effect = self._make_resolve_by_request_id(
            node,
            {
                "type": "realtime_call_created",
                "status": "ok",
                "callId": "call_1",
                "answerSdp": "answer",
            },
        )

        resp = await client.post(
            "/api/sessions/test-session/realtime/call",
            json={"offerSdp": "offer", "voice": "alloy"},
        )

        assert resp.status_code == 200
        assert resp.json()["answerSdp"] == "answer"
        sent_payloads = [call.args[0] for call in ws.send_json.await_args_list]
        realtime_payloads = [p for p in sent_payloads if p.get("type") == "realtime_create_call"]
        assert len(realtime_payloads) == 1
        assert realtime_payloads[0]["agentSessionId"] == "test-session"
        assert realtime_payloads[0]["offerSdp"] == "offer"
        assert realtime_payloads[0]["voice"] == "alloy"
        assert "apiKey" not in realtime_payloads[0]

    async def test_realtime_event_sends_ws_command(self, client, mock_db, node_manager):
        """Realtime event endpoint forwards data-channel event to the node."""
        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()
        node = await node_manager.register_node(ws, {"node_id": "realtime-node-2"})
        _mock_session_owner(mock_db, node)
        ws.send_json.side_effect = self._make_resolve_by_request_id(
            node,
            {
                "type": "realtime_event_ack",
                "status": "ok",
                "normalizedType": "realtime_transcript",
                "eventId": 9,
            },
        )

        resp = await client.post(
            "/api/sessions/test-session/realtime/events",
            json={"callId": "call_1", "event": {"type": "response.audio_transcript.done", "transcript": "hi"}},
        )

        assert resp.status_code == 200
        assert resp.json()["normalizedType"] == "realtime_transcript"
        sent_payloads = [call.args[0] for call in ws.send_json.await_args_list]
        event_payloads = [p for p in sent_payloads if p.get("type") == "realtime_event"]
        assert len(event_payloads) == 1
        assert event_payloads[0]["callId"] == "call_1"

    async def test_realtime_tool_approval_resolve_sends_ws_command(
        self, client, mock_db, node_manager
    ):
        """voice/tap approval resolve endpoint forwards decision to the node."""
        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()
        node = await node_manager.register_node(ws, {"node_id": "realtime-node-3"})
        _mock_session_owner(mock_db, node)
        ws.send_json.side_effect = self._make_resolve_by_request_id(
            node,
            {
                "type": "realtime_tool_approval_ack",
                "status": "ok",
                "approvalId": "approval-1",
                "decision": "approved",
                "dataChannelEvent": {"type": "tool_approval.response"},
            },
        )

        resp = await client.post(
            "/api/sessions/test-session/realtime/tool-approvals/approval-1/resolve",
            json={"decision": "approved", "source": "voice"},
        )

        assert resp.status_code == 200
        assert resp.json()["decision"] == "approved"
        sent_payloads = [call.args[0] for call in ws.send_json.await_args_list]
        approval_payloads = [
            p for p in sent_payloads if p.get("type") == "realtime_resolve_tool_approval"
        ]
        assert len(approval_payloads) == 1
        assert approval_payloads[0]["approvalId"] == "approval-1"
        assert approval_payloads[0]["decision"] == "approved"
        assert approval_payloads[0]["source"] == "voice"


class TestBatchMoveFolder:
    """PATCH /api/sessions/folder tests."""

    async def test_batch_move_sessions(self, client, mock_db, mock_catalog_service):
        """Moves multiple sessions to a folder via catalog_service."""
        resp = await client.patch(
            "/api/sessions/folder",
            json={"sessionIds": ["s1", "s2"], "folderId": "f1"},
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        assert body["count"] == 2
        mock_catalog_service.move_sessions_to_folder.assert_awaited_once_with(
            ["s1", "s2"], "f1"
        )


class TestSessionToResponseUserInfo:
    """_session_to_response의 userName/userPortraitUrl 테스트."""

    def test_user_info_included_when_node_has_user_info(self):
        """node_manager에 user_info가 있으면 userName/userPortraitUrl이 설정된다."""
        from unittest.mock import MagicMock
        from soulstream_server.api.session_serializer import _session_to_response

        node_manager = MagicMock()
        node_manager.find_agent_profile.return_value = None
        node_manager.get_user_info.return_value = {
            "name": "테스터",
            "hasPortrait": True,
        }

        session = {
            "session_id": "s1",
            "status": "running",
            "node_id": "n1",
            "agent_id": None,
        }

        result = _session_to_response(session, node_manager)

        assert result["userName"] == "테스터"
        assert result["userPortraitUrl"] == "/api/nodes/n1/user/portrait"

    def test_user_portrait_url_none_when_no_portrait(self):
        """hasPortrait=False이면 userPortraitUrl이 None이다."""
        from unittest.mock import MagicMock
        from soulstream_server.api.session_serializer import _session_to_response

        node_manager = MagicMock()
        node_manager.find_agent_profile.return_value = None
        node_manager.get_user_info.return_value = {
            "name": "테스터",
            "hasPortrait": False,
        }

        session = {
            "session_id": "s1",
            "status": "running",
            "node_id": "n1",
            "agent_id": None,
        }

        result = _session_to_response(session, node_manager)

        assert result["userName"] == "테스터"
        assert result["userPortraitUrl"] is None

    def test_user_info_none_when_no_node_manager(self):
        """node_manager가 없으면 userName/userPortraitUrl이 None이다."""
        from soulstream_server.api.session_serializer import _session_to_response

        session = {
            "session_id": "s1",
            "status": "running",
            "node_id": "n1",
            "agent_id": None,
        }

        result = _session_to_response(session, node_manager=None)

        assert result["userName"] is None
        assert result["userPortraitUrl"] is None

    # === caller_info override (atom ed3a216d) ===
    # caller_info가 metadata에 있으면 노드 user_info보다 우선한다.

    def _make_session_with_caller_info(self, caller_info_value):
        return {
            "session_id": "s1",
            "status": "running",
            "node_id": "n1",
            "agent_id": None,
            "metadata": [
                {"type": "caller_info", "value": caller_info_value},
            ],
        }

    def _make_node_manager_with_user(self):
        from unittest.mock import MagicMock
        nm = MagicMock()
        nm.find_agent_profile.return_value = None
        nm.get_user_info.return_value = {"name": "노드 사용자", "hasPortrait": True}
        return nm

    def test_caller_info_browser_overrides_user_info(self):
        """caller_info source=browser → display_name/avatar_url(google picture) override."""
        from soulstream_server.api.session_serializer import _session_to_response

        session = self._make_session_with_caller_info({
            "source": "browser",
            "display_name": "Jubok Kim",
            "user_id": "eiaserinnys@gmail.com",
            "avatar_url": "https://lh3.googleusercontent.com/a/ABC",
            "email": "eiaserinnys@gmail.com",
        })

        result = _session_to_response(session, self._make_node_manager_with_user())

        assert result["userName"] == "Jubok Kim"
        assert result["userPortraitUrl"] == "https://lh3.googleusercontent.com/a/ABC"

    def test_caller_info_slack_overrides_user_info(self):
        """caller_info source=slack → image_192 url override."""
        from soulstream_server.api.session_serializer import _session_to_response

        session = self._make_session_with_caller_info({
            "source": "slack",
            "display_name": "@channel-user",
            "user_id": "U08ABC",
            "avatar_url": "https://avatars.slack-edge.com/2024/img_192.png",
            "slack": {"channel_id": "C08", "user_id": "U08ABC"},
        })

        result = _session_to_response(session, self._make_node_manager_with_user())

        assert result["userName"] == "@channel-user"
        assert result["userPortraitUrl"] == "https://avatars.slack-edge.com/2024/img_192.png"

    def test_caller_info_agent_overrides_user_info(self):
        """caller_info source=agent → /api/agents/.../portrait override."""
        from soulstream_server.api.session_serializer import _session_to_response

        session = self._make_session_with_caller_info({
            "source": "agent",
            "display_name": "shay",
            "user_id": "shay",
            "avatar_url": "/api/agents/shay/portrait",
            "agent_node": "eiaserinnys",
            "agent_id": "shay",
            "agent_name": "Shay",
        })

        result = _session_to_response(session, self._make_node_manager_with_user())

        assert result["userName"] == "shay"
        assert result["userPortraitUrl"] == "/api/agents/shay/portrait"

    def test_caller_info_soul_app_overrides_user_info(self):
        """caller_info source=soul-app (RN) → google picture override."""
        from soulstream_server.api.session_serializer import _session_to_response

        session = self._make_session_with_caller_info({
            "source": "soul-app",
            "display_name": "Jubok Kim",
            "user_id": "eiaserinnys@gmail.com",
            "avatar_url": "https://lh3.googleusercontent.com/a/RN-PIC",
            "email": "eiaserinnys@gmail.com",
        })

        result = _session_to_response(session, self._make_node_manager_with_user())

        assert result["userName"] == "Jubok Kim"
        assert result["userPortraitUrl"] == "https://lh3.googleusercontent.com/a/RN-PIC"

    def test_caller_info_avatar_url_empty_string_falls_back_to_node_portrait(self):
        """avatar_url='' → 노드 portrait fallback. display_name은 caller_info 유지."""
        from soulstream_server.api.session_serializer import _session_to_response

        session = self._make_session_with_caller_info({
            "source": "browser",
            "display_name": "익명",
            "avatar_url": "",
        })

        result = _session_to_response(session, self._make_node_manager_with_user())

        # display_name은 caller_info 유지
        assert result["userName"] == "익명"
        # avatar_url이 비문자열·빈 문자열이면 caller_info의 avatar_url override 미적용 →
        # 노드 user_info가 hasPortrait=True이지만 caller_info 분기를 탔으므로
        # noupr override가 일어나지 않아 None.
        # (정책: caller_info 분기에 들어간 이상 노드 portrait로 mix-fallback하지 않는다.
        #  하나의 발신자 정체성을 일관되게 표현 — design-principles §3.)
        assert result["userPortraitUrl"] is None

    def test_caller_info_avatar_url_non_string_ignored(self):
        """avatar_url이 비문자열(int)이면 무시되어 None."""
        from soulstream_server.api.session_serializer import _session_to_response

        session = self._make_session_with_caller_info({
            "source": "browser",
            "display_name": "Jubok",
            "avatar_url": 12345,  # 비정상 타입 (defensive)
        })

        result = _session_to_response(session, self._make_node_manager_with_user())

        assert result["userName"] == "Jubok"
        assert result["userPortraitUrl"] is None

    def test_caller_info_display_name_empty_uses_none(self):
        """display_name='' → userName None (avatar는 있을 수 있음)."""
        from soulstream_server.api.session_serializer import _session_to_response

        session = self._make_session_with_caller_info({
            "source": "browser",
            "display_name": "",
            "avatar_url": "https://example.com/a.png",
        })

        result = _session_to_response(session, self._make_node_manager_with_user())

        assert result["userName"] is None
        assert result["userPortraitUrl"] == "https://example.com/a.png"

    def test_caller_info_absent_uses_node_user_info(self):
        """metadata에 caller_info 없으면 기존 동작 보존 (회귀 보호)."""
        from soulstream_server.api.session_serializer import _session_to_response

        session = {
            "session_id": "s1",
            "status": "running",
            "node_id": "n1",
            "agent_id": None,
            "metadata": [{"type": "summary", "value": "old"}],  # caller_info 없음
        }

        result = _session_to_response(session, self._make_node_manager_with_user())

        # 노드 user_info가 사용된다.
        assert result["userName"] == "노드 사용자"
        assert result["userPortraitUrl"] == "/api/nodes/n1/user/portrait"

    def test_caller_info_value_string_ignored(self):
        """caller_info entry의 value가 string(레거시)이면 dict 아니므로 무시 → 노드 fallback."""
        from soulstream_server.api.session_serializer import _session_to_response

        session = {
            "session_id": "s1",
            "status": "running",
            "node_id": "n1",
            "agent_id": None,
            "metadata": [{"type": "caller_info", "value": "legacy-string"}],
        }

        result = _session_to_response(session, self._make_node_manager_with_user())

        assert result["userName"] == "노드 사용자"
        assert result["userPortraitUrl"] == "/api/nodes/n1/user/portrait"
