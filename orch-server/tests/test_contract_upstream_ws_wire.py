"""Contract fixtures for orch <-> node upstream WebSocket wire."""

from unittest.mock import AsyncMock

from soulstream_server.nodes.node_connection import NodeConnection
from tests.orch_contract_helpers import load_contract_fixture


def _make_node() -> tuple[NodeConnection, AsyncMock]:
    ws = AsyncMock()
    ws.send_json = AsyncMock()
    ws.close = AsyncMock()
    return NodeConnection(ws=ws, node_id="fake-node"), ws


async def test_respond_uses_input_request_id_without_overwriting_command_request_id():
    fixture = load_contract_fixture("upstream_ws_wire.json")["outbound"]["respond"]
    node, ws = _make_node()

    async def resolve_future(message):
        command_request_id = message["requestId"]
        node._pending[command_request_id].set_result({
            "type": "respond_ack",
            "requestId": command_request_id,
            "inputRequestId": message["inputRequestId"],
            "status": "ok",
        })

    ws.send_json.side_effect = resolve_future

    result = await node.send_respond(
        fixture["agentSessionId"],
        fixture["inputRequestId"],
        fixture["answers"],
    )

    sent = ws.send_json.call_args.args[0]
    assert sent["type"] == fixture["type"]
    assert sent["agentSessionId"] == fixture["agentSessionId"]
    assert sent["inputRequestId"] == fixture["inputRequestId"]
    assert sent["answers"] == fixture["answers"]
    assert sent["requestId"].startswith("req-")
    assert sent["requestId"] != fixture["inputRequestId"]
    assert result["inputRequestId"] == fixture["inputRequestId"]


async def test_subscribe_events_is_fire_and_forget_without_request_id():
    fixture = load_contract_fixture("upstream_ws_wire.json")["outbound"]["subscribeEvents"]
    node, ws = _make_node()
    callback = AsyncMock()

    subscribe_id = await node.send_subscribe_events(fixture["agentSessionId"], callback)

    sent = ws.send_json.call_args.args[0]
    assert sent["type"] == fixture["type"]
    assert sent["agentSessionId"] == fixture["agentSessionId"]
    assert sent["subscribeId"] == subscribe_id
    assert "requestId" not in sent
    assert subscribe_id in node._subscribe_listeners[fixture["agentSessionId"]]
