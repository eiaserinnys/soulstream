"""
test_create_agent_session_caller_info — delegate-task MCP의 caller_info 자동 첨부 검증 (Phase 3).

cogito.mcp_session_mgmt.create_agent_session(caller_session_id=...)이 호출되면,
caller_session에서 추출한 발신 에이전트의 신원(agent_node, agent_id, agent_name)에
더하여 통합 스키마 v1 top-level 필드(display_name, user_id, avatar_url)를 채운다.

검증 케이스:
1. caller_session_id 미지정 → caller_info=None (기존 동작)
2. caller_task가 None (DB에 없음) → caller_info에 모든 신원 필드 None
3. caller_profile이 None (registry 미일치) → display_name/avatar_url None, user_id 유지
4. caller_profile.portrait_path 있음 → avatar_url=/api/agents/{id}/portrait
5. caller_profile.portrait_path 빈 값 → avatar_url=None (Phase 4 fallback)
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from soul_server.service.agent_registry import AgentProfile, AgentRegistry

# Circular import 회피: mcp_tools를 먼저 완전 import해야 mcp_session_mgmt가
# partially initialized 상태에서 attribute 참조 ImportError를 일으키지 않는다.
# (test_cogito_mcp.py L9와 동일 패턴)
from soul_server.cogito import mcp_tools, mcp_session_mgmt  # noqa: F401, E402

create_agent_session = mcp_session_mgmt.create_agent_session


def _make_task(profile_id: str | None) -> MagicMock:
    t = MagicMock()
    t.profile_id = profile_id
    t.agent_session_id = "sess-new"
    t.status.value = "running"
    return t


def _patch_create_agent_session(*, caller_task, caller_profile, registry, db_node_id="node-x"):
    """create_agent_session 의존성 mock 컨텍스트.

    task_manager.get_task(caller_session_id) → caller_task,
    task_manager._agent_registry.get(profile_id) → caller_profile,
    task_manager._db.node_id → db_node_id,
    create_task → MagicMock task (caller_info를 capture).
    """
    tm = MagicMock()
    tm._db.node_id = db_node_id
    tm._agent_registry = registry  # None이면 if-branch 단락
    tm.get_task = AsyncMock(return_value=caller_task)
    new_task = _make_task("new-agent")
    tm.create_task = AsyncMock(return_value=new_task)
    tm.executor.start_execution = AsyncMock()

    return patch.multiple(
        "soul_server.cogito.mcp_session_mgmt",
        get_task_manager=lambda: tm,
        get_soul_engine=lambda: MagicMock(),
        resource_manager=MagicMock(),
    ), tm


def _captured_caller_info(tm: MagicMock) -> dict:
    return tm.create_task.call_args.args[0].caller_info


@pytest.mark.asyncio
async def test_no_caller_session_id_returns_none_caller_info():
    """caller_session_id 미지정 → caller_info는 None (기존 동작 유지)."""

    ctx, tm = _patch_create_agent_session(caller_task=None, caller_profile=None, registry=None)
    with ctx:
        result = await create_agent_session(agent_id="a1", prompt="hi", caller_session_id=None)

    assert result["agent_session_id"] == "sess-new"
    ci = _captured_caller_info(tm)
    assert ci is None


@pytest.mark.asyncio
async def test_caller_task_missing_yields_all_none_identity_fields():
    """caller_task=None (DB에 없음) → display_name/user_id/avatar_url 모두 None, source/agent_node는 채워짐."""

    ctx, tm = _patch_create_agent_session(caller_task=None, caller_profile=None, registry=MagicMock())
    with ctx:
        await create_agent_session(agent_id="a1", prompt="hi", caller_session_id="sess-missing")

    ci = _captured_caller_info(tm)
    assert ci["source"] == "agent"
    assert ci["agent_node"] == "node-x"
    assert ci["agent_id"] is None
    assert ci["agent_name"] is None
    assert ci["display_name"] is None
    assert ci["user_id"] is None
    assert ci["avatar_url"] is None


@pytest.mark.asyncio
async def test_caller_profile_missing_yields_user_id_only():
    """caller_task 있으나 registry에서 profile 못 찾음 → user_id만 채워지고 display_name/avatar_url None."""

    caller_task = _make_task("agent-x")
    registry = MagicMock()
    registry.get = MagicMock(return_value=None)  # profile 미일치

    ctx, tm = _patch_create_agent_session(caller_task=caller_task, caller_profile=None, registry=registry)
    with ctx:
        await create_agent_session(agent_id="a1", prompt="hi", caller_session_id="sess-1")

    ci = _captured_caller_info(tm)
    assert ci["agent_id"] == "agent-x"
    assert ci["agent_name"] is None
    assert ci["user_id"] == "agent-x"  # caller_task.profile_id 그대로
    assert ci["display_name"] is None
    assert ci["avatar_url"] is None  # caller_profile None → None graceful


@pytest.mark.asyncio
async def test_caller_profile_with_portrait_includes_avatar_url():
    """caller_profile.portrait_path 있으면 avatar_url은 orch 노드 프록시 경로.

    정본: orch-server/api/session_serializer.py:13-15 _build_portrait_proxy_url.
    형식: /api/nodes/{node_id}/agents/{agent_id}/portrait
    근거: caller_info를 표시하는 unified-dashboard는 orch-server에 요청하므로
    soul-server 로컬 라우트(/api/agents/{id}/portrait)는 404.
    """
    caller_task = _make_task("seosoyoung")
    caller_profile = AgentProfile(
        id="seosoyoung", name="서소영", workspace_dir="/ws", portrait_path="/img/seosoyoung.png"
    )
    registry = MagicMock()
    registry.get = MagicMock(return_value=caller_profile)

    ctx, tm = _patch_create_agent_session(
        caller_task=caller_task, caller_profile=caller_profile, registry=registry, db_node_id="node-x"
    )
    with ctx:
        await create_agent_session(agent_id="a1", prompt="hi", caller_session_id="sess-1")

    ci = _captured_caller_info(tm)
    assert ci["agent_name"] == "서소영"
    assert ci["display_name"] == "서소영"
    assert ci["user_id"] == "seosoyoung"
    # 노드 프록시 경로 (orch-server 정본)
    assert ci["avatar_url"] == "/api/nodes/node-x/agents/seosoyoung/portrait"
    # agent_node와 동일 node_id를 사용 (caller_info dict 내부 일관성)
    assert ci["agent_node"] == "node-x"


@pytest.mark.asyncio
async def test_caller_info_avatar_url_uses_node_proxy_path():
    """avatar_url URL 형식이 /api/nodes/{node_id}/agents/{agent_id}/portrait 표준을 따른다.

    정본 인용: orch-server/api/session_serializer.py:13-15.
    """
    caller_task = _make_task("agent-z")
    caller_profile = AgentProfile(
        id="agent-z", name="Z Agent", workspace_dir="/ws", portrait_path="/img/z.png"
    )
    registry = MagicMock()
    registry.get = MagicMock(return_value=caller_profile)

    ctx, tm = _patch_create_agent_session(
        caller_task=caller_task,
        caller_profile=caller_profile,
        registry=registry,
        db_node_id="eias-shopping",
    )
    with ctx:
        await create_agent_session(agent_id="a1", prompt="hi", caller_session_id="sess-1")

    ci = _captured_caller_info(tm)
    assert ci["avatar_url"] == "/api/nodes/eias-shopping/agents/agent-z/portrait"
    # agent_node와 avatar_url의 node_id 부분이 동일 (정합성)
    assert f"/api/nodes/{ci['agent_node']}/" in ci["avatar_url"]


@pytest.mark.asyncio
async def test_empty_portrait_path_yields_none_avatar_url():
    """caller_profile.portrait_path=='' → avatar_url=None (Phase 4 이니셜 fallback)."""

    caller_task = _make_task("agent-y")
    caller_profile = AgentProfile(
        id="agent-y", name="No Portrait", workspace_dir="/ws", portrait_path=""
    )
    registry = MagicMock()
    registry.get = MagicMock(return_value=caller_profile)

    ctx, tm = _patch_create_agent_session(
        caller_task=caller_task, caller_profile=caller_profile, registry=registry
    )
    with ctx:
        await create_agent_session(agent_id="a1", prompt="hi", caller_session_id="sess-1")

    ci = _captured_caller_info(tm)
    assert ci["display_name"] == "No Portrait"
    assert ci["user_id"] == "agent-y"
    assert ci["avatar_url"] is None
