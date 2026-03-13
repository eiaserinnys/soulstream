"""MessageProcessor 단위 테스트"""

import pytest
from dataclasses import dataclass, field
from typing import Optional
from unittest.mock import AsyncMock

from soul_server.claude.agent_runner import MessageState
from soul_server.claude.message_processor import MessageProcessor
from soul_server.engine.types import (
    ResultEngineEvent,
    TextDeltaEngineEvent,
    ThinkingEngineEvent,
    ToolResultEngineEvent,
    ToolStartEngineEvent,
)


# SDK 메시지 타입 Mock
@dataclass
class MockSystemMessage:
    session_id: Optional[str] = None


@dataclass
class MockThinkingBlock:
    thinking: str = ""
    signature: str = ""


@dataclass
class MockTextBlock:
    text: str = ""


@dataclass
class MockToolUseBlock:
    id: Optional[str] = None
    name: str = ""
    input: Optional[dict] = None


@dataclass
class MockToolResultBlock:
    tool_use_id: Optional[str] = None
    content: str = ""
    is_error: bool = False


@dataclass
class MockAssistantMessage:
    content: list = field(default_factory=list)
    parent_tool_use_id: Optional[str] = None


@dataclass
class MockUserMessage:
    content: list = field(default_factory=list)
    parent_tool_use_id: Optional[str] = None


@dataclass
class MockResultMessage:
    result: str = ""
    session_id: Optional[str] = None
    is_error: bool = False
    usage: Optional[dict] = None


# isinstance 패치: SDK 타입을 Mock 타입으로 매핑
@pytest.fixture(autouse=True)
def _patch_sdk_types(monkeypatch):
    """message_processor 모듈의 SDK 타입 참조를 Mock으로 치환"""
    import soul_server.claude.message_processor as mp

    monkeypatch.setattr(mp, "SystemMessage", MockSystemMessage)
    monkeypatch.setattr(mp, "AssistantMessage", MockAssistantMessage)
    monkeypatch.setattr(mp, "UserMessage", MockUserMessage)
    monkeypatch.setattr(mp, "ResultMessage", MockResultMessage)
    monkeypatch.setattr(mp, "ThinkingBlock", MockThinkingBlock)
    monkeypatch.setattr(mp, "TextBlock", MockTextBlock)
    monkeypatch.setattr(mp, "ToolUseBlock", MockToolUseBlock)
    monkeypatch.setattr(mp, "ToolResultBlock", MockToolResultBlock)


def _make_processor(**kwargs):
    """테스트용 MessageProcessor 생성 헬퍼"""
    msg_state = kwargs.pop("msg_state", MessageState())
    return MessageProcessor(msg_state=msg_state, **kwargs), msg_state


class TestSystemMessage:
    """SystemMessage 처리 테스트"""

    @pytest.mark.asyncio
    async def test_session_id_extraction(self):
        proc, state = _make_processor()
        msg = MockSystemMessage(session_id="sess-123")
        await proc.process(msg)

        assert state.session_id == "sess-123"
        assert state.msg_count == 1

    @pytest.mark.asyncio
    async def test_on_session_callback(self):
        on_session = AsyncMock()
        proc, state = _make_processor(on_session=on_session)
        msg = MockSystemMessage(session_id="sess-abc")
        await proc.process(msg)

        on_session.assert_awaited_once_with("sess-abc")

    @pytest.mark.asyncio
    async def test_on_session_not_called_when_no_session_id(self):
        on_session = AsyncMock()
        proc, _ = _make_processor(on_session=on_session)
        msg = MockSystemMessage(session_id=None)
        await proc.process(msg)

        on_session.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_on_client_session_update_callback(self):
        on_update = lambda sid: setattr(on_update, "called_with", sid)
        proc, _ = _make_processor(on_client_session_update=on_update)
        msg = MockSystemMessage(session_id="sess-xyz")
        await proc.process(msg)

        assert on_update.called_with == "sess-xyz"

    @pytest.mark.asyncio
    async def test_on_session_callback_error_handled(self):
        """on_session 콜백 예외가 프로세서를 중단시키지 않는다"""
        on_session = AsyncMock(side_effect=RuntimeError("callback failed"))
        proc, state = _make_processor(on_session=on_session)
        msg = MockSystemMessage(session_id="sess-err")
        await proc.process(msg)

        assert state.session_id == "sess-err"


