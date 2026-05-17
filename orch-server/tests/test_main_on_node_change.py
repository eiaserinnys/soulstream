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
    # F-B(2026-05-17): _on_node_change가 broadcast 반환값(int recipient count)을
    # logger.info "%d" 포맷에 사용한다. AsyncMock 기본 반환은 MagicMock 인스턴스라
    # %d 포맷이 __int__ 호출 시 TypeError. return_value=1로 픽스처 갱신 — 기존
    # 케이스 13개의 assert는 broadcast *인자*만 검증하므로 return_value 변경에 영향 0.
    broadcaster.broadcast = AsyncMock(return_value=1)
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


# ===== F-B(2026-05-17): broadcast INFO/WARN 로그 검증 =====
# 회귀 진단 시 "broadcast 발사 자체"가 로그에 결정적으로 남는지 확인.
# 분석 캐시 §7.1 "broadcaster.broadcast 발사 자체 확정 불가" 한계 회피용.


@pytest.mark.asyncio
async def test_session_created_emits_broadcast_info_log(mock_broadcaster, mock_node_manager, caplog):
    """F-B: session_created 분기에서 INFO 로그 [broadcast] session_created sid=... recipients=N 출력."""
    import logging
    caplog.set_level(logging.INFO, logger="soulstream_server.main")
    mock_broadcaster.broadcast.return_value = 3  # 가상 수신자 3명
    data = {"agentSessionId": "sess-fb-created", "status": "idle"}
    await _on_node_change(
        mock_broadcaster, mock_node_manager,
        "node_session_session_created", "node-fb", data,
    )

    info_records = [r for r in caplog.records if r.levelno == logging.INFO and "[broadcast]" in r.message]
    assert any(
        "session_created" in r.message
        and "sid=sess-fb-created" in r.message
        and "node=node-fb" in r.message
        and "recipients=3" in r.message
        for r in info_records
    ), f"INFO 로그 누락 또는 포맷 불일치 — records: {[r.message for r in info_records]}"


@pytest.mark.asyncio
async def test_session_updated_emits_broadcast_info_log(mock_broadcaster, mock_node_manager, caplog):
    """F-B: session_updated 분기에서 INFO 로그 출력."""
    import logging
    caplog.set_level(logging.INFO, logger="soulstream_server.main")
    mock_broadcaster.broadcast.return_value = 2
    data = {"agentSessionId": "sess-fb-updated", "status": "running"}
    await _on_node_change(
        mock_broadcaster, mock_node_manager,
        "node_session_session_updated", "node-fb", data,
    )

    info_records = [r for r in caplog.records if r.levelno == logging.INFO and "[broadcast]" in r.message]
    assert any(
        "session_updated" in r.message
        and "sid=sess-fb-updated" in r.message
        and "recipients=2" in r.message
        for r in info_records
    ), f"INFO 로그 누락 — records: {[r.message for r in info_records]}"


@pytest.mark.asyncio
async def test_session_deleted_with_id_emits_broadcast_info_log(mock_broadcaster, mock_node_manager, caplog):
    """F-B: session_deleted with session_id 분기에서 INFO 로그 출력."""
    import logging
    caplog.set_level(logging.INFO, logger="soulstream_server.main")
    mock_broadcaster.broadcast.return_value = 1
    data = {"agentSessionId": "sess-fb-deleted"}
    await _on_node_change(
        mock_broadcaster, mock_node_manager,
        "node_session_session_deleted", "node-fb", data,
    )

    info_records = [r for r in caplog.records if r.levelno == logging.INFO and "[broadcast]" in r.message]
    assert any(
        "session_deleted" in r.message
        and "sid=sess-fb-deleted" in r.message
        and "recipients=1" in r.message
        for r in info_records
    ), f"INFO 로그 누락 — records: {[r.message for r in info_records]}"


@pytest.mark.asyncio
async def test_session_deleted_without_id_emits_warn_log(mock_broadcaster, mock_node_manager, caplog):
    """F-B: session_deleted without session_id 시 WARN 로그(SKIPPED) 출력."""
    import logging
    caplog.set_level(logging.WARNING, logger="soulstream_server.main")
    data = {"unrelated_key": "x"}
    await _on_node_change(
        mock_broadcaster, mock_node_manager,
        "node_session_session_deleted", "node-fb", data,
    )

    warn_records = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert any(
        "[broadcast] session_deleted SKIPPED" in r.message
        and "node=node-fb" in r.message
        and "unrelated_key" in r.message
        for r in warn_records
    ), f"WARN 로그 누락 — records: {[r.message for r in warn_records]}"
    mock_broadcaster.broadcast.assert_not_awaited()


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


# === G-19 fix (2026-05-11) — wire-kind 식별 가드 회귀 매트릭스 T13/T14 ===
#
# 진단: emit_session_message_updated wire(P6 결정으로 caller 키 부재)가
# orch _on_node_change session_updated 분기에서 emit_session_updated/phase와
# 무차별로 apply_user_profile_enrichment를 통과하여, caller_source=None +
# userName falsy → 노드 owner fallback → SessionSummary.userName이 dashboard
# owner로 덮어쓰이던 회로(atom diagnosis 20260511-1700).
#
# fix: session_updated 분기에 `if "last_message" not in (data or {}):` 가드
# 추가하여 enrichment 호출을 가드 안으로 이동. `last_message` 키는
# emit_session_message_updated wire의 *유일 고유 키* (broadcaster L184) —
# wire 종류 식별 정본. broadcaster docstring(emit_session_message_updated)에
# 식별 마커 명시로 정본 둘 위험 차단.


