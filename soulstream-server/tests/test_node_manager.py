"""Tests for NodeManager node tracking and change events."""

import base64
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from soulstream_server.nodes.node_manager import NodeManager


@pytest.fixture
def manager():
    return NodeManager()


@pytest.fixture
def mock_ws():
    ws = AsyncMock()
    ws.send_json = AsyncMock()
    ws.close = AsyncMock()
    return ws


def make_registration(node_id="node-1", host="localhost", port=4100):
    return {"node_id": node_id, "host": host, "port": port, "capabilities": ["session"]}


class TestRegisterNode:
    """register_node tests."""

    async def test_register_node_adds_to_map(self, manager, mock_ws):
        """register_node adds the node to internal map."""
        node = await manager.register_node(mock_ws, make_registration("node-a"))

        assert node.node_id == "node-a"
        assert manager.get_node("node-a") is node
        assert len(manager.get_connected_nodes()) == 1

    async def test_register_node_duplicate_replaces_old(self, manager):
        """Registering the same node_id closes old connection and replaces."""
        ws1 = AsyncMock()
        ws1.send_json = AsyncMock()
        ws1.close = AsyncMock()
        ws2 = AsyncMock()
        ws2.send_json = AsyncMock()
        ws2.close = AsyncMock()

        old_node = await manager.register_node(ws1, make_registration("node-dup"))
        new_node = await manager.register_node(ws2, make_registration("node-dup"))

        assert manager.get_node("node-dup") is new_node
        assert manager.get_node("node-dup") is not old_node
        # Old connection should have been closed
        ws1.close.assert_called_once()

    async def test_register_node_preserves_host_and_port(self, manager, mock_ws):
        """register_node preserves host/port from registration data."""
        node = await manager.register_node(
            mock_ws, make_registration("n1", "10.0.0.1", 5000)
        )

        assert node.host == "10.0.0.1"
        assert node.port == 5000


class TestUnregisterNode:
    """unregister_node tests."""

    async def test_unregister_removes_from_map(self, manager, mock_ws):
        """unregister_node removes the node from the map."""
        await manager.register_node(mock_ws, make_registration("node-x"))
        assert manager.get_node("node-x") is not None

        manager.unregister_node("node-x")

        assert manager.get_node("node-x") is None
        assert len(manager.get_connected_nodes()) == 0

    async def test_unregister_nonexistent_is_noop(self, manager):
        """unregister_node with unknown node_id does not raise."""
        manager.unregister_node("ghost-node")  # Should not raise


class TestGetConnectedNodes:
    """get_connected_nodes tests."""

    async def test_returns_all_registered_nodes(self, manager):
        """get_connected_nodes returns all registered nodes."""
        ws1 = AsyncMock()
        ws1.send_json = AsyncMock()
        ws1.close = AsyncMock()
        ws2 = AsyncMock()
        ws2.send_json = AsyncMock()
        ws2.close = AsyncMock()

        await manager.register_node(ws1, make_registration("n1"))
        await manager.register_node(ws2, make_registration("n2"))

        nodes = manager.get_connected_nodes()
        ids = {n.node_id for n in nodes}
        assert ids == {"n1", "n2"}

    async def test_get_nodes_returns_info_dicts(self, manager, mock_ws):
        """get_nodes returns serialized node info dicts."""
        await manager.register_node(mock_ws, make_registration("n1"))

        infos = manager.get_nodes()
        assert len(infos) == 1
        assert infos[0]["nodeId"] == "n1"
        assert infos[0]["status"] == "connected"


class TestFindNodeForSession:
    """find_node_for_session tests."""

    async def test_finds_node_with_matching_session(self, manager, mock_ws):
        """find_node_for_session returns the node holding the session."""
        node = await manager.register_node(mock_ws, make_registration("n1"))
        node._sessions["sess-abc"] = {"agentSessionId": "sess-abc"}

        found = manager.find_node_for_session("sess-abc")
        assert found is node

    async def test_returns_none_for_unknown_session(self, manager, mock_ws):
        """find_node_for_session returns None for unknown session."""
        await manager.register_node(mock_ws, make_registration("n1"))

        assert manager.find_node_for_session("no-such-sess") is None