class TestThinkingBlock:
    """ThinkingBlock 처리 테스트"""

    @pytest.mark.asyncio
    async def test_thinking_event_emitted(self):
        events = []
        on_event = AsyncMock(side_effect=lambda e: events.append(e))
        proc, _ = _make_processor(on_event=on_event)

        msg = MockAssistantMessage(
            content=[MockThinkingBlock(thinking="deep thought", signature="sig-1")]
        )
        await proc.process(msg)

        assert len(events) == 1
        event = events[0]
        assert isinstance(event, ThinkingEngineEvent)
        assert event.thinking == "deep thought"
        assert event.signature == "sig-1"

    @pytest.mark.asyncio
    async def test_thinking_event_parent_tool_use_id(self):
        events = []
        on_event = AsyncMock(side_effect=lambda e: events.append(e))
        proc, _ = _make_processor(on_event=on_event)

        msg = MockAssistantMessage(
            content=[MockThinkingBlock(thinking="thought")],
            parent_tool_use_id="parent-1",
        )
        await proc.process(msg)

        assert events[0].parent_event_id == "parent-1"

    @pytest.mark.asyncio
    async def test_empty_thinking_no_event(self):
        """빈 thinking 텍스트는 이벤트를 발행하지 않는다"""
        on_event = AsyncMock()
        proc, _ = _make_processor(on_event=on_event)

        msg = MockAssistantMessage(
            content=[MockThinkingBlock(thinking="", signature="")]
        )
        await proc.process(msg)

        on_event.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_thinking_collected_in_messages(self):
        proc, state = _make_processor()

        msg = MockAssistantMessage(
            content=[MockThinkingBlock(thinking="some thinking")]
        )
        await proc.process(msg)

        assert len(state.collected_messages) == 1
        assert state.collected_messages[0]["role"] == "assistant"
        assert "[thinking]" in state.collected_messages[0]["content"]


class TestTextBlock:
    """TextBlock 처리 테스트"""

    @pytest.mark.asyncio
    async def test_text_delta_event_emitted(self):
        events = []
        on_event = AsyncMock(side_effect=lambda e: events.append(e))
        proc, state = _make_processor(on_event=on_event)

        msg = MockAssistantMessage(content=[MockTextBlock(text="hello world")])
        await proc.process(msg)

        assert len(events) == 1
        event = events[0]
        assert isinstance(event, TextDeltaEngineEvent)
        assert event.text == "hello world"

    @pytest.mark.asyncio
    async def test_on_progress_called(self):
        on_progress = AsyncMock()
        proc, _ = _make_processor(on_progress=on_progress)

        msg = MockAssistantMessage(content=[MockTextBlock(text="progress text")])
        await proc.process(msg)

        on_progress.assert_awaited_once_with("progress text")

    @pytest.mark.asyncio
    async def test_on_progress_truncates_long_text(self):
        on_progress = AsyncMock()
        proc, _ = _make_processor(on_progress=on_progress)

        long_text = "x" * 2000
        msg = MockAssistantMessage(content=[MockTextBlock(text=long_text)])
        await proc.process(msg)

        called_text = on_progress.call_args[0][0]
        assert called_text.startswith("...\n")
        assert len(called_text) <= 1005  # "...\n" + 1000 chars

    @pytest.mark.asyncio
    async def test_current_text_updated(self):
        proc, state = _make_processor()

        msg = MockAssistantMessage(content=[MockTextBlock(text="final text")])
        await proc.process(msg)

        assert state.current_text == "final text"

    @pytest.mark.asyncio
    async def test_text_parent_tool_use_id(self):
        events = []
        on_event = AsyncMock(side_effect=lambda e: events.append(e))
        proc, _ = _make_processor(on_event=on_event)

        msg = MockAssistantMessage(
            content=[MockTextBlock(text="hi")],
            parent_tool_use_id="parent-2",
        )
        await proc.process(msg)

        assert events[0].parent_event_id == "parent-2"


