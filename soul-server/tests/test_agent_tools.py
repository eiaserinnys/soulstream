"""Tests for cogito MCP agent request tools (Phase 1).

신규 툴:
- list_local_agents
- create_agent_session
- send_message_to_session (구: reply_to_session)
"""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from soul_server.cogito import mcp_tools


def _unwrap(tool_or_func):
    """FunctionTool에서 원본 함수를 꺼낸다.

    fastmcp 2.x의 @tool()은 FunctionTool을 반환하므로,
    테스트에서 직접 호출할 때는 .fn으로 원본 함수를 꺼내야 한다.
    """
    return getattr(tool_or_func, "fn", tool_or_func)


# ---------------------------------------------------------------------------
# list_local_agents
# ---------------------------------------------------------------------------

class TestListLocalAgents:
    async def test_returns_agent_list(self):
        """AgentRegistry에 에이전트가 있으면 목록을 반환한다."""
        profile1 = MagicMock()
        profile1.id = "agent-alpha"
        profile1.name = "Alpha"
        profile1.max_turns = 10

        profile2 = MagicMock()
        profile2.id = "agent-beta"
        profile2.name = "Beta"
        profile2.max_turns = None

        mock_registry = MagicMock()
        mock_registry.list.return_value = [profile1, profile2]

        fn = _unwrap(mcp_tools.list_local_agents)
        with patch("soul_server.main.get_agent_registry", return_value=mock_registry):
            result = await fn()

        assert "agents" in result
        assert len(result["agents"]) == 2
        assert result["agents"][0] == {"id": "agent-alpha", "name": "Alpha", "max_turns": 10}
        assert result["agents"][1] == {"id": "agent-beta", "name": "Beta", "max_turns": None}

    async def test_returns_empty_list_on_runtime_error(self):
        """AgentRegistry 미초기화(RuntimeError) 시 빈 목록을 반환한다."""
        fn = _unwrap(mcp_tools.list_local_agents)
        with patch("soul_server.main.get_agent_registry", side_effect=RuntimeError("미초기화")):
            result = await fn()

        assert result == {"agents": []}

    async def test_returns_empty_list_when_no_agents(self):
        """AgentRegistry가 비어있으면 빈 목록을 반환한다."""
        mock_registry = MagicMock()
        mock_registry.list.return_value = []

        fn = _unwrap(mcp_tools.list_local_agents)
        with patch("soul_server.main.get_agent_registry", return_value=mock_registry):
            result = await fn()

        assert result == {"agents": []}


# ---------------------------------------------------------------------------
# create_agent_session
# ---------------------------------------------------------------------------

class TestCreateAgentSession:
    def _make_task(self, agent_session_id="sess-abc123", status="pending"):
        task = MagicMock()
        task.agent_session_id = agent_session_id
        task.status = MagicMock()
        task.status.value = status
        return task

    async def test_creates_session_without_caller(self):
        """caller_session_id 없을 때 caller_session_id=None으로 create_task를 호출해야 한다."""
        mock_task = self._make_task()
        mock_task.profile_id = None
        mock_task.caller_agent_info = None
        mock_tm = MagicMock()
        mock_tm.create_task = AsyncMock(return_value=mock_task)

        fn = _unwrap(mcp_tools.create_agent_session)
        with patch("soul_server.cogito.mcp_tools.get_task_manager", return_value=mock_tm):
            result = await fn(agent_id="agent-alpha", prompt="작업 수행해줘")

        assert result["agent_session_id"] == "sess-abc123"
        assert result["status"] == "pending"

        mock_tm.create_task.assert_called_once_with(
            prompt="작업 수행해줘",
            profile_id="agent-alpha",
            folder_id=None,
            caller_session_id=None,
        )

    async def test_creates_session_with_caller_session_id(self):
        """caller_session_id가 있으면 create_task에 caller_session_id로 전달되어야 한다."""
        mock_task = self._make_task()
        mock_task.profile_id = None
        mock_task.caller_agent_info = None
        mock_tm = MagicMock()
        mock_tm.create_task = AsyncMock(return_value=mock_task)
        mock_tm.get_task = AsyncMock(return_value=None)
        mock_tm._agent_registry = None

        fn = _unwrap(mcp_tools.create_agent_session)
        with patch("soul_server.cogito.mcp_tools.get_task_manager", return_value=mock_tm):
            result = await fn(
                agent_id="agent-alpha",
                prompt="작업 수행해줘",
                caller_session_id="sess-caller-999",
            )

        assert result["agent_session_id"] == "sess-abc123"

        call_kwargs = mock_tm.create_task.call_args.kwargs
        assert call_kwargs["caller_session_id"] == "sess-caller-999"
        # system_prompt는 전달하지 않음 (자동 완료 보고 방식으로 변경됨)
        assert "system_prompt" not in call_kwargs

    async def test_creates_session_with_folder_id(self):
        """folder_id가 전달되면 create_task에 그대로 전달되어야 한다."""
        mock_task = self._make_task()
        mock_tm = MagicMock()
        mock_tm.create_task = AsyncMock(return_value=mock_task)

        fn = _unwrap(mcp_tools.create_agent_session)
        with patch("soul_server.cogito.mcp_tools.get_task_manager", return_value=mock_tm):
            await fn(agent_id=None, prompt="테스트", folder_id="folder-xyz")

        call_kwargs = mock_tm.create_task.call_args.kwargs
        assert call_kwargs["folder_id"] == "folder-xyz"
        assert call_kwargs["profile_id"] is None

    async def test_returns_task_status(self):
        """반환값에 agent_session_id와 status가 포함되어야 한다."""
        mock_task = self._make_task(agent_session_id="sess-new-001", status="running")
        mock_tm = MagicMock()
        mock_tm.create_task = AsyncMock(return_value=mock_task)

        fn = _unwrap(mcp_tools.create_agent_session)
        with patch("soul_server.cogito.mcp_tools.get_task_manager", return_value=mock_tm):
            result = await fn(agent_id=None, prompt="test")

        assert result == {"agent_session_id": "sess-new-001", "status": "running"}


