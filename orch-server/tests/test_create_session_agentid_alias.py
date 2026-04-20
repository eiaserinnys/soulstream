"""
test_create_session_agentid_alias - CreateSessionRequest의 profile/agentId 양방향 alias 테스트

soul-server는 같은 값을 'agentId'로 부르고, orch-server는 'profile'로 부른다.
두 서버가 대칭 API를 갖도록 orch-server의 CreateSessionRequest에도 agentId alias를 추가한다.

WS 페이로드에 'profile' 키로 직렬화되어 노드로 전달되는지를 통해 검증한다
(node_connection.send_create_session이 profile 인자를 WS payload에 'profile' 키로 넣는다).
"""

from unittest.mock import AsyncMock

import pytest


def _register_node(node_manager):
    """register a node and make ws.send_json resolve with a canned response."""
    ws = AsyncMock()
    ws.send_json = AsyncMock()
    ws.close = AsyncMock()

    async def _register():
        node = await node_manager.register_node(ws, {"node_id": "test-node"})

        async def resolve_on_send(data):
            req_id = data.get("requestId")
            if req_id and req_id in node._pending:
                node._pending[req_id].set_result({"agentSessionId": "sess-routed"})

        ws.send_json.side_effect = resolve_on_send
        return node, ws

    return _register


def _extract_ws_payload(ws):
    """Return the dict that was sent to ws.send_json (the routed command)."""
    assert ws.send_json.await_count >= 1
    return ws.send_json.await_args_list[-1].args[0]


class TestCreateSessionProfileAlias:
    """CreateSessionRequest가 profile과 agentId 두 키를 모두 수용하는지 검증."""

    async def test_profile_primary_field_accepted(self, client, node_manager):
        """기존 동작: {'profile': 'seosoyoung'} → WS 페이로드에 'profile'='seosoyoung'."""
        _, ws = await _register_node(node_manager)()

        resp = await client.post(
            "/api/sessions",
            json={"prompt": "test", "profile": "seosoyoung"},
        )
        assert resp.status_code == 201

        payload = _extract_ws_payload(ws)
        assert payload["type"] == "create_session"
        assert payload["profile"] == "seosoyoung"

    async def test_agentId_alias_accepted(self, client, node_manager):
        """신규: {'agentId': 'seosoyoung'} → WS 페이로드에 'profile'='seosoyoung'.

        soul-server에서 오는 동일 값을 agentId로 부르는 호출자와 API 대칭을 맞춘다.
        """
        _, ws = await _register_node(node_manager)()

        resp = await client.post(
            "/api/sessions",
            json={"prompt": "test", "agentId": "seosoyoung"},
        )
        assert resp.status_code == 201

        payload = _extract_ws_payload(ws)
        assert payload["profile"] == "seosoyoung"

    async def test_both_keys_profile_wins(self, client, node_manager):
        """두 키 동시 전달 시 AliasChoices 순서대로 profile이 우선 사용된다. 에러 없이 201."""
        _, ws = await _register_node(node_manager)()

        resp = await client.post(
            "/api/sessions",
            json={"prompt": "test", "profile": "from-profile", "agentId": "from-agentId"},
        )
        assert resp.status_code == 201

        payload = _extract_ws_payload(ws)
        assert payload["profile"] == "from-profile"

    async def test_no_profile_omits_key(self, client, node_manager):
        """둘 다 없으면 WS 페이로드에 'profile' 키가 없다 (node_connection이 None을 skip)."""
        _, ws = await _register_node(node_manager)()

        resp = await client.post(
            "/api/sessions",
            json={"prompt": "test"},
        )
        assert resp.status_code == 201

        payload = _extract_ws_payload(ws)
        assert "profile" not in payload