class TestToolUseBlock:
    """ToolUseBlock 처리 테스트"""

    @pytest.mark.asyncio
    async def test_tool_start_event_emitted(self):
        events = []
        on_event = AsyncMock(side_effect=lambda e: events.append(e))
        proc, _ = _make_processor(on_event=on_event)

        msg = MockAssistantMessage(
            content=[
                MockToolUseBlock(
                    id="toolu-1", name="Bash", input={"command": "ls"}
                )
            ]
        )
        await proc.process(msg)

        assert len(events) == 1
        event = events[0]
        assert isinstance(event, ToolStartEngineEvent)
        assert event.tool_name == "Bash"
        assert event.tool_input == {"command": "ls"}
        assert event.tool_use_id == "toolu-1"

    @pytest.mark.asyncio
    async def test_tool_use_id_to_name_mapping(self):
        proc, state = _make_processor()

        msg = MockAssistantMessage(
            content=[MockToolUseBlock(id="toolu-99", name="Read", input={})]
        )
        await proc.process(msg)

        assert state.tool_use_id_to_name["toolu-99"] == "Read"

    @pytest.mark.asyncio
    async def test_tool_use_no_input(self):
        events = []
        on_event = AsyncMock(side_effect=lambda e: events.append(e))
        proc, _ = _make_processor(on_event=on_event)

        msg = MockAssistantMessage(
            content=[MockToolUseBlock(id="toolu-2", name="Glob", input=None)]
        )
        await proc.process(msg)

        event = events[0]
        assert event.tool_input == {}


class TestToolResultBlock:
    """ToolResultBlock 처리 테스트"""

    @pytest.mark.asyncio
    async def test_tool_result_event_from_assistant_message(self):
        events = []
        on_event = AsyncMock(side_effect=lambda e: events.append(e))
        proc, state = _make_processor(on_event=on_event)

        # 먼저 tool_use_id → name 매핑 설정
        state.tool_use_id_to_name["toolu-10"] = "Bash"

        msg = MockAssistantMessage(
            content=[
                MockToolResultBlock(
                    tool_use_id="toolu-10", content="output", is_error=False
                )
            ]
        )
        await proc.process(msg)

        assert len(events) == 1
        event = events[0]
        assert isinstance(event, ToolResultEngineEvent)
        assert event.tool_name == "Bash"
        assert event.result == "output"
        assert event.is_error is False
        assert event.tool_use_id == "toolu-10"

    @pytest.mark.asyncio
    async def test_dedup_via_emitted_tool_result_ids(self):
        """동일 tool_use_id의 중복 발행 방지"""
        events = []
        on_event = AsyncMock(side_effect=lambda e: events.append(e))
        proc, state = _make_processor(on_event=on_event)

        block = MockToolResultBlock(
            tool_use_id="toolu-dup", content="result1"
        )

        # AssistantMessage에서 한 번
        msg1 = MockAssistantMessage(content=[block])
        await proc.process(msg1)

        # UserMessage에서 또 한 번 (같은 tool_use_id)
        msg2 = MockUserMessage(content=[block])
        await proc.process(msg2)

        # 이벤트는 1번만 발행
        assert len(events) == 1

    @pytest.mark.asyncio
    async def test_tool_result_is_error(self):
        events = []
        on_event = AsyncMock(side_effect=lambda e: events.append(e))
        proc, _ = _make_processor(on_event=on_event)

        msg = MockAssistantMessage(
            content=[
                MockToolResultBlock(
                    tool_use_id="toolu-err", content="error output", is_error=True
                )
            ]
        )
        await proc.process(msg)

        assert events[0].is_error is True

    @pytest.mark.asyncio
    async def test_tool_result_content_list_serialized(self):
        """content가 리스트인 경우 JSON으로 직렬화"""
        events = []
        on_event = AsyncMock(side_effect=lambda e: events.append(e))
        proc, _ = _make_processor(on_event=on_event)

        block = MockToolResultBlock(tool_use_id="toolu-list")
        block.content = [{"type": "text", "text": "hello"}]

        msg = MockAssistantMessage(content=[block])
        await proc.process(msg)

        assert '"hello"' in events[0].result


class TestUserMessage:
    """UserMessage 처리 테스트"""

    @pytest.mark.asyncio
    async def test_tool_result_from_user_message(self):
        events = []
        on_event = AsyncMock(side_effect=lambda e: events.append(e))
        proc, state = _make_processor(on_event=on_event)
        state.tool_use_id_to_name["toolu-u1"] = "Write"

        msg = MockUserMessage(
            content=[
                MockToolResultBlock(
                    tool_use_id="toolu-u1", content="written"
                )
            ],
            parent_tool_use_id="parent-u",
        )
        await proc.process(msg)

        assert len(events) == 1
        event = events[0]
        assert isinstance(event, ToolResultEngineEvent)
        assert event.tool_name == "Write"
        assert event.parent_event_id == "parent-u"

    @pytest.mark.asyncio
    async def test_user_message_no_last_msg_parent_attribute(self):
        """last_msg_parent가 삭제되었으므로 속성이 존재하지 않는다"""
        proc, _ = _make_processor()

        msg = MockUserMessage(
            content=[], parent_tool_use_id="parent-track"
        )
        await proc.process(msg)

        assert not hasattr(proc, "last_msg_parent")