class TestChangeListeners:
    """Change listener event tests."""

    async def test_listener_receives_register_event(self, manager, mock_ws):
        """Change listeners receive node_registered events."""
        events = []

        async def listener(event_type, node_id, data):
            events.append((event_type, node_id))

        manager.add_change_listener(listener)
        await manager.register_node(mock_ws, make_registration("n1"))

        assert len(events) == 1
        assert events[0] == ("node_registered", "n1")

    async def test_listener_receives_unregister_event(self, manager, mock_ws):
        """Change listeners receive node_unregistered events via on_close."""
        events = []

        async def listener(event_type, node_id, data):
            events.append((event_type, node_id))

        manager.add_change_listener(listener)
        node = await manager.register_node(mock_ws, make_registration("n1"))

        # Simulate node close (which calls _on_node_close)
        await node.close()

        assert ("node_unregistered", "n1") in events

    async def test_remove_change_listener(self, manager, mock_ws):
        """Removed listener no longer receives events."""
        events = []

        async def listener(event_type, node_id, data):
            events.append(event_type)

        manager.add_change_listener(listener)
        manager.remove_change_listener(listener)
        await manager.register_node(mock_ws, make_registration("n1"))

        assert len(events) == 0


class TestAgentProfileRegistration:
    """등록 메시지에 agents 포함 시 처리 검증."""

    async def test_agents_in_registration_sets_profiles(self, manager, mock_ws):
        """agents 포함 등록 → agent_profiles가 설정된다."""
        reg = make_registration("n1")
        reg["agents"] = [{"id": "agent-1", "name": "에이전트1", "portrait_url": "/api/agents/agent-1/portrait"}]
        node = await manager.register_node(mock_ws, reg)

        assert "agent-1" in node.agent_profiles
        assert node.agent_profiles["agent-1"]["name"] == "에이전트1"

    async def test_agents_with_portrait_b64_populates_cache(self, manager, mock_ws):
        """portrait_b64 포함 시 portrait_cache에 디코딩된 bytes가 저장된다."""
        portrait_bytes = b"\x89PNGfakedata"
        reg = make_registration("n1")
        reg["agents"] = [{
            "id": "agent-1",
            "name": "에이전트1",
            "portrait_url": "/api/agents/agent-1/portrait",
            "portrait_b64": base64.b64encode(portrait_bytes).decode("ascii"),
        }]
        node = await manager.register_node(mock_ws, reg)

        assert node.portrait_cache.get("agent-1") == portrait_bytes

    async def test_agents_absent_falls_back_to_http(self, manager, mock_ws):
        """agents 없는 등록 메시지 → _fetch_agent_profiles HTTP 조회가 호출된다."""
        with patch.object(
            manager, "_fetch_agent_profiles", new=AsyncMock()
        ) as mock_fetch:
            await manager.register_node(mock_ws, make_registration("n1"))
            mock_fetch.assert_called_once()


class TestFindAgentProfile:
    """find_agent_profile 테스트."""

    async def test_preferred_node_found(self, manager, mock_ws):
        """preferred_node_id에 프로필이 있으면 해당 노드에서 반환."""
        node = await manager.register_node(mock_ws, make_registration("n1"))
        node.set_agent_data({"seosoyoung": {"name": "서소영"}}, {})

        result = manager.find_agent_profile("seosoyoung", "n1")

        assert result is not None
        profile, source_node_id = result
        assert source_node_id == "n1"
        assert profile["name"] == "서소영"

    async def test_fallback_to_other_node(self, manager):
        """preferred_node에 없으면 다른 노드로 fallback."""
        ws1 = AsyncMock()
        ws1.send_json = AsyncMock()
        ws1.close = AsyncMock()
        ws2 = AsyncMock()
        ws2.send_json = AsyncMock()
        ws2.close = AsyncMock()

        n1 = await manager.register_node(ws1, make_registration("n1"))
        n2 = await manager.register_node(ws2, make_registration("n2"))
        # n2에만 프로필 있음
        n2.set_agent_data({"seosoyoung": {"name": "서소영"}}, {})

        result = manager.find_agent_profile("seosoyoung", preferred_node_id="n1")

        assert result is not None
        _, source_node_id = result
        assert source_node_id == "n2"

    async def test_returns_none_when_not_found(self, manager, mock_ws):
        """어느 노드에도 없으면 None 반환."""
        await manager.register_node(mock_ws, make_registration("n1"))

        assert manager.find_agent_profile("unknown-agent") is None


