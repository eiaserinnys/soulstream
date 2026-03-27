"""
_on_node_change 함수 단위 테스트.

node_manager._on_session_change가 이벤트를 'node_session_{change_type}'으로 포장하므로,
_on_node_change는 이를 클라이언트가 인식하는 session_* 타입으로 변환하여 broadcast해야 한다.
모든 이벤트에 대해 기존 broadcast_node_change도 함께 호출되어야 한다.
"""

import pytest
from unittest.mock import AsyncMock, MagicMock

from soulstream_server.main import _on_node_change


@pytest.fixture
def mock_broadcaster():
    broadcaster = MagicMock()
    broadcaster.broadcast = AsyncMock()
    broadcaster.broadcast_node_change = AsyncMock()
    return broadcaster


@pytest.mark.asyncio
async def test_session_created_broadcasts_session_event(mock_broadcaster):
    """node_session_session_created → broadcast(session_created) + broadcast_node_change 둘 다 호출."""
    data = {"agentSessionId": "sess-123", "status": "idle"}
    await _on_node_change(mock_broadcaster, "node_session_session_created", "node-1", data)

    mock_broadcaster.broadcast.assert_awaited_once_with({
        "type": "session_created",
        "session": data,
        "nodeId": "node-1",
    })
    mock_broadcaster.broadcast_node_change.assert_awaited_once_with({
        "type": "node_session_session_created",
        "nodeId": "node-1",
        "data": data,
    })


@pytest.mark.asyncio
async def test_session_updated_broadcasts_session_event(mock_broadcaster):
    """node_session_session_updated → broadcast(session_updated, agent_session_id 포함) + broadcast_node_change."""
    data = {"agentSessionId": "sess-456", "status": "running"}
    await _on_node_change(mock_broadcaster, "node_session_session_updated", "node-1", data)

    call_args = mock_broadcaster.broadcast.await_args[0][0]
    assert call_args["type"] == "session_updated"
    assert call_args["agent_session_id"] == "sess-456"
    assert call_args["nodeId"] == "node-1"
    assert call_args["agentSessionId"] == "sess-456"

    mock_broadcaster.broadcast_node_change.assert_awaited_once_with({
        "type": "node_session_session_updated",
        "nodeId": "node-1",
        "data": data,
    })


@pytest.mark.asyncio
async def test_session_updated_with_snake_case_id(mock_broadcaster):
    """node_session_session_updated — data에 agent_session_id(snake_case)가 올 때도 처리."""
    data = {"agent_session_id": "sess-789", "status": "done"}
    await _on_node_change(mock_broadcaster, "node_session_session_updated", "node-2", data)

    call_args = mock_broadcaster.broadcast.await_args[0][0]
    assert call_args["agent_session_id"] == "sess-789"


@pytest.mark.asyncio
async def test_session_deleted_broadcasts_session_event(mock_broadcaster):
    """node_session_session_deleted → broadcast(session_deleted, agent_session_id) + broadcast_node_change."""
    data = {"agentSessionId": "sess-999"}
    await _on_node_change(mock_broadcaster, "node_session_session_deleted", "node-1", data)

    mock_broadcaster.broadcast.assert_awaited_once_with({
        "type": "session_deleted",
        "agent_session_id": "sess-999",
    })
    mock_broadcaster.broadcast_node_change.assert_awaited_once_with({
        "type": "node_session_session_deleted",
        "nodeId": "node-1",
        "data": data,
    })


@pytest.mark.asyncio
async def test_session_deleted_with_none_session_id_skips_broadcast(mock_broadcaster):
    """node_session_session_deleted — data에 session_id가 없으면 broadcast 미호출, broadcast_node_change만 호출."""
    data = {}
    await _on_node_change(mock_broadcaster, "node_session_session_deleted", "node-1", data)

    mock_broadcaster.broadcast.assert_not_awaited()
    mock_broadcaster.broadcast_node_change.assert_awaited_once()


@pytest.mark.asyncio
async def test_other_event_only_broadcasts_node_change(mock_broadcaster):
    """기타 이벤트(node_registered 등) → broadcast_node_change만 호출, broadcast 미호출."""
    data = {"info": "some-node"}
    await _on_node_change(mock_broadcaster, "node_registered", "node-1", data)

    mock_broadcaster.broadcast.assert_not_awaited()
    mock_broadcaster.broadcast_node_change.assert_awaited_once_with({
        "type": "node_registered",
        "nodeId": "node-1",
        "data": data,
    })