class TestResultMessage:
    """ResultMessage 처리 테스트"""

    @pytest.mark.asyncio
    async def test_result_extracted(self):
        events = []
        on_event = AsyncMock(side_effect=lambda e: events.append(e))
        proc, state = _make_processor(on_event=on_event)

        msg = MockResultMessage(result="final answer", is_error=False)
        await proc.process(msg)

        assert state.result_text == "final answer"
        assert state.is_error is False
        assert len(events) == 1
        event = events[0]
        assert isinstance(event, ResultEngineEvent)
        assert event.success is True
        assert event.output == "final answer"

    @pytest.mark.asyncio
    async def test_result_is_error(self):
        events = []
        on_event = AsyncMock(side_effect=lambda e: events.append(e))
        proc, state = _make_processor(on_event=on_event)

        msg = MockResultMessage(result="error happened", is_error=True)
        await proc.process(msg)

        assert state.is_error is True
        event = events[0]
        assert event.success is False
        assert event.error == "error happened"

    @pytest.mark.asyncio
    async def test_result_usage_extracted(self):
        proc, state = _make_processor()

        msg = MockResultMessage(result="ok")
        msg.usage = {"input_tokens": 100, "output_tokens": 50}
        await proc.process(msg)

        assert state.usage == {"input_tokens": 100, "output_tokens": 50}

    @pytest.mark.asyncio
    async def test_result_session_id_updated(self):
        proc, state = _make_processor()

        msg = MockResultMessage(result="ok", session_id="sess-final")
        await proc.process(msg)

        assert state.session_id == "sess-final"

    @pytest.mark.asyncio
    async def test_result_fallback_to_current_text(self):
        """result_text가 없으면 current_text를 출력으로 사용"""
        events = []
        on_event = AsyncMock(side_effect=lambda e: events.append(e))
        proc, state = _make_processor(on_event=on_event)
        state.current_text = "fallback text"

        msg = MockResultMessage(result="", is_error=False)
        await proc.process(msg)

        event = events[0]
        assert event.output == "fallback text"


class TestResultParentEventId:
    """ResultMessage의 parent_event_id 동작 테스트

    last_msg_parent가 삭제되었으므로 ResultEngineEvent.parent_event_id는
    항상 None이다. task_executor가 user_request_id로 채운다.
    """

    @pytest.mark.asyncio
    async def test_no_last_msg_parent_attribute(self):
        """MessageProcessor에 last_msg_parent 속성이 없다"""
        proc, _ = _make_processor()
        assert not hasattr(proc, "last_msg_parent")

    @pytest.mark.asyncio
    async def test_result_parent_event_id_always_none(self):
        """ResultMessage의 parent_event_id는 항상 None"""
        events = []
        on_event = AsyncMock(side_effect=lambda e: events.append(e))
        proc, _ = _make_processor(on_event=on_event)

        # AssistantMessage 후 ResultMessage
        msg1 = MockAssistantMessage(content=[], parent_tool_use_id="p-result")
        await proc.process(msg1)

        msg2 = MockResultMessage(result="done")
        await proc.process(msg2)

        result_event = [e for e in events if isinstance(e, ResultEngineEvent)][0]
        assert result_event.parent_event_id is None

    @pytest.mark.asyncio
    async def test_result_parent_event_id_none_without_prior_message(self):
        """선행 메시지 없이 ResultMessage만 처리해도 parent_event_id=None"""
        events = []
        on_event = AsyncMock(side_effect=lambda e: events.append(e))
        proc, _ = _make_processor(on_event=on_event)

        msg = MockResultMessage(result="standalone")
        await proc.process(msg)

        result_event = events[0]
        assert isinstance(result_event, ResultEngineEvent)
        assert result_event.parent_event_id is None

    @pytest.mark.asyncio
    async def test_msg_count_increments(self):
        proc, state = _make_processor()

        await proc.process(MockAssistantMessage(content=[]))
        await proc.process(MockUserMessage(content=[]))
        await proc.process(MockResultMessage(result="x"))

        assert state.msg_count == 3