class TestUserInfo:
    """사용자 정보 조회 테스트."""

    async def test_user_in_registration_sets_user_info(self, manager, mock_ws):
        """등록 메시지에 user 포함 시 user_info가 설정되고 HTTP 조회는 생략된다."""
        reg = make_registration("n1")
        reg["user"] = {"name": "WS유저", "hasPortrait": False}

        with patch.object(manager, "_fetch_user_info", new=AsyncMock()) as mock_fetch:
            node = await manager.register_node(mock_ws, reg)
            mock_fetch.assert_not_called()

        assert node.user_info.get("name") == "WS유저"

    async def test_user_with_portrait_b64_in_registration(self, manager, mock_ws):
        """등록 메시지에 portrait_b64 포함 시 user_info에 그대로 저장된다."""
        portrait_bytes = b"\x89PNGfakedata"
        portrait_b64 = base64.b64encode(portrait_bytes).decode("ascii")
        reg = make_registration("n1")
        reg["user"] = {"name": "WS유저", "hasPortrait": True, "portrait_b64": portrait_b64}

        node = await manager.register_node(mock_ws, reg)

        assert node.user_info.get("portrait_b64") == portrait_b64

    async def test_user_absent_falls_back_to_http(self, manager, mock_ws):
        """등록 메시지에 user 없으면 _fetch_user_info HTTP 조회가 호출된다."""
        with patch.object(
            manager, "_fetch_user_info", new=AsyncMock()
        ) as mock_fetch:
            await manager.register_node(mock_ws, make_registration("n1"))
            mock_fetch.assert_called_once()

    async def test_get_user_info_returns_node_data(self, manager, mock_ws):
        """get_user_info는 노드에 설정된 user_info를 반환한다."""
        node = await manager.register_node(mock_ws, make_registration("n1"))
        node.set_user_info({"name": "테스터", "hasPortrait": True})

        result = manager.get_user_info("n1")

        assert result["name"] == "테스터"
        assert result["hasPortrait"] is True

    async def test_get_user_info_returns_empty_for_unknown_node(self, manager):
        """알 수 없는 node_id에 대해 빈 dict를 반환한다."""
        result = manager.get_user_info("non-existent-node")

        assert result == {}

    async def test_fetch_user_info_sets_data_from_http(self, manager, mock_ws):
        """_fetch_user_info가 HTTP 응답에서 user_info를 설정한다."""
        import httpx
        from unittest.mock import patch as _patch

        user_data = {"name": "HTTP유저", "hasPortrait": False}

        mock_resp = MagicMock()
        mock_resp.json.return_value = {"user": user_data}

        with _patch("httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_resp)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=None)
            mock_client_cls.return_value = mock_client

            node = await manager.register_node(mock_ws, make_registration("n1"))

        assert node.user_info.get("name") == "HTTP유저"

    async def test_fetch_user_info_graceful_on_http_error(self, manager, mock_ws):
        """HTTP 실패 시 user_info가 빈 dict로 graceful degradation."""
        import httpx
        from unittest.mock import patch as _patch

        with _patch("httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.get = AsyncMock(side_effect=httpx.RequestError("connection refused"))
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=None)
            mock_client_cls.return_value = mock_client

            node = await manager.register_node(mock_ws, make_registration("n1"))

        assert node.user_info == {}
