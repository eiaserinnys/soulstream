"""
test_create_remote_agent_session_caller_info — cogito MCP create_remote_agent_session(1-B)의
caller_info 자동 첨부 검증.

직전 결함 (260507.10.caller-info-propagation-fix 카드):
1-B(원격 노드 위임) 진입점이 통합 v1 promote 키(display_name/user_id/avatar_url)를 *누락*하여
원격 노드의 Task.caller_info에 신원 정보가 도달하지 않았다 (1-A와 비대칭).
fix: build_agent_caller_info helper 호출로 통합. 1-A·1-B 공유.

검증 케이스 (1-A `test_create_agent_session_caller_info.py`와 1:1 mirror + v1 7키 set 단언):
1. caller_session_id 미지정 → body에 caller_info 필드 부재 (None 필터 통과)
2. caller_task=None (DB에 없음) → caller_info에 source/agent_node 채움, 신원 필드 모두 None
3. caller_profile=None (registry 미일치) → display_name/avatar_url None, user_id 유지
4. caller_profile.portrait_path 있음 → avatar_url=/api/nodes/{node}/agents/{id}/portrait
5. caller_profile.portrait_path 빈 값 → avatar_url=None
6. v1 통합 스키마 7개 키 set 완전 일치 (P1 보강 — orch→WS→1-E 전파 게이트)

httpx body capture 패턴: respx로 mocking + request.content JSON 파싱.
"""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import respx
from httpx import Response

from soul_server.service.agent_registry import AgentProfile

# Circular import 회피: mcp_tools를 먼저 완전 import
# (test_create_agent_session_caller_info.py L25와 동일 패턴)
from soul_server.cogito import mcp_tools, mcp_multi_node  # noqa: F401, E402

create_remote_agent_session = mcp_multi_node.create_remote_agent_session


# ---------------------------------------------------------------------------
# Fixtures + helpers
# ---------------------------------------------------------------------------

ORCH_BASE = "http://orch.test"


def _make_task(profile_id: str | None) -> MagicMock:
    t = MagicMock()
    t.profile_id = profile_id
    t.agent_session_id = "caller-sess"
    return t


@pytest.fixture
def patched_orch_state():
    """init() 우회 — module-level 함수 직접 호출용 _orch_base/_orch_headers 임시 셋업."""
    with patch.object(mcp_multi_node, "_orch_base", ORCH_BASE), \
         patch.object(mcp_multi_node, "_orch_headers", {}):
        yield


@pytest.fixture
def respx_orch():
    """respx로 orch-server POST /api/sessions를 mock하여 httpx body capture."""
    with respx.mock(base_url=ORCH_BASE, assert_all_called=False) as router:
        router.post("/api/sessions").respond(
            200,
            json={"agent_session_id": "remote-sess", "status": "running"},
        )
        yield router


def _patch_task_manager(
    *,
    caller_task: MagicMock | None = None,
    caller_profile: AgentProfile | None = None,
    registry: MagicMock | None = None,
    db_node_id: str = "node-x",
):
    """create_remote_agent_session가 의존하는 task_manager mock."""
    tm = MagicMock()
    tm._db.node_id = db_node_id
    tm._agent_registry = registry
    tm.get_task = AsyncMock(return_value=caller_task)
    return patch.object(mcp_multi_node, "get_task_manager", return_value=tm)


def _captured_body(router: respx.Router) -> dict:
    """respx에 캡처된 마지막 POST 요청의 body를 JSON 파싱하여 반환."""
    assert router.calls.call_count == 1, f"expected 1 POST, got {router.calls.call_count}"
    return json.loads(router.calls.last.request.content)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_no_caller_session_id_omits_caller_info_from_body(
    patched_orch_state, respx_orch
):
    """caller_session_id 미지정 → body.caller_info 키 부재 (None 필터)."""
    with _patch_task_manager():
        await create_remote_agent_session(
            node_id="other-node",
            agent_id="a1",
            prompt="hi",
            caller_session_id=None,
        )

    body = _captured_body(respx_orch)
    assert "caller_info" not in body


@pytest.mark.asyncio
async def test_caller_task_missing_yields_all_none_identity_fields(
    patched_orch_state, respx_orch
):
    """caller_task=None → caller_info에 source/agent_node 채움, 신원 필드 모두 None."""
    with _patch_task_manager(
        caller_task=None, caller_profile=None, registry=MagicMock()
    ):
        await create_remote_agent_session(
            node_id="other-node",
            agent_id="a1",
            prompt="hi",
            caller_session_id="sess-missing",
        )

    body = _captured_body(respx_orch)
    ci = body["caller_info"]
    assert ci["source"] == "agent"
    assert ci["agent_node"] == "node-x"
    assert ci["agent_id"] is None
    assert ci["agent_name"] is None
    assert ci["display_name"] is None
    assert ci["user_id"] is None
    assert ci["avatar_url"] is None


