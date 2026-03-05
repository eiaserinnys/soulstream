"""SerendipityAdapter 테스트

세렌디피티 연동 어댑터의 단위 테스트.
실제 API 호출 없이 모킹으로 테스트합니다.
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from datetime import date

from soul_server.service.serendipity_adapter import (
    SerendipityAdapter,
    SessionContext,
    BLOCK_TYPE_USER,
    BLOCK_TYPE_THINKING,   # Extended Thinking
    BLOCK_TYPE_ASSISTANT,  # Changed: soul:response → soul:assistant
    BLOCK_TYPE_TOOL_USE,   # Changed: soul:tool-call → soul:tool_use
    BLOCK_TYPE_TOOL_RESULT,
    BLOCK_TYPE_INTERVENTION,
    BLOCK_TYPE_ERROR,      # Changed: soul:system → soul:error
    # 이모지 상수
    EMOJI_THINKING,
    EMOJI_TOOL,
    EMOJI_USER,
    EMOJI_ERROR,
    EMOJI_SUCCESS,
    EMOJI_FAILURE,
    EMOJI_SESSION,
    # 분석기 길이 제한 상수
    MAX_ANALYZER_CONTENT_LENGTH,
    MAX_ANALYZER_RESULT_LENGTH,
    MAX_ANALYZER_PROMPT_LENGTH,
)
from soul_server.service.serendipity_client import (
    create_text_content,
    create_soul_content,
    generate_key,
    date_label_title,
)
from soul_server.models import (
    TextStartSSEEvent,
    TextDeltaSSEEvent,
    TextEndSSEEvent,
    ThinkingSSEEvent,
    ToolStartSSEEvent,
    ToolResultSSEEvent,
    InterventionSentEvent,
    CompleteEvent,
    ErrorEvent,
)


class TestContentHelpers:
    """컨텐츠 헬퍼 함수 테스트"""

    def test_generate_key_length(self):
        """generate_key()는 8자 문자열을 반환해야 함"""
        key = generate_key()
        assert len(key) == 8
        assert key.isalnum()

    def test_generate_key_uniqueness(self):
        """generate_key()는 고유한 값을 반환해야 함"""
        keys = [generate_key() for _ in range(100)]
        assert len(set(keys)) == 100

    def test_create_text_content_structure(self):
        """create_text_content()는 올바른 Portable Text 구조를 생성해야 함"""
        content = create_text_content("Hello, World!")

        assert content["_version"] == 1
        assert len(content["content"]) == 1

        block = content["content"][0]
        assert block["_type"] == "block"
        assert block["style"] == "normal"
        assert len(block["children"]) == 1

        span = block["children"][0]
        assert span["_type"] == "span"
        assert span["text"] == "Hello, World!"
        assert span["marks"] == []

    def test_create_text_content_with_style(self):
        """create_text_content()는 스타일을 적용해야 함"""
        content = create_text_content("Title", style="h1")
        assert content["content"][0]["style"] == "h1"

    def test_create_soul_content_with_metadata(self):
        """create_soul_content()는 soul 메타데이터를 포함해야 함"""
        metadata = {
            "nodeId": "abc123",
            "timestamp": "2026-03-01T12:00:00Z",
            "toolName": "Bash",
        }
        content = create_soul_content("Test", metadata)

        assert content["_version"] == 1
        assert content["soul"] == metadata

    def test_date_label_title(self):
        """date_label_title()는 올바른 형식의 레이블을 생성해야 함"""
        d = date(2026, 3, 1)
        label = date_label_title(d)
        assert label == "📅 2026년 3월 1일"


class TestSessionContext:
    """SessionContext 테스트"""

    def test_session_context_default_values(self):
        """SessionContext는 올바른 기본값을 가져야 함"""
        ctx = SessionContext(client_id="test", request_id="req123")

        assert ctx.client_id == "test"
        assert ctx.request_id == "req123"
        assert ctx.page_id is None
        assert ctx.page_title == ""
        assert ctx.user_block_id is None
        assert ctx.current_card_id is None
        assert ctx.block_order == 0
        assert ctx.text_buffers == {}
        assert ctx.tool_blocks == {}

    def test_session_context_next_order(self):
        """next_order()는 순차적으로 증가하는 값을 반환해야 함"""
        ctx = SessionContext(client_id="test", request_id="req123")

        assert ctx.next_order() == 0
        assert ctx.next_order() == 1
        assert ctx.next_order() == 2


class TestSerendipityAdapterDisabled:
    """비활성화 상태의 SerendipityAdapter 테스트"""

    @pytest.mark.asyncio
    async def test_start_session_when_disabled(self):
        """비활성화 시 start_session()은 빈 컨텍스트를 반환해야 함"""
        adapter = SerendipityAdapter(enabled=False)

        ctx = await adapter.start_session(
            client_id="test",
            request_id="req123",
            prompt="Hello",
        )

        assert ctx.client_id == "test"
        assert ctx.request_id == "req123"
        assert ctx.page_id is None

    @pytest.mark.asyncio
    async def test_on_event_when_disabled(self):
        """비활성화 시 on_event()는 아무것도 하지 않아야 함"""
        adapter = SerendipityAdapter(enabled=False)
        ctx = SessionContext(client_id="test", request_id="req123")

        # 예외가 발생하지 않아야 함
        event = TextDeltaSSEEvent(card_id="abc", text="Hello", timestamp=1000.0)
        await adapter.on_event(ctx, event)

    @pytest.mark.asyncio
    async def test_end_session_when_disabled(self):
        """비활성화 시 end_session()은 아무것도 하지 않아야 함"""
        adapter = SerendipityAdapter(enabled=False)
        ctx = SessionContext(client_id="test", request_id="req123")

        # 예외가 발생하지 않아야 함
        await adapter.end_session(ctx, success=True)


class TestSerendipityAdapterEnabled:
    """활성화 상태의 SerendipityAdapter 테스트"""

    @pytest.fixture
    def mock_client(self):
        """모킹된 AsyncSerendipityClient"""
        client = AsyncMock()
        client.create_page.return_value = {"id": "page-uuid", "title": "Test Page"}
        client.create_block.return_value = {"id": "block-uuid"}
        client.add_label.return_value = {"id": "label-uuid", "name": "test"}
        client.update_page.return_value = {"id": "page-uuid", "title": "Updated"}
        return client

    @pytest.mark.asyncio
    async def test_start_session_creates_page(self, mock_client):
        """start_session()은 페이지를 생성해야 함"""
        adapter = SerendipityAdapter(enabled=True)

        with patch.object(adapter, '_ensure_client', return_value=mock_client):
            ctx = await adapter.start_session(
                client_id="slack",
                request_id="thread-123",
                prompt="테스트 프롬프트",
            )

        assert ctx.page_id == "page-uuid"
        assert ctx.user_block_id == "block-uuid"
        mock_client.create_page.assert_called_once()
        mock_client.create_block.assert_called_once()

    @pytest.mark.asyncio
    async def test_start_session_attaches_labels(self, mock_client):
        """start_session()은 레이블을 부착해야 함"""
        adapter = SerendipityAdapter(enabled=True)

        with patch.object(adapter, '_ensure_client', return_value=mock_client):
            await adapter.start_session(
                client_id="slack",
                request_id="thread-123",
                prompt="테스트",
                persona="Dorothy",
            )

        # add_label이 최소 2번 호출되어야 함 (🤖 Soul Session, 📅 날짜, 🤖 Soul: Dorothy)
        assert mock_client.add_label.call_count >= 2

    @pytest.mark.asyncio
    async def test_on_text_events(self, mock_client):
        """텍스트 이벤트 시퀀스를 올바르게 처리해야 함"""
        adapter = SerendipityAdapter(enabled=True)
        adapter._client = mock_client

        ctx = SessionContext(
            client_id="test",
            request_id="req123",
            page_id="page-uuid",
            user_block_id="user-block-uuid",
        )

        # text_start → text_delta → text_end 시퀀스
        await adapter.on_event(ctx, TextStartSSEEvent(card_id="card1", timestamp=1000.0))
        await adapter.on_event(ctx, TextDeltaSSEEvent(card_id="card1", text="Hello ", timestamp=1001.0))
        await adapter.on_event(ctx, TextDeltaSSEEvent(card_id="card1", text="World!", timestamp=1002.0))
        await adapter.on_event(ctx, TextEndSSEEvent(card_id="card1", timestamp=1003.0))

        # text_end에서 블록이 생성되어야 함
        mock_client.create_block.assert_called_once()
        call_args = mock_client.create_block.call_args
        assert call_args.kwargs["block_type"] == BLOCK_TYPE_ASSISTANT

    @pytest.mark.asyncio
    async def test_on_tool_start(self, mock_client):
        """ToolStartSSEEvent를 올바르게 처리해야 함"""
        adapter = SerendipityAdapter(enabled=True)
        adapter._client = mock_client

        ctx = SessionContext(
            client_id="test",
            request_id="req123",
            page_id="page-uuid",
            user_block_id="user-block-uuid",
        )

        event = ToolStartSSEEvent(
            card_id="card1",
            tool_name="Bash",
            tool_input={"command": "ls -la"},
            tool_use_id="toolu_123",
            timestamp=1000.0,
        )
        await adapter.on_event(ctx, event)

        mock_client.create_block.assert_called_once()
        call_args = mock_client.create_block.call_args
        assert call_args.kwargs["block_type"] == BLOCK_TYPE_TOOL_USE

        # tool_blocks에 저장되어야 함
        assert "toolu_123" in ctx.tool_blocks

    @pytest.mark.asyncio
    async def test_on_tool_result(self, mock_client):
        """ToolResultSSEEvent를 올바르게 처리해야 함"""
        adapter = SerendipityAdapter(enabled=True)
        adapter._client = mock_client

        ctx = SessionContext(
            client_id="test",
            request_id="req123",
            page_id="page-uuid",
            user_block_id="user-block-uuid",
        )
        ctx.tool_blocks["toolu_123"] = {"block_id": "tool-block-uuid", "tool_name": "Bash"}

        event = ToolResultSSEEvent(
            card_id="card1",
            tool_name="Bash",
            result="total 42",
            is_error=False,
            tool_use_id="toolu_123",
            timestamp=1000.0,
        )
        await adapter.on_event(ctx, event)

        mock_client.create_block.assert_called_once()
        call_args = mock_client.create_block.call_args
        assert call_args.kwargs["block_type"] == BLOCK_TYPE_TOOL_RESULT
        # parent_id가 tool_call 블록이어야 함
        assert call_args.kwargs["parent_id"] == "tool-block-uuid"

    @pytest.mark.asyncio
    async def test_on_intervention(self, mock_client):
        """InterventionSentEvent를 올바르게 처리해야 함"""
        adapter = SerendipityAdapter(enabled=True)
        adapter._client = mock_client

        ctx = SessionContext(
            client_id="test",
            request_id="req123",
            page_id="page-uuid",
            user_block_id="user-block-uuid",
        )

        event = InterventionSentEvent(user="user123", text="추가 지시")
        await adapter.on_event(ctx, event)

        mock_client.create_block.assert_called_once()
        call_args = mock_client.create_block.call_args
        assert call_args.kwargs["block_type"] == BLOCK_TYPE_INTERVENTION

    @pytest.mark.asyncio
    async def test_on_error(self, mock_client):
        """ErrorEvent를 올바르게 처리해야 함"""
        adapter = SerendipityAdapter(enabled=True)
        adapter._client = mock_client

        ctx = SessionContext(
            client_id="test",
            request_id="req123",
            page_id="page-uuid",
            user_block_id="user-block-uuid",
        )

        event = ErrorEvent(message="Something went wrong")
        await adapter.on_event(ctx, event)

        # 시스템 블록 생성 + 페이지 제목 업데이트
        mock_client.create_block.assert_called_once()
        mock_client.update_page.assert_called_once()

    @pytest.mark.asyncio
    async def test_end_session_updates_title(self, mock_client):
        """end_session()은 페이지 제목을 업데이트해야 함"""
        adapter = SerendipityAdapter(enabled=True)
        adapter._client = mock_client

        ctx = SessionContext(
            client_id="test",
            request_id="req123",
            page_id="page-uuid",
            page_title="Original Title",
        )

        await adapter.end_session(ctx, success=True, summary="작업 완료")

        mock_client.update_page.assert_called_once()
        call_args = mock_client.update_page.call_args
        assert "✅" in call_args.args[1]

    @pytest.mark.asyncio
    async def test_end_session_with_failure(self, mock_client):
        """실패 시 end_session()은 ❌ 표시를 사용해야 함"""
        adapter = SerendipityAdapter(enabled=True)
        adapter._client = mock_client

        ctx = SessionContext(
            client_id="test",
            request_id="req123",
            page_id="page-uuid",
            page_title="Original Title",
        )

        await adapter.end_session(ctx, success=False, summary="오류 발생")

        mock_client.update_page.assert_called_once()
        call_args = mock_client.update_page.call_args
        assert "❌" in call_args.args[1]


class TestBaseUrlValidation:
    """base_url 검증 테스트"""

    @pytest.mark.asyncio
    async def test_ensure_client_raises_without_base_url(self):
        """base_url 없이 _ensure_client() 호출 시 ValueError 발생"""
        adapter = SerendipityAdapter(base_url=None, enabled=True)

        with pytest.raises(ValueError) as exc_info:
            await adapter._ensure_client()

        assert "base_url" in str(exc_info.value)
        assert "SERENDIPITY_URL" in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_adapter_disabled_without_base_url_ok(self):
        """비활성화 상태에서는 base_url 없이도 정상 동작"""
        adapter = SerendipityAdapter(base_url=None, enabled=False)

        # 예외 없이 동작해야 함
        ctx = await adapter.start_session(
            client_id="test",
            request_id="req123",
            prompt="Hello",
        )

        assert ctx.page_id is None  # 페이지 생성 안 됨


class TestEmojiConstants:
    """이모지 상수 테스트"""

    def test_emoji_constants_defined(self):
        """이모지 상수가 올바르게 정의되어 있어야 함"""
        assert EMOJI_THINKING == "💭"
        assert EMOJI_TOOL == "🔧"
        assert EMOJI_USER == "👤"
        assert EMOJI_ERROR == "⚠️"
        assert EMOJI_SUCCESS == "✅"
        assert EMOJI_FAILURE == "❌"
        assert EMOJI_SESSION == "🤖"

    def test_analyzer_length_constants_defined(self):
        """분석기 길이 제한 상수가 올바르게 정의되어 있어야 함"""
        assert MAX_ANALYZER_CONTENT_LENGTH == 1000
        assert MAX_ANALYZER_RESULT_LENGTH == 500
        assert MAX_ANALYZER_PROMPT_LENGTH == 2000


class TestBlockTypeConstants:
    """블록 타입 상수 테스트"""

    def test_block_type_tool_result_uses_underscore(self):
        """BLOCK_TYPE_TOOL_RESULT는 언더스코어를 사용해야 함 (Dashboard 일관성)"""
        assert BLOCK_TYPE_TOOL_RESULT == "soul:tool_result"
        assert "-" not in BLOCK_TYPE_TOOL_RESULT  # 하이픈 없음


class TestThinkingEvent:
    """ThinkingSSEEvent 처리 테스트"""

    @pytest.fixture
    def mock_client(self):
        """모킹된 AsyncSerendipityClient"""
        client = AsyncMock()
        client.create_page.return_value = {"id": "page-uuid", "title": "Test Page"}
        client.create_block.return_value = {"id": "block-uuid"}
        client.add_label.return_value = {"id": "label-uuid", "name": "test"}
        client.update_page.return_value = {"id": "page-uuid", "title": "Updated"}
        return client

    @pytest.mark.asyncio
    async def test_on_thinking_creates_block(self, mock_client):
        """ThinkingSSEEvent를 올바르게 처리해야 함"""
        adapter = SerendipityAdapter(enabled=True)
        adapter._client = mock_client

        ctx = SessionContext(
            client_id="test",
            request_id="req123",
            page_id="page-uuid",
            user_block_id="user-block-uuid",
        )

        event = ThinkingSSEEvent(
            card_id="card1",
            thinking="사용자 요청을 분석 중입니다...",
            signature="sig123",
            timestamp=1000.0,
        )
        await adapter.on_event(ctx, event)

        mock_client.create_block.assert_called_once()
        call_args = mock_client.create_block.call_args
        assert call_args.kwargs["block_type"] == BLOCK_TYPE_THINKING

    @pytest.mark.asyncio
    async def test_on_thinking_empty_text_skipped(self, mock_client):
        """빈 thinking 텍스트는 블록을 생성하지 않아야 함"""
        adapter = SerendipityAdapter(enabled=True)
        adapter._client = mock_client

        ctx = SessionContext(
            client_id="test",
            request_id="req123",
            page_id="page-uuid",
            user_block_id="user-block-uuid",
        )

        event = ThinkingSSEEvent(
            card_id="card1",
            thinking="   ",  # 공백만
            signature="sig123",
            timestamp=1000.0,
        )
        await adapter.on_event(ctx, event)

        mock_client.create_block.assert_not_called()

    @pytest.mark.asyncio
    async def test_on_thinking_updates_response_block_id(self, mock_client):
        """ThinkingSSEEvent 처리 후 current_response_block_id가 갱신되어야 함"""
        adapter = SerendipityAdapter(enabled=True)
        adapter._client = mock_client

        ctx = SessionContext(
            client_id="test",
            request_id="req123",
            page_id="page-uuid",
            user_block_id="user-block-uuid",
        )

        event = ThinkingSSEEvent(
            card_id="card1",
            thinking="사고 과정...",
            signature="sig123",
            timestamp=1000.0,
        )
        await adapter.on_event(ctx, event)

        # create_block의 반환값이 current_response_block_id에 설정됨
        assert ctx.current_response_block_id == "block-uuid"
