"""hook_builder.build_hooks() 단위 테스트"""

import pytest
from collections import deque
from unittest.mock import MagicMock

from soul_server.claude.hook_builder import build_hooks
from soul_server.engine.types import (
    EngineEvent,
    SubagentStartEngineEvent,
    SubagentStopEngineEvent,
)


# HookMatcher / HookContext mock — SDK가 없어도 테스트 가능하도록
@pytest.fixture(autouse=True)
def _patch_sdk_hooks(monkeypatch):
    """HookMatcher를 간단한 dataclass로 치환"""

    class FakeHookMatcher:
        def __init__(self, matcher=None, hooks=None):
            self.matcher = matcher
            self.hooks = hooks or []

    import soul_server.claude.hook_builder as hb

    monkeypatch.setattr(hb, "HookMatcher", FakeHookMatcher)


class TestBuildHooksStructure:
    """build_hooks 반환 구조 테스트"""

    def test_always_has_subagent_hooks(self):
        """compact_events 유무와 관계없이 SubagentStart/Stop 훅이 항상 포함된다"""
        event_queue: deque[EngineEvent] = deque()
        hooks = build_hooks(compact_events=None, event_queue=event_queue)

        assert hooks is not None
        assert "SubagentStart" in hooks
        assert "SubagentStop" in hooks

    def test_always_has_pre_tool_use_hook(self):
        """PreToolUse 훅이 항상 포함된다"""
        event_queue: deque[EngineEvent] = deque()
        hooks = build_hooks(compact_events=None, event_queue=event_queue)

        assert hooks is not None
        assert "PreToolUse" in hooks

    def test_pre_tool_use_hook_matches_agent_tool(self):
        """PreToolUse 훅의 matcher가 'Agent'로 설정된다"""
        event_queue: deque[EngineEvent] = deque()
        hooks = build_hooks(compact_events=None, event_queue=event_queue)

        matcher = hooks["PreToolUse"][0]
        assert matcher.matcher == "Agent"

    def test_pre_compact_included_when_events_list_provided(self):
        """compact_events가 리스트일 때 PreCompact 훅이 포함된다"""
        event_queue: deque[EngineEvent] = deque()
        compact_events = []
        hooks = build_hooks(compact_events=compact_events, event_queue=event_queue)

        assert "PreCompact" in hooks

    def test_pre_compact_excluded_when_events_is_none(self):
        """compact_events가 None이면 PreCompact 훅이 제외된다"""
        event_queue: deque[EngineEvent] = deque()
        hooks = build_hooks(compact_events=None, event_queue=event_queue)

        assert "PreCompact" not in hooks

    def test_returns_none_when_no_hooks(self):
        """등록할 훅이 없으면 None 반환 (현재 SubagentStart/Stop이 항상 있으므로 실제로 None이 되지 않음)"""
        # 이 테스트는 현재 구현상 hooks가 빈 dict이 될 수 없음을 확인
        event_queue: deque[EngineEvent] = deque()
        hooks = build_hooks(compact_events=None, event_queue=event_queue)
        assert hooks is not None


class TestPreCompactHook:
    """PreCompact 훅 동작 테스트"""

    @pytest.mark.asyncio
    async def test_pre_compact_appends_event(self):
        """PreCompact 훅이 compact_events 리스트에 이벤트를 추가한다"""
        event_queue: deque[EngineEvent] = deque()
        compact_events = []
        hooks = build_hooks(compact_events=compact_events, event_queue=event_queue)

        pre_compact_fn = hooks["PreCompact"][0].hooks[0]
        result = await pre_compact_fn(
            {"trigger": "auto"}, "toolu-x", MagicMock()
        )

        assert len(compact_events) == 1
        assert compact_events[0]["trigger"] == "auto"
        assert "컨텍스트 컴팩트" in compact_events[0]["message"]
        assert result == {}

    @pytest.mark.asyncio
    async def test_pre_compact_default_trigger(self):
        """trigger가 없으면 'auto'로 기본 설정된다"""
        event_queue: deque[EngineEvent] = deque()
        compact_events = []
        hooks = build_hooks(compact_events=compact_events, event_queue=event_queue)

        pre_compact_fn = hooks["PreCompact"][0].hooks[0]
        await pre_compact_fn({}, None, MagicMock())

        assert compact_events[0]["trigger"] == "auto"


