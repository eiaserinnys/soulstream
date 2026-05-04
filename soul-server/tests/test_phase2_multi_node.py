"""Phase 2 multi-node 기능 테스트.

Covers:
- _handle_create_session이 systemPrompt → system_prompt로 전달
- init_multi_node_tools가 list_nodes, list_node_agents, create_remote_agent_session 등록
- reply_to_session 크로스 노드 폴백
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import httpx

from soul_server.cogito import mcp_tools, mcp_multi_node
from soul_server.upstream.adapter import UpstreamAdapter
from soul_server.upstream.protocol import CMD_CREATE_SESSION


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _unwrap(tool_or_func):
    """FunctionTool에서 원본 함수를 꺼낸다."""
    return getattr(tool_or_func, "fn", tool_or_func)


def _make_mock_task(agent_session_id: str = "test-session-1"):
    task = MagicMock()
    task.agent_session_id = agent_session_id
    return task


def _make_adapter(task_manager=None):
    tm = task_manager or MagicMock()
    rm = MagicMock()
    rm.max_concurrent = 3
    rm.get_stats.return_value = {"active": 0, "available": 3, "max": 3}
    bc = MagicMock()
    bc.add_client = MagicMock(return_value=asyncio.Queue())
    bc.remove_client = MagicMock()
    return UpstreamAdapter(
        task_manager=tm,
        soul_engine=MagicMock(),
        resource_manager=rm,
        session_broadcaster=bc,
        upstream_url="ws://localhost:5200/ws/node",
        node_id="test-node",
        session_db=MagicMock(),
        host="localhost",
        port=3105,
    )


def _make_settings(upstream_url: str = "ws://localhost:5200/ws/node", node_id: str = "my-node"):
    settings = MagicMock()
    settings.soulstream_upstream_url = upstream_url
    settings.soulstream_node_id = node_id
    return settings


# ---------------------------------------------------------------------------
# _handle_create_session: systemPrompt → system_prompt
# ---------------------------------------------------------------------------

class TestHandleCreateSessionSystemPrompt:
    async def test_passes_system_prompt_to_create_task(self):
        """systemPrompt 키가 create_task의 system_prompt 파라미터로 전달된다."""
        tm = MagicMock()
        tm.create_task = AsyncMock(return_value=_make_mock_task("sess-sp"))
        tm.executor.start_execution = AsyncMock(return_value=True)
        tm.listener_manager.add_listener = AsyncMock(return_value=True)
        tm.listener_manager.remove_listener = AsyncMock()

        adapter = _make_adapter(task_manager=tm)
        adapter._ws = MagicMock()
        adapter._ws.send_json = AsyncMock()
        adapter._stream_tasks = {}

        cmd = {
            "type": CMD_CREATE_SESSION,
            "requestId": "req-1",
            "prompt": "do work",
            "systemPrompt": "You are a sub-agent.",
        }
        await adapter._dispatcher._handle_create_session(cmd)

        call_kwargs = tm.create_task.call_args.kwargs
        assert call_kwargs.get("system_prompt") == "You are a sub-agent."

    async def test_system_prompt_none_when_absent(self):
        """systemPrompt가 없으면 create_task의 system_prompt는 None이다."""
        tm = MagicMock()
        tm.create_task = AsyncMock(return_value=_make_mock_task("sess-no-sp"))
        tm.executor.start_execution = AsyncMock(return_value=True)
        tm.listener_manager.add_listener = AsyncMock(return_value=True)
        tm.listener_manager.remove_listener = AsyncMock()

        adapter = _make_adapter(task_manager=tm)
        adapter._ws = MagicMock()
        adapter._ws.send_json = AsyncMock()
        adapter._stream_tasks = {}

        cmd = {
            "type": CMD_CREATE_SESSION,
            "requestId": "req-2",
            "prompt": "do work",
        }
        await adapter._dispatcher._handle_create_session(cmd)

        call_kwargs = tm.create_task.call_args.kwargs
        assert call_kwargs.get("system_prompt") is None


# ---------------------------------------------------------------------------
# init_multi_node_tools — 툴 등록
# ---------------------------------------------------------------------------

class TestInitMultiNodeTools:
    def setup_method(self):
        """각 테스트 전에 _orch_base 초기화."""
        mcp_tools._orch_base = None
        mcp_multi_node._orch_base = None

    def teardown_method(self):
        """각 테스트 후 _orch_base 초기화."""
        mcp_tools._orch_base = None
        mcp_multi_node._orch_base = None

    def test_sets_orch_base_ws(self):
        """ws:// URL에서 _orch_base를 http://로 변환한다."""
        settings = _make_settings("ws://localhost:5200/ws/my-node")
        mcp_tools.init_multi_node_tools(settings)
        assert mcp_tools._orch_base == "http://localhost:5200"

    def test_sets_orch_base_wss(self):
        """wss:// URL에서 _orch_base를 https://로 변환한다."""
        settings = _make_settings("wss://example.com:443/ws/my-node")
        mcp_tools.init_multi_node_tools(settings)
        assert mcp_tools._orch_base == "https://example.com:443"

    async def test_list_nodes_registered_as_tool(self):
        """init_multi_node_tools 호출 후 list_nodes 툴이 MCP에 등록된다."""
        settings = _make_settings()
        mcp_tools.init_multi_node_tools(settings)

        tools = await mcp_tools.cogito_mcp.list_tools()
        tool_names = [t.name for t in tools]
        assert "list_nodes" in tool_names

    async def test_list_node_agents_registered_as_tool(self):
        """init_multi_node_tools 호출 후 list_node_agents 툴이 MCP에 등록된다."""
        settings = _make_settings()
        mcp_tools.init_multi_node_tools(settings)

        tools = await mcp_tools.cogito_mcp.list_tools()
        tool_names = [t.name for t in tools]
        assert "list_node_agents" in tool_names

    async def test_create_remote_agent_session_registered_as_tool(self):
        """init_multi_node_tools 호출 후 create_remote_agent_session 툴이 MCP에 등록된다."""
        settings = _make_settings()
        mcp_tools.init_multi_node_tools(settings)

        tools = await mcp_tools.cogito_mcp.list_tools()
        tool_names = [t.name for t in tools]
        assert "create_remote_agent_session" in tool_names

    @patch("soul_server.cogito.mcp_multi_node.httpx")
    async def test_list_nodes_calls_orch_api(self, mock_httpx):
        """list_nodes가 _orch_base/api/nodes를 GET한다."""
        settings = _make_settings("ws://orch:5200/ws/n1")
        mcp_tools.init_multi_node_tools(settings)

        mock_client = AsyncMock()
        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json = MagicMock(return_value={"nodes": []})
        mock_client.get = AsyncMock(return_value=mock_resp)
        mock_httpx.AsyncClient.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_httpx.AsyncClient.return_value.__aexit__ = AsyncMock(return_value=None)

        # list_nodes는 init_multi_node_tools 내부에서 등록된 클로저 함수
        tools = await mcp_tools.cogito_mcp.list_tools()
        list_nodes_tool = next(t for t in tools if t.name == "list_nodes")
        result = await list_nodes_tool.fn()

        mock_client.get.assert_called_once_with("http://orch:5200/api/nodes")
        assert result == {"nodes": []}

    @patch("soul_server.cogito.mcp_multi_node.get_task_manager")
    @patch("soul_server.cogito.mcp_multi_node.httpx")
    async def test_create_remote_agent_session_includes_caller_info(self, mock_httpx, mock_get_tm):
        """caller_session_id가 있으면 body에 caller_session_id가 포함되어야 한다."""
        settings = _make_settings("ws://orch:5200/ws/n1", node_id="node-alpha")
        mcp_tools.init_multi_node_tools(settings)

        # caller_session_id가 있으면 내부에서 get_task_manager() 호출됨 → mock 필요
        tm = MagicMock()
        tm.get_task = AsyncMock(return_value=None)  # caller_task 조회 실패 시나리오
        tm._agent_registry = None
        tm._db = MagicMock()
        tm._db.node_id = "node-alpha"
        mock_get_tm.return_value = tm

        mock_client = AsyncMock()
        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json = MagicMock(return_value={"agentSessionId": "new-sess"})
        mock_client.post = AsyncMock(return_value=mock_resp)
        mock_httpx.AsyncClient.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_httpx.AsyncClient.return_value.__aexit__ = AsyncMock(return_value=None)

        tools = await mcp_tools.cogito_mcp.list_tools()
        create_tool = next(t for t in tools if t.name == "create_remote_agent_session")
        result = await create_tool.fn(
            node_id="node-beta",
            agent_id="agent-x",
            prompt="do task",
            caller_session_id="sess-caller",
        )

        assert mock_client.post.called
        call_args = mock_client.post.call_args
        body = call_args.kwargs.get("json") or call_args[1].get("json") or call_args[0][1]
        # system_prompt 대신 caller_session_id를 직접 전달하는 방식으로 변경됨
        assert "caller_session_id" in body
        assert body["caller_session_id"] == "sess-caller"
        # system_prompt는 더 이상 생성하지 않음
        assert "system_prompt" not in body

    @patch("soul_server.cogito.mcp_multi_node.httpx")
    async def test_create_remote_agent_session_no_caller_session_when_no_caller(self, mock_httpx):
        """caller_session_id가 없으면 body에 caller_session_id·caller_info 키가 없어야 한다."""
        settings = _make_settings("ws://orch:5200/ws/n1")
        mcp_tools.init_multi_node_tools(settings)

        mock_client = AsyncMock()
        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json = MagicMock(return_value={"agentSessionId": "new-sess"})
        mock_client.post = AsyncMock(return_value=mock_resp)
        mock_httpx.AsyncClient.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_httpx.AsyncClient.return_value.__aexit__ = AsyncMock(return_value=None)

        tools = await mcp_tools.cogito_mcp.list_tools()
        create_tool = next(t for t in tools if t.name == "create_remote_agent_session")
        await create_tool.fn(
            node_id="node-beta",
            agent_id=None,
            prompt="do task",
        )

        call_args = mock_client.post.call_args
        body = call_args.kwargs.get("json") or call_args[1].get("json") or call_args[0][1]
        assert "system_prompt" not in body
        assert "caller_session_id" not in body
        # caller_session_id가 없으면 caller_info도 없다 (None은 필터링됨)
        assert "caller_info" not in body

    @patch("soul_server.cogito.mcp_multi_node.get_task_manager")
    @patch("soul_server.cogito.mcp_multi_node.httpx")
    async def test_create_remote_agent_session_body_includes_caller_info(
        self, mock_httpx, mock_get_tm
    ):
        """caller_session_id가 있으면 body.caller_info에 source='agent'와 발신 세션의 프로필 정보가 포함되어야 한다.

        이 값이 orch→soul WS 페이로드를 거쳐 원격 노드의 Task.caller_info까지 도달한다.
        """
        settings = _make_settings("ws://orch:5200/ws/n1", node_id="node-src")
        mcp_tools.init_multi_node_tools(settings)

        # 발신 세션의 Task와 Profile 모킹
        caller_task = MagicMock()
        caller_task.profile_id = "agent-parent"

        caller_profile = MagicMock()
        caller_profile.name = "Parent Agent"

        mock_registry = MagicMock()
        mock_registry.get.return_value = caller_profile

        tm = MagicMock()
        tm.get_task = AsyncMock(return_value=caller_task)
        tm._agent_registry = mock_registry
        tm._db = MagicMock()
        tm._db.node_id = "node-src"
        mock_get_tm.return_value = tm

        # httpx mock
        mock_client = AsyncMock()
        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json = MagicMock(return_value={"agentSessionId": "remote-sess"})
        mock_client.post = AsyncMock(return_value=mock_resp)
        mock_httpx.AsyncClient.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_httpx.AsyncClient.return_value.__aexit__ = AsyncMock(return_value=None)

        tools = await mcp_tools.cogito_mcp.list_tools()
        create_tool = next(t for t in tools if t.name == "create_remote_agent_session")
        await create_tool.fn(
            node_id="node-dest",
            agent_id="agent-child",
            prompt="sub-task",
            caller_session_id="sess-parent-1",
        )

        call_args = mock_client.post.call_args
        body = call_args.kwargs.get("json") or call_args[1].get("json") or call_args[0][1]
        assert "caller_info" in body, f"body={body}"
        ci = body["caller_info"]
        assert ci["source"] == "agent"
        # NOTE(잔존 정합성 부채): caller_info.parent_session_id는 caller_session_id와 중복이지만
        # frontend 호환을 위해 일시 유지. 후속 카드에서 제거 예정.
        assert ci["parent_session_id"] == "sess-parent-1"
        assert body["caller_session_id"] == "sess-parent-1"
        assert ci["agent_node"] == "node-src"
        assert ci["agent_id"] == "agent-parent"
        assert ci["agent_name"] == "Parent Agent"