# ---------------------------------------------------------------------------
# send_message_to_session (구: reply_to_session)
# ---------------------------------------------------------------------------

class TestSendMessageToSession:
    async def test_ok_on_success(self):
        """add_intervention 성공 시 ok=True와 detail을 반환해야 한다."""
        mock_tm = MagicMock()
        mock_tm.add_intervention = AsyncMock(return_value={"queue_position": 1})

        fn = _unwrap(mcp_tools.send_message_to_session)
        with patch("soul_server.cogito.mcp_tools.get_task_manager", return_value=mock_tm):
            result = await fn(target_session_id="sess-target-123", message="작업 완료됐습니다")

        assert result["ok"] is True
        assert result["detail"] == {"queue_position": 1}

        mock_tm.add_intervention.assert_called_once_with(
            agent_session_id="sess-target-123",
            text="작업 완료됐습니다",
            user="agent",
        )

    async def test_error_on_exception(self):
        """add_intervention 예외 발생 시 ok=False와 error를 반환해야 한다."""
        mock_tm = MagicMock()
        mock_tm.add_intervention = AsyncMock(side_effect=RuntimeError("세션 없음"))

        fn = _unwrap(mcp_tools.send_message_to_session)
        with patch("soul_server.cogito.mcp_tools.get_task_manager", return_value=mock_tm):
            result = await fn(target_session_id="sess-missing", message="응답")

        assert result["ok"] is False
        assert "세션 없음" in result["error"]

    async def test_passes_agent_as_user(self):
        """user 파라미터는 항상 'agent'로 전달되어야 한다."""
        mock_tm = MagicMock()
        mock_tm.add_intervention = AsyncMock(return_value={"auto_resumed": True})

        fn = _unwrap(mcp_tools.send_message_to_session)
        with patch("soul_server.cogito.mcp_tools.get_task_manager", return_value=mock_tm):
            await fn(target_session_id="sess-xyz", message="hello")

        call_kwargs = mock_tm.add_intervention.call_args.kwargs
        assert call_kwargs["user"] == "agent"


# ---------------------------------------------------------------------------
# init_multi_node_tools
# ---------------------------------------------------------------------------

class TestInitMultiNodeTools:
    def test_sets_orch_base_from_ws_url(self):
        """ws:// URL을 http://로 변환하고 /ws 이후를 제거해야 한다."""
        settings = MagicMock()
        settings.soulstream_upstream_url = "ws://localhost:3200/ws/my-node"

        mcp_tools._orch_base = None
        mcp_tools.init_multi_node_tools(settings)

        assert mcp_tools._orch_base == "http://localhost:3200"

    def test_sets_orch_base_from_wss_url(self):
        """wss:// URL을 https://로 변환해야 한다."""
        settings = MagicMock()
        settings.soulstream_upstream_url = "wss://prod.example.com:443/ws/node-1"

        mcp_tools._orch_base = None
        mcp_tools.init_multi_node_tools(settings)

        assert mcp_tools._orch_base == "https://prod.example.com:443"

    def teardown_method(self, method):
        """각 테스트 후 _orch_base 초기화."""
        mcp_tools._orch_base = None