@pytest.mark.asyncio
async def test_caller_profile_missing_yields_user_id_only(
    patched_orch_state, respx_orch
):
    """caller_task 있으나 registry에서 profile 못 찾음 → user_id만 채워지고 display_name/avatar_url None."""
    caller_task = _make_task("agent-x")
    registry = MagicMock()
    registry.get = MagicMock(return_value=None)  # profile 미일치

    with _patch_task_manager(
        caller_task=caller_task, caller_profile=None, registry=registry
    ):
        await create_remote_agent_session(
            node_id="other-node",
            agent_id="a1",
            prompt="hi",
            caller_session_id="sess-1",
        )

    body = _captured_body(respx_orch)
    ci = body["caller_info"]
    assert ci["agent_id"] == "agent-x"
    assert ci["agent_name"] is None
    assert ci["user_id"] == "agent-x"  # caller_task.profile_id 그대로
    assert ci["display_name"] is None
    assert ci["avatar_url"] is None  # caller_profile None → None graceful


@pytest.mark.asyncio
async def test_caller_profile_with_portrait_includes_avatar_url(
    patched_orch_state, respx_orch
):
    """caller_profile.portrait_path 있으면 avatar_url은 orch 노드 프록시 경로.

    형식: /api/nodes/{node_id}/agents/{agent_id}/portrait
    근거: caller_info를 표시하는 unified-dashboard는 orch-server에 요청하므로
    soul-server 로컬 라우트(/api/agents/{id}/portrait)는 404.
    """
    caller_task = _make_task("seosoyoung")
    caller_profile = AgentProfile(
        id="seosoyoung",
        name="서소영",
        workspace_dir="/ws",
        portrait_path="/img/seosoyoung.png",
    )
    registry = MagicMock()
    registry.get = MagicMock(return_value=caller_profile)

    with _patch_task_manager(
        caller_task=caller_task,
        caller_profile=caller_profile,
        registry=registry,
        db_node_id="node-x",
    ):
        await create_remote_agent_session(
            node_id="other-node",
            agent_id="a1",
            prompt="hi",
            caller_session_id="sess-1",
        )

    body = _captured_body(respx_orch)
    ci = body["caller_info"]
    assert ci["agent_name"] == "서소영"
    assert ci["display_name"] == "서소영"
    assert ci["user_id"] == "seosoyoung"
    # 노드 프록시 경로 (orch-server 정본)
    assert ci["avatar_url"] == "/api/nodes/node-x/agents/seosoyoung/portrait"
    # agent_node와 동일 node_id를 사용 (caller_info dict 내부 일관성)
    assert ci["agent_node"] == "node-x"


@pytest.mark.asyncio
async def test_empty_portrait_path_yields_none_avatar_url(
    patched_orch_state, respx_orch
):
    """caller_profile.portrait_path=='' → avatar_url=None."""
    caller_task = _make_task("agent-y")
    caller_profile = AgentProfile(
        id="agent-y",
        name="No Portrait",
        workspace_dir="/ws",
        portrait_path="",
    )
    registry = MagicMock()
    registry.get = MagicMock(return_value=caller_profile)

    with _patch_task_manager(
        caller_task=caller_task,
        caller_profile=caller_profile,
        registry=registry,
    ):
        await create_remote_agent_session(
            node_id="other-node",
            agent_id="a1",
            prompt="hi",
            caller_session_id="sess-1",
        )

    body = _captured_body(respx_orch)
    ci = body["caller_info"]
    assert ci["display_name"] == "No Portrait"
    assert ci["user_id"] == "agent-y"
    assert ci["avatar_url"] is None


@pytest.mark.asyncio
async def test_v1_schema_keys_complete_set(patched_orch_state, respx_orch):
    """P1 보강: 일반 케이스에서 caller_info dict가 v1 통합 스키마 7개 키를 *모두* 포함.

    이 단언은 1-B fix가 v1 promote 키 누락을 영구히 방지함을 게이트한다.
    1-B → orch /api/sessions → WS CreateSessionCmd.caller_info → 1-E command_handler →
    Task.caller_info 전파 흐름의 진입점에서 dict 형태가 망가지지 않는지 보호.
    """
    caller_task = _make_task("agent-z")
    caller_profile = AgentProfile(
        id="agent-z",
        name="Z Agent",
        workspace_dir="/ws",
        portrait_path="/img/z.png",
    )
    registry = MagicMock()
    registry.get = MagicMock(return_value=caller_profile)

    with _patch_task_manager(
        caller_task=caller_task,
        caller_profile=caller_profile,
        registry=registry,
        db_node_id="eias-shopping",
    ):
        await create_remote_agent_session(
            node_id="other-node",
            agent_id="a1",
            prompt="hi",
            caller_session_id="sess-1",
        )

    body = _captured_body(respx_orch)
    ci = body["caller_info"]
    # v1 통합 스키마 정본 — set 비교로 키 추가·삭제·오타 모두 RED
    assert set(ci.keys()) == {
        "source",
        "agent_node",
        "agent_id",
        "agent_name",
        "display_name",
        "user_id",
        "avatar_url",
    }
    # 정합성 (ci 안의 값 동등성)
    assert ci["agent_node"] == "eias-shopping"
    assert f"/api/nodes/{ci['agent_node']}/" in ci["avatar_url"]
