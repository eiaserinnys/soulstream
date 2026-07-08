"""Fake node integration harness for future TS orch parity."""

from unittest.mock import AsyncMock

from soulstream_server.nodes.node_manager import NodeManager
from tests.orch_contract_helpers import load_contract_fixture


def _fake_ws() -> AsyncMock:
    ws = AsyncMock()
    ws.send_json = AsyncMock()
    ws.close = AsyncMock()
    return ws


async def test_fake_node_register_command_event_disconnect_reconnect_recovery():
    fixture = load_contract_fixture("fake_node_reconnect.json")
    manager = NodeManager()
    changes: list[tuple[str, str, dict | None]] = []

    async def record_change(event_type: str, node_id: str, data: dict | None = None):
        changes.append((event_type, node_id, data))

    manager.add_change_listener(record_change)
    node = await manager.register_node(_fake_ws(), fixture["registration"])

    async def ack_create_session(message):
        request_id = message["requestId"]
        node._pending[request_id].set_result({
            **fixture["ack"],
            "requestId": request_id,
        })

    node._ws.send_json.side_effect = ack_create_session
    result = await node.send_create_session(
        prompt=fixture["command"]["prompt"],
        session_id=fixture["command"]["agentSessionId"],
    )

    assert result["agentSessionId"] == fixture["ack"]["agentSessionId"]

    node._ws.send_json = AsyncMock()
    callback = AsyncMock()
    await node.send_subscribe_events(fixture["eventRelay"]["agentSessionId"], callback)
    await node.handle_message(fixture["eventRelay"])
    callback.assert_awaited_once_with(fixture["eventRelay"])

    await node.close()
    assert manager.get_node(fixture["registration"]["node_id"]) is None

    reconnected = await manager.register_node(_fake_ws(), fixture["registration"])
    await reconnected.handle_message(fixture["sessionsUpdateAfterReconnect"])

    assert manager.find_node_for_session(fixture["command"]["agentSessionId"]) is reconnected
    assert [change[0] for change in changes] == [
        "node_registered",
        "node_unregistered",
        "node_registered",
        "node_session_sessions_update",
    ]
