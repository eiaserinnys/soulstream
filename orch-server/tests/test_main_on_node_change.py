"""
_on_node_change 함수 단위 테스트.

node_manager._on_session_change가 이벤트를 'node_session_{change_type}'으로 포장하므로,
_on_node_change는 이를 클라이언트가 인식하는 session_* 타입으로 변환하여 broadcast해야 한다.
모든 이벤트에 대해 기존 broadcast_node_change도 함께 호출되어야 한다.

R-1 fix(2026-05-08): session_created/session_updated wire에 user 프로필 enrichment를
적용한다. 기존 baseline 7 케이스는 mock_node_manager(get_user_info=빈 dict 반환)로
헬퍼 NOOP를 보장하여 회귀 0 — broadcast payload 등호 비교 그대로 유지.
신규 T7-T9는 enrichment가 실제로 작동하는 시나리오를 검증한다.
"""

import pytest
from unittest.mock import AsyncMock, MagicMock

from soulstream_server.main import _on_node_change
from soulstream_server.nodes.node_manager import NodeManager


@pytest.fixture
def mock_broadcaster():
    broadcaster = MagicMock()
    broadcaster.broadcast = AsyncMock()
    broadcaster.broadcast_node_change = AsyncMock()
    return broadcaster


@pytest.fixture
def mock_node_manager():
    """NodeManager mock — 기본 get_user_info=빈 dict 반환.

    빈 dict 반환 시 apply_user_profile_enrichment 헬퍼는 NOOP — 기존 baseline 7
    케이스의 broadcast payload 등호 비교가 그대로 유지된다 (회귀 0).
    enrichment를 검증하는 신규 케이스는 fixture 반환값을 override한다.
    """
    nm = MagicMock(spec=NodeManager)
    nm.get_user_info = MagicMock(return_value={})
    return nm


@pytest.mark.asyncio
async def test_session_created_broadcasts_session_event(mock_broadcaster, mock_node_manager):
    """node_session_session_created → broadcast(session_created) + broadcast_node_change 둘 다 호출."""
    data = {"agentSessionId": "sess-123", "status": "idle"}
    await _on_node_change(
        mock_broadcaster, mock_node_manager,
        "node_session_session_created", "node-1", data,
    )

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
async def test_session_updated_broadcasts_session_event(mock_broadcaster, mock_node_manager):
    """node_session_session_updated → broadcast(session_updated, agent_session_id 포함) + broadcast_node_change."""
    data = {"agentSessionId": "sess-456", "status": "running"}
    await _on_node_change(
        mock_broadcaster, mock_node_manager,
        "node_session_session_updated", "node-1", data,
    )

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
async def test_session_updated_with_snake_case_id(mock_broadcaster, mock_node_manager):
    """node_session_session_updated — data에 agent_session_id(snake_case)가 올 때도 처리."""
    data = {"agent_session_id": "sess-789", "status": "done"}
    await _on_node_change(
        mock_broadcaster, mock_node_manager,
        "node_session_session_updated", "node-2", data,
    )

    call_args = mock_broadcaster.broadcast.await_args[0][0]
    assert call_args["agent_session_id"] == "sess-789"


@pytest.mark.asyncio
async def test_session_deleted_broadcasts_session_event(mock_broadcaster, mock_node_manager):
    """node_session_session_deleted → broadcast(session_deleted, agent_session_id) + broadcast_node_change."""
    data = {"agentSessionId": "sess-999"}
    await _on_node_change(
        mock_broadcaster, mock_node_manager,
        "node_session_session_deleted", "node-1", data,
    )

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
async def test_session_deleted_with_none_session_id_skips_broadcast(mock_broadcaster, mock_node_manager):
    """node_session_session_deleted — data에 session_id가 없으면 broadcast 미호출, broadcast_node_change만 호출."""
    data = {}
    await _on_node_change(
        mock_broadcaster, mock_node_manager,
        "node_session_session_deleted", "node-1", data,
    )

    mock_broadcaster.broadcast.assert_not_awaited()
    mock_broadcaster.broadcast_node_change.assert_awaited_once()


@pytest.mark.asyncio
async def test_other_event_only_broadcasts_node_change(mock_broadcaster, mock_node_manager):
    """기타 이벤트(node_registered 등) → broadcast_node_change만 호출, broadcast 미호출."""
    data = {"info": "some-node"}
    await _on_node_change(
        mock_broadcaster, mock_node_manager,
        "node_registered", "node-1", data,
    )

    mock_broadcaster.broadcast.assert_not_awaited()
    mock_broadcaster.broadcast_node_change.assert_awaited_once_with({
        "type": "node_registered",
        "nodeId": "node-1",
        "data": data,
    })


