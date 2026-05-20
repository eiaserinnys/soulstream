"""SessionRouter backend 필터 회귀 (옵션 D Phase A — A2).

agent.backend ↔ node.supported_backends 매칭 필터 검증.
profile 부재 / unknown profile은 필터 우회 (graceful).
target_node가 backend 미지원 시 409, 매칭 노드 없으면 503.
"""
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from soulstream_server.service.session_router import (
    NoMatchingBackendNode,
    SessionRouter,
)


def _make_node(node_id: str, supported_backends: list[str], session_count: int = 0):
    """Mock NodeConnection — supported_backends·session_count·send_create_session만 사용."""
    node = MagicMock()
    node.node_id = node_id
    node.supported_backends = supported_backends
    node.session_count = session_count
    node.send_create_session = AsyncMock(
        return_value={"agentSessionId": f"sess-{node_id}"}
    )
    return node


def _make_node_manager(nodes: list, agent_profile: dict | None = None):
    """Mock NodeManager — get_connected_nodes / get_node / find_agent_profile."""
    nm = MagicMock()
    nm.get_connected_nodes.return_value = nodes
    nm.get_node.side_effect = lambda nid: next(
        (n for n in nodes if n.node_id == nid), None
    )
    if agent_profile is not None:
        nm.find_agent_profile.return_value = (agent_profile, nodes[0].node_id if nodes else "n1")
    else:
        nm.find_agent_profile.return_value = None
    return nm


async def test_no_profile_no_filter():
    """profile 부재 시 backend 필터 우회 — least-sessions-first 그대로."""
    n1 = _make_node("n1", ["claude"], session_count=5)
    n2 = _make_node("n2", ["claude"], session_count=2)
    router = SessionRouter(_make_node_manager([n1, n2]))
    _sid, nid = await router.route_create_session({"prompt": "hi"})
    assert nid == "n2"


async def test_profile_matches_backend():
    """agent.backend가 node.supported_backends에 포함되면 정상 라우팅."""
    n1 = _make_node("n1", ["claude"])
    router = SessionRouter(
        _make_node_manager([n1], agent_profile={"backend": "claude"})
    )
    _sid, nid = await router.route_create_session(
        {"prompt": "hi", "profile": "roselin"}
    )
    assert nid == "n1"


async def test_reasoning_effort_only_forwarded_for_codex_backend():
    """reasoningEffort는 codex backend일 때만 노드 wire로 넘긴다."""
    codex_node = _make_node("codex-node", ["codex"])
    codex_router = SessionRouter(
        _make_node_manager([codex_node], agent_profile={"backend": "codex"})
    )
    await codex_router.route_create_session(
        {"prompt": "hi", "profile": "cody", "reasoningEffort": "medium"}
    )
    assert codex_node.send_create_session.call_args.kwargs["reasoning_effort"] == "medium"

    claude_node = _make_node("claude-node", ["claude"])
    claude_router = SessionRouter(
        _make_node_manager([claude_node], agent_profile={"backend": "claude"})
    )
    await claude_router.route_create_session(
        {"prompt": "hi", "profile": "roselin", "reasoningEffort": "medium"}
    )
    assert claude_node.send_create_session.call_args.kwargs["reasoning_effort"] is None


async def test_reasoning_effort_forwarded_for_single_backend_codex_node_without_profile():
    """profile이 없어도 codex 전용 노드면 reasoningEffort를 넘긴다."""
    codex_node = _make_node("codex-node", ["codex"])
    router = SessionRouter(_make_node_manager([codex_node]))

    await router.route_create_session(
        {"prompt": "hi", "nodeId": "codex-node", "reasoningEffort": "low"}
    )

    assert codex_node.send_create_session.call_args.kwargs["reasoning_effort"] == "low"


async def test_no_matching_backend_503():
    """agent.backend를 지원하는 노드 없으면 503 NoMatchingBackendNode."""
    n1 = _make_node("n1", ["claude"])
    router = SessionRouter(
        _make_node_manager([n1], agent_profile={"backend": "codex"})
    )
    with pytest.raises(HTTPException) as exc:
        await router.route_create_session(
            {"prompt": "hi", "profile": "cody"}
        )
    assert exc.value.status_code == 503
    assert "codex" in exc.value.detail


async def test_target_node_lacks_backend_409():
    """target nodeId 지정인데 그 노드가 backend 미지원 시 409."""
    n1 = _make_node("n1", ["claude"])
    router = SessionRouter(
        _make_node_manager([n1], agent_profile={"backend": "codex"})
    )
    with pytest.raises(HTTPException) as exc:
        await router.route_create_session(
            {"prompt": "hi", "profile": "cody", "nodeId": "n1"}
        )
    assert exc.value.status_code == 409


async def test_eligible_least_sessions():
    """backend 매칭 노드 중 session_count 최소 노드 선택."""
    n1 = _make_node("n1", ["claude"], session_count=10)
    n2 = _make_node("n2", ["claude"], session_count=3)
    n3 = _make_node("n3", ["codex"], session_count=1)
    router = SessionRouter(
        _make_node_manager([n1, n2, n3], agent_profile={"backend": "claude"})
    )
    _sid, nid = await router.route_create_session(
        {"prompt": "hi", "profile": "roselin"}
    )
    # n3는 session_count 최소지만 codex만 지원 — eligible에서 제외. n2가 backend 매칭 중 최소.
    assert nid == "n2"


async def test_unknown_profile_falls_through():
    """find_agent_profile이 None 반환 시 filter 우회 — 모든 노드 후보."""
    n1 = _make_node("n1", ["claude"])
    router = SessionRouter(_make_node_manager([n1]))  # agent_profile=None
    _sid, nid = await router.route_create_session(
        {"prompt": "hi", "profile": "unknown"}
    )
    assert nid == "n1"
