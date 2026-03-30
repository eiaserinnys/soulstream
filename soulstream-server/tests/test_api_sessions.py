"""Tests for Sessions API (/api/sessions)."""

from unittest.mock import AsyncMock

import pytest


class TestListSessions:
    """GET /api/sessions tests."""

    async def test_returns_empty_list(self, client, mock_db):
        """Returns empty session list when no sessions exist."""
        mock_db.get_all_sessions.return_value = ([], 0)

        resp = await client.get("/api/sessions")

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


class TestCreateSession:
    """POST /api/sessions tests."""

    async def test_creates_session_returns_201(self, client, mock_db, node_manager):
        """Creates a session and returns 201 with session/node IDs."""
        # Register a node so routing works
        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()

        node = await node_manager.register_node(ws, {"node_id": "api-node"})

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
        await node_manager.register_node(ws, {"node_id": "other-node"})

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

        node = await node_manager.register_node(ws, {"node_id": "api-node"})

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

        node = await node_manager.register_node(ws, {"node_id": "api-node"})

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


class TestRespond:
    """POST /api/sessions/{session_id}/respond tests."""

    @staticmethod
    def _make_resolve(node):
        """send_respond 페이로드는 requestId를 오버라이드하여 _pending 키와 불일치한다.
        모든 미완료 pending future를 한 번에 resolve하는 side_effect를 반환한다."""
        async def resolve_on_send(data):
            for future in list(node._pending.values()):
                if not future.done():
                    future.set_result({"success": True})
        return resolve_on_send

    async def test_camel_case_request_id(self, client, node_manager):
        """camelCase requestId 필드로 응답 전송 시 200 반환."""
        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()
        node = await node_manager.register_node(ws, {"node_id": "resp-node"})
        ws.send_json.side_effect = self._make_resolve(node)

        resp = await client.post(
            "/api/sessions/test-session/respond",
            json={"requestId": "r123", "answers": {"question": "answer"}},
        )

        assert resp.status_code == 200
        assert resp.json() == {"success": True}

    async def test_snake_case_request_id_backward_compat(self, client, node_manager):
        """snake_case request_id 필드로 응답 전송 시 200 반환 (하위 호환)."""
        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()
        node = await node_manager.register_node(ws, {"node_id": "resp-node-2"})
        ws.send_json.side_effect = self._make_resolve(node)

        resp = await client.post(
            "/api/sessions/test-session/respond",
            json={"request_id": "r456", "answers": {"question": "answer"}},
        )

        assert resp.status_code == 200
        assert resp.json() == {"success": True}


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