class TestSubagentStartHook:
    """SubagentStart 훅 동작 테스트"""

    @pytest.mark.asyncio
    async def test_appends_start_event_to_queue(self):
        """SubagentStart 훅이 event_queue에 SubagentStartEngineEvent를 추가한다"""
        event_queue: deque[EngineEvent] = deque()
        hooks = build_hooks(compact_events=None, event_queue=event_queue)

        start_fn = hooks["SubagentStart"][0].hooks[0]
        result = await start_fn(
            {"agent_id": "agent-1", "agent_type": "task"},
            "toolu-y",
            MagicMock(),
        )

        assert len(event_queue) == 1
        event = event_queue[0]
        assert isinstance(event, SubagentStartEngineEvent)
        assert event.agent_id == "agent-1"
        assert event.agent_type == "task"
        assert event.parent_event_id == "toolu-y"
        assert result == {}

    @pytest.mark.asyncio
    async def test_parent_event_id_from_tool_use_id(self):
        """parent_event_id는 SDK가 전달한 tool_use_id를 사용한다"""
        event_queue: deque[EngineEvent] = deque()
        hooks = build_hooks(compact_events=None, event_queue=event_queue)

        start_fn = hooks["SubagentStart"][0].hooks[0]
        await start_fn(
            {"agent_id": "a-2", "agent_type": "code"},
            "toolu-z",
            MagicMock(),
        )

        assert event_queue[0].parent_event_id == "toolu-z"

    @pytest.mark.asyncio
    async def test_parent_event_id_empty_when_no_tool_use_id(self):
        """tool_use_id가 None이면 parent_event_id는 빈 문자열"""
        event_queue: deque[EngineEvent] = deque()
        hooks = build_hooks(compact_events=None, event_queue=event_queue)

        start_fn = hooks["SubagentStart"][0].hooks[0]
        await start_fn(
            {"agent_id": "a-3", "agent_type": "task"},
            None,
            MagicMock(),
        )

        assert event_queue[0].parent_event_id == ""

    @pytest.mark.asyncio
    async def test_default_agent_fields(self):
        """agent_id/agent_type가 없으면 빈 문자열"""
        event_queue: deque[EngineEvent] = deque()
        hooks = build_hooks(compact_events=None, event_queue=event_queue)

        start_fn = hooks["SubagentStart"][0].hooks[0]
        await start_fn({}, None, MagicMock())

        event = event_queue[0]
        assert event.agent_id == ""
        assert event.agent_type == ""


class TestSubagentStopHook:
    """SubagentStop 훅 동작 테스트"""

    @pytest.mark.asyncio
    async def test_appends_stop_event_to_queue(self):
        """SubagentStop 훅이 event_queue에 SubagentStopEngineEvent를 추가한다"""
        event_queue: deque[EngineEvent] = deque()
        hooks = build_hooks(compact_events=None, event_queue=event_queue)

        stop_fn = hooks["SubagentStop"][0].hooks[0]
        result = await stop_fn(
            {"agent_id": "agent-1"}, "toolu-w", MagicMock()
        )

        assert len(event_queue) == 1
        event = event_queue[0]
        assert isinstance(event, SubagentStopEngineEvent)
        assert event.agent_id == "agent-1"
        assert event.parent_event_id == "toolu-w"
        assert result == {}

    @pytest.mark.asyncio
    async def test_stop_default_agent_id(self):
        """agent_id가 없으면 빈 문자열"""
        event_queue: deque[EngineEvent] = deque()
        hooks = build_hooks(compact_events=None, event_queue=event_queue)

        stop_fn = hooks["SubagentStop"][0].hooks[0]
        await stop_fn({}, None, MagicMock())

        assert event_queue[0].agent_id == ""