@pytest.mark.asyncio
async def test_t13_session_message_updated_wire_skips_enrichment(mock_broadcaster):
    """T13(G-19): emit_session_message_updated wire (last_message 키 보유, caller 키 부재) →
    apply_user_profile_enrichment skip → broadcast_data에 userName/userPortraitUrl 키 추가 없음.

    data=None 에지는 `(data or {}) → {}` → 가드 통과 → enrichment 발동.
    baseline T1~T6과 동일 거동 (mock 빈 dict로 NOOP 보존). 본 케이스는 *G-19 회로*만 cover.
    """
    nm = MagicMock(spec=NodeManager)
    # 만약 가드가 없으면 노드 owner를 fallback으로 박을 것 — assert로 차단.
    nm.get_user_info = MagicMock(return_value={"name": "노드 사용자", "hasPortrait": True})

    data = {
        "agentSessionId": "sess-msg",
        "status": "running",
        "updated_at": "2026-05-11T08:00:00+00:00",
        "last_message": {
            "type": "user_message",
            "preview": "안녕",
            "timestamp": "2026-05-11T08:00:00+00:00",
        },
        "last_event_id": 12,
        "last_read_event_id": 10,
    }
    await _on_node_change(
        mock_broadcaster, nm,
        "node_session_session_updated", "node-1", data,
    )

    call_args = mock_broadcaster.broadcast.await_args[0][0]
    # 가드로 enrichment skip — userName/userPortraitUrl 키 추가 없음
    assert "userName" not in call_args, (
        "G-19 회로: emit_session_message_updated wire에 enrichment가 발동하여 "
        "노드 owner로 덮어쓰임. _on_node_change session_updated 분기에 "
        "`if \"last_message\" not in (data or {}):` 가드 필요."
    )
    assert "userPortraitUrl" not in call_args
    # 호출 자체 0건 — guard가 enrichment 진입 전에 차단
    nm.get_user_info.assert_not_called()


@pytest.mark.asyncio
async def test_t14_sequential_updated_then_message_preserves_agent_identity(mock_broadcaster):
    """T14(G-19): emit_session_updated wire (caller_source=agent, userName=작가) →
    이어 emit_session_message_updated wire (last_message 보유) sequential 투입.
    두 번째 wire에서 userName이 노드 owner로 덮이지 않아 *agent 정체성 유지*.

    클라이언트(soul-ui buildSessionUpdates / soul-app useSessionsStream)는
    두 번째 wire의 key 부재를 skip하므로 SessionSummary.userName="작가 서소영"이 보존된다.
    """
    nm = MagicMock(spec=NodeManager)
    # 노드 owner는 Jubok Kim — agent 정체성(작가 서소영)이 살아남아야 함
    nm.get_user_info = MagicMock(return_value={"name": "Jubok Kim", "hasPortrait": True})

    # wire #1: emit_session_updated (agent 정체성 보유 — IDENTITY_BEARING NOOP)
    wire1 = {
        "agentSessionId": "sess-a",
        "status": "running",
        "caller_source": "agent",
        "userName": "작가 서소영",
        "userPortraitUrl": "/api/nodes/eias-linegames/agents/writer/portrait",
        "session_type": "claude",
        "last_event_id": 1,
        "last_read_event_id": 0,
    }
    await _on_node_change(
        mock_broadcaster, nm,
        "node_session_session_updated", "eias-linegames", wire1,
    )
    bc1 = mock_broadcaster.broadcast.await_args[0][0]
    assert bc1["userName"] == "작가 서소영"  # caller_source=agent → IDENTITY_BEARING NOOP
    assert bc1["userPortraitUrl"].endswith("/agents/writer/portrait")

    # wire #2: emit_session_message_updated (메시지 단위 갱신 — wire-kind guard로 enrichment skip)
    wire2 = {
        "agentSessionId": "sess-a",
        "status": "running",
        "updated_at": "2026-05-11T08:00:01+00:00",
        "last_message": {
            "type": "user_message",
            "preview": "다음 턴",
            "timestamp": "2026-05-11T08:00:01+00:00",
        },
        "last_event_id": 2,
        "last_read_event_id": 1,
    }
    await _on_node_change(
        mock_broadcaster, nm,
        "node_session_session_updated", "eias-linegames", wire2,
    )
    bc2 = mock_broadcaster.broadcast.await_args[0][0]
    # 가드로 enrichment skip → broadcast_data에 userName/userPortraitUrl 키 추가 없음
    # 클라이언트는 키 부재를 skip하므로 SessionSummary에 박힌 "작가 서소영" 보존
    assert "userName" not in bc2, (
        "G-19 회로: 둘째 wire(emit_session_message_updated)에서 enrichment가 발동하여 "
        "기존 agent 정체성이 노드 owner로 덮어쓰임."
    )
    assert "userPortraitUrl" not in bc2
    # wire #1(IDENTITY_BEARING NOOP) + wire #2(wire-kind skip) — 두 wire 모두 get_user_info 0회
    nm.get_user_info.assert_not_called()
