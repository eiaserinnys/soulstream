"""SessionRouter backend 필터 회귀.

agent.backend ↔ node.supported_backends 매칭 필터 검증.
profile 부재는 legacy caller 호환으로 필터 우회.
unknown profile은 404, target_node backend 미지원은 409.
"""
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from soulstream_server.service.session_router import SessionRouter


def _make_node(
    node_id: str,
    supported_backends: list[str],
    session_count: int = 0,
    agent_profiles: dict | None = None,
):
    """Mock NodeConnection — supported_backends·session_count·send_create_session만 사용."""
    node = MagicMock()
    node.node_id = node_id
    node.supported_backends = supported_backends
    node.session_count = session_count
    node.agent_profiles = agent_profiles or {}
    node.send_create_session = AsyncMock(
        return_value={"agentSessionId": f"sess-{node_id}"}
    )
    return node


def _make_node_manager(nodes: list):
    """Mock NodeManager — get_connected_nodes / get_node."""
    nm = MagicMock()
    nm.get_connected_nodes.return_value = nodes
    nm.get_node.side_effect = lambda nid: next(
        (n for n in nodes if n.node_id == nid), None
    )
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
    n1 = _make_node("n1", ["claude"], agent_profiles={"roselin": {"backend": "claude"}})
    router = SessionRouter(_make_node_manager([n1]))
    _sid, nid = await router.route_create_session(
        {"prompt": "hi", "profile": "roselin"}
    )
    assert nid == "n1"


async def test_reasoning_effort_only_forwarded_for_codex_backend():
    """reasoningEffort는 codex backend일 때만 노드 wire로 넘긴다."""
    codex_node = _make_node(
        "codex-node",
        ["codex"],
        agent_profiles={"cody": {"backend": "codex"}},
    )
    codex_router = SessionRouter(_make_node_manager([codex_node]))
    await codex_router.route_create_session(
        {"prompt": "hi", "profile": "cody", "reasoningEffort": "medium"}
    )
    assert codex_node.send_create_session.call_args.kwargs["reasoning_effort"] == "medium"

    claude_node = _make_node(
        "claude-node",
        ["claude"],
        agent_profiles={"roselin": {"backend": "claude"}},
    )
    claude_router = SessionRouter(_make_node_manager([claude_node]))
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


async def test_profile_backend_inconsistent_with_node_returns_409():
    """profile이 등록된 노드가 그 backend를 지원하지 않으면 설정 오류 409."""
    n1 = _make_node(
        "n1",
        ["claude"],
        agent_profiles={"cody": {"backend": "codex"}},
    )
    router = SessionRouter(_make_node_manager([n1]))
    with pytest.raises(HTTPException) as exc:
        await router.route_create_session(
            {"prompt": "hi", "profile": "cody"}
        )
    assert exc.value.status_code == 409
    assert "none supports its configured backend" in exc.value.detail


async def test_incompatible_duplicate_profile_skips_to_compatible_node():
    """중복 profile 중 일부 노드 설정이 깨져도 정상 가용 후보로 라우팅한다."""
    broken = _make_node(
        "broken",
        ["claude"],
        session_count=0,
        agent_profiles={"cody": {"backend": "codex"}},
    )
    compatible = _make_node(
        "compatible",
        ["codex"],
        session_count=5,
        agent_profiles={"cody": {"backend": "codex"}},
    )
    router = SessionRouter(_make_node_manager([broken, compatible]))

    _sid, nid = await router.route_create_session(
        {"prompt": "hi", "profile": "cody"}
    )

    assert nid == "compatible"


async def test_target_node_lacks_backend_409():
    """target nodeId 지정인데 그 노드가 backend 미지원 시 409."""
    n1 = _make_node(
        "n1",
        ["claude"],
        agent_profiles={"cody": {"backend": "codex"}},
    )
    router = SessionRouter(_make_node_manager([n1]))
    with pytest.raises(HTTPException) as exc:
        await router.route_create_session(
            {"prompt": "hi", "profile": "cody", "nodeId": "n1"}
        )
    assert exc.value.status_code == 409


async def test_duplicate_agent_id_without_target_uses_least_sessions():
    """중복 agent id가 여러 노드에 있으면 가용 후보 중 session_count 최소 노드로 라우팅한다."""
    n1 = _make_node(
        "n1",
        ["claude"],
        session_count=5,
        agent_profiles={"roselin": {"backend": "claude"}},
    )
    n2 = _make_node(
        "n2",
        ["claude"],
        session_count=1,
        agent_profiles={"roselin": {"backend": "claude"}},
    )
    router = SessionRouter(_make_node_manager([n1, n2]))

    _sid, nid = await router.route_create_session(
        {"prompt": "hi", "profile": "roselin"}
    )

    assert nid == "n2"


async def test_target_node_disambiguates_duplicate_agent_id():
    """nodeId 지정 시 profile backend는 대상 노드 기준으로 해석된다."""
    n1 = _make_node(
        "n1",
        ["codex"],
        agent_profiles={"roselin": {"backend": "codex"}},
    )
    n2 = _make_node(
        "n2",
        ["claude"],
        agent_profiles={"roselin": {"backend": "claude"}},
    )
    nm = _make_node_manager([n1, n2])
    router = SessionRouter(nm)

    _sid, nid = await router.route_create_session(
        {"prompt": "hi", "profile": "roselin", "nodeId": "n2"}
    )

    assert nid == "n2"


async def test_eligible_least_sessions():
    """backend 매칭 노드 중 session_count 최소 노드 선택."""
    n1 = _make_node(
        "n1",
        ["claude"],
        session_count=10,
        agent_profiles={"roselin": {"backend": "claude"}},
    )
    n2 = _make_node(
        "n2",
        ["claude"],
        session_count=3,
        agent_profiles={"roselin": {"backend": "claude"}},
    )
    n3 = _make_node("n3", ["codex"], session_count=1)
    router = SessionRouter(_make_node_manager([n1, n2, n3]))
    _sid, nid = await router.route_create_session(
        {"prompt": "hi", "profile": "roselin"}
    )
    # n3는 session_count 최소지만 codex만 지원 — eligible에서 제외. n2가 backend 매칭 중 최소.
    assert nid == "n2"


async def test_unknown_profile_returns_404():
    """profile이 명시됐지만 등록 노드가 없으면 정확한 404를 반환한다."""
    n1 = _make_node("n1", ["claude"])
    router = SessionRouter(_make_node_manager([n1]))
    with pytest.raises(HTTPException) as exc:
        await router.route_create_session(
            {"prompt": "hi", "profile": "unknown"}
        )
    assert exc.value.status_code == 404
    assert "unknown" in exc.value.detail
