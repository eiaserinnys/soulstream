"""Tests for Sessions API (/api/sessions)."""

from unittest.mock import AsyncMock

import pytest


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
    def _make_resolve_by_request_id(node):
        """send_respond payload는 'inputRequestId' 별도 키로 input_request의 request_id를
        보내고, 'requestId'는 _send_command가 생성한 WS 명령 ID로 유지된다.
        _pending 키(WS 명령 ID)와 정확히 매칭되는 future를 resolve하는 side_effect를 반환한다.
        """
        async def resolve_on_send(data):
            ws_command_id = data.get("requestId", "")
            future = node._pending.get(ws_command_id)
            if future is not None and not future.done():
                future.set_result({"success": True})
        return resolve_on_send

    async def test_camel_case_request_id(self, client, node_manager):
        """camelCase requestId 필드로 응답 전송 시 200 반환."""
        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()
        node = await node_manager.register_node(ws, {"node_id": "resp-node"})
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

    async def test_snake_case_request_id_backward_compat(self, client, node_manager):
        """snake_case request_id 필드로 응답 전송 시 200 반환 (하위 호환)."""
        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()
        node = await node_manager.register_node(ws, {"node_id": "resp-node-2"})
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
