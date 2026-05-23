"""Tests for NodeConnection subscribe listener lifecycle."""

from unittest.mock import AsyncMock

import pytest
from starlette.websockets import WebSocketDisconnect

from soulstream_server.constants import EVT_EVENT
from soulstream_server.nodes.node_connection import NodeConnection


@pytest.fixture
def ws():
    mock = AsyncMock()
    mock.send_json = AsyncMock()
    mock.close = AsyncMock()
    return mock


@pytest.fixture
def node(ws):
    return NodeConnection(
        ws=ws,
        node_id="node-1",
        host="localhost",
        port=4100,
    )


async def test_send_subscribe_events_rolls_back_listener_when_send_fails(
    node, ws
):
    """A failed subscribe command must not leave a local fan-out listener."""
    callback = AsyncMock()
    ws.send_json.side_effect = RuntimeError("closed")

    with pytest.raises(WebSocketDisconnect):
        await node.send_subscribe_events("sess-1", callback)

    assert "sess-1" not in node._subscribe_listeners

    await node.handle_message({
        "type": EVT_EVENT,
        "agentSessionId": "sess-1",
        "payload": {"text": "late"},
    })

    callback.assert_not_awaited()