# ---------------------------------------------------------------------------
# reply_to_session 크로스 노드 폴백
# ---------------------------------------------------------------------------

class TestReplyToSessionFallback:
    def setup_method(self):
        mcp_tools._orch_base = None
        mcp_multi_node._orch_base = None

    def teardown_method(self):
        mcp_tools._orch_base = None
        mcp_multi_node._orch_base = None

    @patch("soul_server.cogito.mcp_session_mgmt.get_task_manager")
    async def test_returns_error_when_local_fails_and_no_orch_base(self, mock_get_tm):
        """로컬 실패 + _orch_base 없음 → error 반환."""
        tm = MagicMock()
        tm.add_intervention = AsyncMock(side_effect=RuntimeError("session not found"))
        mock_get_tm.return_value = tm

        fn = _unwrap(mcp_tools.send_message_to_session)
        result = await fn(target_session_id="sess-remote", message="hello")

        assert result["ok"] is False
        assert "session not found" in result["error"]

    @patch("soul_server.cogito.mcp_session_mgmt.get_task_manager")
    @patch("soul_server.cogito.mcp_session_mgmt.httpx")
    async def test_falls_back_to_orch_when_local_fails(self, mock_httpx, mock_get_tm):
        """로컬 실패 + _orch_base 있음 → 오케스트레이터 경유 성공."""
        mcp_multi_node._orch_base = "http://orch:5200"

        tm = MagicMock()
        tm.add_intervention = AsyncMock(side_effect=RuntimeError("not found locally"))
        mock_get_tm.return_value = tm

        mock_client = AsyncMock()
        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json = MagicMock(return_value={"ok": True})
        mock_client.post = AsyncMock(return_value=mock_resp)
        mock_httpx.AsyncClient.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_httpx.AsyncClient.return_value.__aexit__ = AsyncMock(return_value=None)

        fn = _unwrap(mcp_tools.send_message_to_session)
        result = await fn(target_session_id="sess-remote", message="result from agent")

        assert result["ok"] is True
        mock_client.post.assert_called_once()
        call_url = mock_client.post.call_args[0][0]
        assert "sess-remote" in call_url
        assert "intervene" in call_url

    @patch("soul_server.cogito.mcp_session_mgmt.get_task_manager")
    @patch("soul_server.cogito.mcp_session_mgmt.httpx")
    async def test_returns_combined_error_when_both_fail(self, mock_httpx, mock_get_tm):
        """로컬 실패 + 원격 실패 → 둘 다 에러 메시지 포함."""
        mcp_multi_node._orch_base = "http://orch:5200"

        tm = MagicMock()
        tm.add_intervention = AsyncMock(side_effect=RuntimeError("local error"))
        mock_get_tm.return_value = tm

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(side_effect=RuntimeError("remote error"))
        mock_httpx.AsyncClient.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_httpx.AsyncClient.return_value.__aexit__ = AsyncMock(return_value=None)

        fn = _unwrap(mcp_tools.send_message_to_session)
        result = await fn(target_session_id="sess-remote", message="hi")

        assert result["ok"] is False
        assert "local error" in result["error"]
        assert "remote error" in result["error"]

    @patch("soul_server.cogito.mcp_session_mgmt.get_task_manager")
    async def test_local_success_does_not_call_orch(self, mock_get_tm):
        """로컬 성공 시 오케스트레이터를 호출하지 않는다."""
        mcp_multi_node._orch_base = "http://orch:5200"

        tm = MagicMock()
        tm.add_intervention = AsyncMock(return_value={"status": "ok"})
        mock_get_tm.return_value = tm

        fn = _unwrap(mcp_tools.send_message_to_session)
        with patch("soul_server.cogito.mcp_session_mgmt.httpx") as mock_httpx:
            result = await fn(target_session_id="sess-local", message="hi")

        assert result["ok"] is True
        mock_httpx.AsyncClient.assert_not_called()