@pytest.mark.asyncio
async def test_session_created_with_nested_session_extracts_session_field(mock_broadcaster, mock_node_manager):
    """broadcaster 경로에서 오는 데이터는 session 필드에 전체 세션 정보를 담고 있다.
    _on_node_change는 data["session"]을 추출하여 broadcast해야 한다."""
    session_info = {
        "agent_session_id": "sess-123",
        "status": "running",
        "created_at": "2026-01-01T00:00:00",
        "session_type": "claude",
    }
    data = {
        "type": "session_created",
        "agentSessionId": "sess-123",
        "session": session_info,
    }
    await _on_node_change(
        mock_broadcaster, mock_node_manager,
        "node_session_session_created", "node-1", data,
    )

    mock_broadcaster.broadcast.assert_awaited_once_with({
        "type": "session_created",
        "session": session_info,  # data 전체가 아닌 data["session"]을 사용해야 함
        "nodeId": "node-1",
    })
    mock_broadcaster.broadcast_node_change.assert_awaited_once_with({
        "type": "node_session_session_created",
        "nodeId": "node-1",
        "data": data,
    })


# === R-1 fix 신규 케이스 (T7-T9) ===


@pytest.mark.asyncio
async def test_t7_session_created_enriches_user_profile_when_caller_info_absent(mock_broadcaster):
    """T7: session_created wire에 userName 없음 + NodeManager에 노드 user_info 등록 →
    broadcast 페이로드 session.userName/userPortraitUrl이 노드 정보로 채워짐.

    caller_info 부실 세션(영구 손실 / system source / 일부 위임)이 라이브로 도착할 때
    catalog REST와 동일하게 노드 owner 정보로 enrichment된다.
    """
    nm = MagicMock(spec=NodeManager)
    nm.get_user_info = MagicMock(return_value={"name": "노드 사용자", "hasPortrait": True})

    session_info = {
        "agent_session_id": "sess-123",
        "status": "running",
        # userName/userPortraitUrl 키 자체 없음 — caller_info 부재 케이스
    }
    data = {"agentSessionId": "sess-123", "session": session_info}

    await _on_node_change(
        mock_broadcaster, nm,
        "node_session_session_created", "node-1", data,
    )

    call_args = mock_broadcaster.broadcast.await_args[0][0]
    assert call_args["type"] == "session_created"
    assert call_args["session"]["userName"] == "노드 사용자"
    assert call_args["session"]["userPortraitUrl"] == "/api/nodes/node-1/user/portrait"
    nm.get_user_info.assert_called_once_with("node-1")


@pytest.mark.asyncio
async def test_t8_session_updated_enriches_user_profile_when_caller_info_absent(mock_broadcaster):
    """T8: session_updated wire에 userName 없음 + NodeManager 노드 정보 → broadcast_data 채워짐.

    P4(emit_session_updated)와 P5(emit_session_phase) 모두 type=session_updated wire라
    NodeConnection._on_session_updated → 같은 분기 → 한 곳 fix로 둘 다 닫힘.
    """
    nm = MagicMock(spec=NodeManager)
    nm.get_user_info = MagicMock(return_value={"name": "노드 사용자", "hasPortrait": True})

    data = {
        "agentSessionId": "sess-456",
        "status": "running",
        # userName/userPortraitUrl 키 없음
    }
    await _on_node_change(
        mock_broadcaster, nm,
        "node_session_session_updated", "node-1", data,
    )

    call_args = mock_broadcaster.broadcast.await_args[0][0]
    assert call_args["type"] == "session_updated"
    assert call_args["userName"] == "노드 사용자"
    assert call_args["userPortraitUrl"] == "/api/nodes/node-1/user/portrait"


@pytest.mark.asyncio
async def test_t9_session_created_skips_enrichment_when_caller_info_present(mock_broadcaster):
    """T9: session_created wire에 userName='alice' (caller_info 정체성 있음) →
    헬퍼 NOOP, 노드 정보로 덮어쓰지 않음 (mix-fallback 금지 정책).
    """
    nm = MagicMock(spec=NodeManager)
    nm.get_user_info = MagicMock(return_value={"name": "노드 사용자", "hasPortrait": True})

    session_info = {
        "agent_session_id": "sess-123",
        "status": "running",
        "userName": "alice",  # caller_info 정체성 있음
        "userPortraitUrl": "https://example.com/alice.png",
    }
    data = {"agentSessionId": "sess-123", "session": session_info}

    await _on_node_change(
        mock_broadcaster, nm,
        "node_session_session_created", "node-1", data,
    )

    call_args = mock_broadcaster.broadcast.await_args[0][0]
    assert call_args["session"]["userName"] == "alice"  # 보존
    assert call_args["session"]["userPortraitUrl"] == "https://example.com/alice.png"  # 보존
    # 헬퍼 NOOP 보장 (get_user_info 미호출)
    nm.get_user_info.assert_not_called()


@pytest.mark.asyncio
async def test_t9b_session_updated_skips_enrichment_when_caller_info_present(mock_broadcaster):
    """T9-b: session_updated wire에 userName='alice' → 헬퍼 NOOP."""
    nm = MagicMock(spec=NodeManager)
    nm.get_user_info = MagicMock(return_value={"name": "노드 사용자", "hasPortrait": True})

    data = {
        "agentSessionId": "sess-456",
        "status": "running",
        "userName": "alice",
        "userPortraitUrl": "https://example.com/alice.png",
    }
    await _on_node_change(
        mock_broadcaster, nm,
        "node_session_session_updated", "node-1", data,
    )

    call_args = mock_broadcaster.broadcast.await_args[0][0]
    assert call_args["userName"] == "alice"
    assert call_args["userPortraitUrl"] == "https://example.com/alice.png"
    nm.get_user_info.assert_not_called()