class TestPreToolUseAgentHook:
    """PreToolUse Agent 훅 — run_in_background 차단 테스트"""

    @pytest.mark.asyncio
    async def test_removes_run_in_background_true(self):
        """run_in_background=True가 있으면 해당 키를 제거한 updatedInput을 반환한다"""
        event_queue: deque[EngineEvent] = deque()
        hooks = build_hooks(compact_events=None, event_queue=event_queue)

        pre_tool_use_fn = hooks["PreToolUse"][0].hooks[0]
        hook_input = {
            "tool_name": "Agent",
            "tool_input": {
                "description": "작업 설명",
                "prompt": "작업 프롬프트",
                "run_in_background": True,
            },
        }
        result = await pre_tool_use_fn(hook_input, "toolu-abc", MagicMock())

        assert result["hookEventName"] == "PreToolUse"
        updated = result["updatedInput"]
        assert "run_in_background" not in updated
        assert updated["description"] == "작업 설명"
        assert updated["prompt"] == "작업 프롬프트"

    @pytest.mark.asyncio
    async def test_passes_through_when_no_run_in_background(self):
        """run_in_background가 없으면 빈 dict를 반환한다 (변경 없음)"""
        event_queue: deque[EngineEvent] = deque()
        hooks = build_hooks(compact_events=None, event_queue=event_queue)

        pre_tool_use_fn = hooks["PreToolUse"][0].hooks[0]
        hook_input = {
            "tool_name": "Agent",
            "tool_input": {
                "description": "작업 설명",
                "prompt": "작업 프롬프트",
            },
        }
        result = await pre_tool_use_fn(hook_input, "toolu-def", MagicMock())

        assert result == {}

    @pytest.mark.asyncio
    async def test_passes_through_when_run_in_background_false(self):
        """run_in_background=False이면 빈 dict를 반환한다 (변경 없음)"""
        event_queue: deque[EngineEvent] = deque()
        hooks = build_hooks(compact_events=None, event_queue=event_queue)

        pre_tool_use_fn = hooks["PreToolUse"][0].hooks[0]
        hook_input = {
            "tool_name": "Agent",
            "tool_input": {
                "description": "작업 설명",
                "run_in_background": False,
            },
        }
        result = await pre_tool_use_fn(hook_input, "toolu-ghi", MagicMock())

        assert result == {}

    @pytest.mark.asyncio
    async def test_preserves_all_other_fields(self):
        """run_in_background 외의 모든 필드는 그대로 유지한다"""
        event_queue: deque[EngineEvent] = deque()
        hooks = build_hooks(compact_events=None, event_queue=event_queue)

        pre_tool_use_fn = hooks["PreToolUse"][0].hooks[0]
        hook_input = {
            "tool_name": "Agent",
            "tool_input": {
                "description": "설명",
                "prompt": "프롬프트",
                "tools": ["Read", "Write"],
                "run_in_background": True,
            },
        }
        result = await pre_tool_use_fn(hook_input, "toolu-jkl", MagicMock())

        updated = result["updatedInput"]
        assert updated["description"] == "설명"
        assert updated["prompt"] == "프롬프트"
        assert updated["tools"] == ["Read", "Write"]
        assert "run_in_background" not in updated

    @pytest.mark.asyncio
    async def test_handles_empty_tool_input(self):
        """tool_input이 없어도 에러 없이 빈 dict를 반환한다"""
        event_queue: deque[EngineEvent] = deque()
        hooks = build_hooks(compact_events=None, event_queue=event_queue)

        pre_tool_use_fn = hooks["PreToolUse"][0].hooks[0]
        result = await pre_tool_use_fn({}, None, MagicMock())

        assert result == {}
