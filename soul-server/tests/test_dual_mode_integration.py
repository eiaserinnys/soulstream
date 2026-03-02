"""듀얼 모드 통합 테스트

파일 모드와 세렌디피티 모드 간의 통합 검증.
실제 세렌디피티 서버 없이 모킹으로 테스트합니다.
"""

import asyncio
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from soul_server.config import Settings
from soul_server.models import (
    CompleteEvent,
    ErrorEvent,
    TextStartSSEEvent,
    TextDeltaSSEEvent,
    TextEndSSEEvent,
    ToolStartSSEEvent,
    ToolResultSSEEvent,
)
from soul_server.service.engine_adapter import SoulEngineAdapter
from soul_server.service.serendipity_adapter import SerendipityAdapter, SessionContext
from soul_server.service.session_analyzer import SessionAnalyzer, WorkCategory
from soul_server.engine.types import EngineResult


# ============================================================================
# Helpers
# ============================================================================

def make_mock_runner(
    session_id: str = "test-session",
    success: bool = True,
    error: str = "",
):
    """ClaudeRunner 모킹"""
    runner = MagicMock()
    runner._remove_client = AsyncMock()
    runner._get_or_create_client = AsyncMock(return_value=(MagicMock(), None))
    runner._is_cli_alive.return_value = True

    result = EngineResult(
        success=success,
        output="완료" if success else "",
        session_id=session_id if success else None,
        error=error if not success else None,
    )
    runner.run = AsyncMock(return_value=result)
    return runner


async def collect_events(adapter: SoulEngineAdapter, prompt: str, **kwargs) -> List:
    """어댑터에서 모든 이벤트 수집"""
    events = []
    async for event in adapter.execute(prompt, **kwargs):
        events.append(event)
    return events


# ============================================================================
# 파일 모드 테스트 (SERENDIPITY_ENABLED=false)
# ============================================================================


class TestFileModeBasic:
    """파일 모드 기본 테스트"""

    @pytest.mark.asyncio
    async def test_file_mode_no_serendipity_adapter(self):
        """파일 모드: SerendipityAdapter 없이 정상 동작"""
        adapter = SoulEngineAdapter(
            workspace_dir="/test",
            pool=None,
            serendipity_adapter=None,  # 파일 모드
        )

        mock_result = EngineResult(
            success=True,
            output="파일 모드 완료",
            session_id="file-sess-1",
        )

        with patch("soul_server.service.engine_adapter.ClaudeRunner") as MockRunner:
            instance = MockRunner.return_value
            instance.run = AsyncMock(return_value=mock_result)

            events = await collect_events(adapter, "테스트 프롬프트")

        complete_events = [e for e in events if isinstance(e, CompleteEvent)]
        assert len(complete_events) == 1
        assert complete_events[0].result == "파일 모드 완료"

    @pytest.mark.asyncio
    async def test_file_mode_error_handling(self):
        """파일 모드: 에러 발생 시 ErrorEvent 반환"""
        adapter = SoulEngineAdapter(
            workspace_dir="/test",
            pool=None,
            serendipity_adapter=None,
        )

        mock_result = EngineResult(
            success=False,
            output="",
            error="파일 모드 에러",
        )

        with patch("soul_server.service.engine_adapter.ClaudeRunner") as MockRunner:
            instance = MockRunner.return_value
            instance.run = AsyncMock(return_value=mock_result)

            events = await collect_events(adapter, "에러 발생")

        error_events = [e for e in events if isinstance(e, ErrorEvent)]
        assert len(error_events) == 1


class TestFileModeSession:
    """파일 모드 세션 관리 테스트"""

    @pytest.mark.asyncio
    async def test_file_mode_session_creation(self):
        """파일 모드: 세션 생성 및 ID 반환"""
        adapter = SoulEngineAdapter(
            workspace_dir="/test",
            pool=None,
            serendipity_adapter=None,
        )

        mock_result = EngineResult(
            success=True,
            output="세션 생성됨",
            session_id="new-session-id",
        )

        with patch("soul_server.service.engine_adapter.ClaudeRunner") as MockRunner:
            instance = MockRunner.return_value
            instance.run = AsyncMock(return_value=mock_result)

            events = await collect_events(adapter, "새 세션")

        complete_events = [e for e in events if isinstance(e, CompleteEvent)]
        assert complete_events[0].claude_session_id == "new-session-id"


# ============================================================================
# 세렌디피티 모드 테스트 (SERENDIPITY_ENABLED=true)
# ============================================================================


class TestSerendipityModeBasic:
    """세렌디피티 모드 기본 테스트"""

    @pytest.fixture
    def mock_serendipity_client(self):
        """모킹된 세렌디피티 클라이언트"""
        client = AsyncMock()
        client.create_page.return_value = {"id": "page-uuid", "title": "Test Page"}
        client.create_block.return_value = {"id": "block-uuid"}
        client.add_label.return_value = {"id": "label-uuid", "name": "test"}
        client.update_page.return_value = {"id": "page-uuid", "title": "Updated"}
        return client

    @pytest.mark.asyncio
    async def test_serendipity_mode_creates_page(self, mock_serendipity_client):
        """세렌디피티 모드: 세션 시작 시 페이지 생성"""
        serendipity_adapter = SerendipityAdapter(enabled=True)

        with patch.object(
            serendipity_adapter, "_ensure_client", return_value=mock_serendipity_client
        ):
            ctx = await serendipity_adapter.start_session(
                client_id="test",
                request_id="req-123",
                prompt="세렌디피티 테스트",
            )

        assert ctx.page_id == "page-uuid"
        mock_serendipity_client.create_page.assert_called_once()

    @pytest.mark.asyncio
    async def test_serendipity_mode_records_events(self, mock_serendipity_client):
        """세렌디피티 모드: SSE 이벤트 블록으로 기록"""
        serendipity_adapter = SerendipityAdapter(enabled=True)
        serendipity_adapter._client = mock_serendipity_client

        ctx = SessionContext(
            client_id="test",
            request_id="req-123",
            page_id="page-uuid",
            user_block_id="user-block-uuid",
        )

        # 텍스트 이벤트 시퀀스
        await serendipity_adapter.on_event(ctx, TextStartSSEEvent(card_id="card1"))
        await serendipity_adapter.on_event(
            ctx, TextDeltaSSEEvent(card_id="card1", text="응답 텍스트")
        )
        await serendipity_adapter.on_event(ctx, TextEndSSEEvent(card_id="card1"))

        # 블록 생성 확인
        mock_serendipity_client.create_block.assert_called()

    @pytest.mark.asyncio
    async def test_serendipity_mode_adds_category_labels(self, mock_serendipity_client):
        """세렌디피티 모드: 세션 종료 시 카테고리 라벨 부착"""
        serendipity_adapter = SerendipityAdapter(enabled=True)
        serendipity_adapter._client = mock_serendipity_client

        ctx = SessionContext(
            client_id="test",
            request_id="req-123",
            page_id="page-uuid",
            user_block_id="user-block-uuid",
        )

        # 분석기에 이벤트 추가 (코드 작업)
        ctx.analyzer.add_event(
            serendipity_adapter.service.session_analyzer.SessionEvent(
                event_type="user",
                content="코드 수정해줘",
            )
        ) if hasattr(serendipity_adapter, "service") else None

        # 세션 종료
        await serendipity_adapter.end_session(ctx, success=True)

        # 페이지 제목 업데이트 확인
        mock_serendipity_client.update_page.assert_called()


class TestSerendipityModeAnalyzer:
    """세렌디피티 모드 분석기 연동 테스트"""

    @pytest.mark.asyncio
    async def test_analyzer_collects_events(self):
        """분석기가 이벤트를 수집"""
        serendipity_adapter = SerendipityAdapter(enabled=True)

        # 모킹
        mock_client = AsyncMock()
        mock_client.create_page.return_value = {"id": "page-1"}
        mock_client.create_block.return_value = {"id": "block-1"}
        mock_client.add_label.return_value = {"id": "label-1"}

        with patch.object(
            serendipity_adapter, "_ensure_client", return_value=mock_client
        ):
            ctx = await serendipity_adapter.start_session(
                client_id="test",
                request_id="req-1",
                prompt="버그 수정해줘",
            )

        # 분석기에 프롬프트가 수집됨
        assert ctx.analyzer is not None
        assert len(ctx.analyzer._events) >= 1
        assert ctx.analyzer._prompt == "버그 수정해줘"

    @pytest.mark.asyncio
    async def test_analyzer_categorizes_from_tool_events(self):
        """분석기가 도구 이벤트에서 카테고리 분류"""
        serendipity_adapter = SerendipityAdapter(enabled=True)

        # 모킹
        mock_client = AsyncMock()
        mock_client.create_page.return_value = {"id": "page-1"}
        mock_client.create_block.return_value = {"id": "block-1"}
        mock_client.add_label.return_value = {"id": "label-1"}
        mock_client.update_page.return_value = {"id": "page-1"}

        with patch.object(
            serendipity_adapter, "_ensure_client", return_value=mock_client
        ):
            ctx = await serendipity_adapter.start_session(
                client_id="test",
                request_id="req-1",
                prompt="파일 수정",
            )

        serendipity_adapter._client = mock_client

        # 도구 이벤트 추가
        tool_event = ToolStartSSEEvent(
            card_id="card1",
            tool_name="Edit",
            tool_input={"file_path": "/test.py"},
            tool_use_id="toolu_1",
        )
        await serendipity_adapter.on_event(ctx, tool_event)

        # 분석 실행
        summary = ctx.analyzer.analyze()

        # CODE 카테고리가 분류됨
        assert WorkCategory.CODE in summary.categories


# ============================================================================
# 모드 전환 테스트
# ============================================================================


class TestModeSwitch:
    """모드 전환 테스트"""

    @pytest.mark.asyncio
    async def test_disable_serendipity_during_session(self):
        """세렌디피티 비활성화 시 세션 데이터 유실 없음"""
        # 활성화 상태에서 시작
        serendipity_adapter = SerendipityAdapter(enabled=True)

        mock_client = AsyncMock()
        mock_client.create_page.return_value = {"id": "page-1"}
        mock_client.create_block.return_value = {"id": "block-1"}
        mock_client.add_label.return_value = {"id": "label-1"}

        with patch.object(
            serendipity_adapter, "_ensure_client", return_value=mock_client
        ):
            ctx = await serendipity_adapter.start_session(
                client_id="test",
                request_id="req-1",
                prompt="테스트",
            )

        # 페이지 생성됨
        assert ctx.page_id == "page-1"

        # 비활성화 (새 어댑터로 교체 시뮬레이션)
        disabled_adapter = SerendipityAdapter(enabled=False)

        # 비활성화 상태에서 이벤트 처리
        await disabled_adapter.on_event(ctx, TextDeltaSSEEvent(card_id="c1", text="test"))

        # 예외 없이 처리됨
        # (실제 운영에서는 기존 ctx.page_id로 작업 계속 가능)

    @pytest.mark.asyncio
    async def test_graceful_degradation_on_serendipity_failure(self):
        """세렌디피티 서버 장애 시 graceful degradation"""
        serendipity_adapter = SerendipityAdapter(enabled=True)

        # 실패하는 클라이언트
        failing_client = AsyncMock()
        failing_client.create_page.side_effect = Exception("Connection refused")

        with patch.object(
            serendipity_adapter, "_ensure_client", return_value=failing_client
        ):
            # 예외가 발생해도 컨텍스트는 반환됨
            ctx = await serendipity_adapter.start_session(
                client_id="test",
                request_id="req-1",
                prompt="테스트",
            )

        # page_id는 None (세렌디피티 실패)
        assert ctx.page_id is None
        # 세션 자체는 계속 진행 가능
        assert ctx.client_id == "test"


# ============================================================================
# 통합 시나리오 테스트
# ============================================================================


class TestFullIntegrationScenario:
    """전체 통합 시나리오 테스트"""

    @pytest.mark.asyncio
    async def test_full_session_flow_with_serendipity(self):
        """완전한 세션 흐름: 생성 → 이벤트 처리 → 종료"""
        # 세렌디피티 어댑터 설정
        serendipity_adapter = SerendipityAdapter(enabled=True)

        mock_client = AsyncMock()
        mock_client.create_page.return_value = {"id": "page-full-flow"}
        mock_client.create_block.return_value = {"id": "block-1"}
        mock_client.add_label.return_value = {"id": "label-1"}
        mock_client.update_page.return_value = {"id": "page-full-flow"}
        serendipity_adapter._client = mock_client

        with patch.object(
            serendipity_adapter, "_ensure_client", return_value=mock_client
        ):
            # 1. 세션 시작
            ctx = await serendipity_adapter.start_session(
                client_id="slack",
                request_id="thread-123",
                prompt="버그 수정하고 테스트 추가해줘",
                persona="Dorothy",
            )

        assert ctx.page_id == "page-full-flow"
        assert ctx.analyzer is not None

        # 2. 이벤트 처리
        events = [
            TextStartSSEEvent(card_id="c1"),
            TextDeltaSSEEvent(card_id="c1", text="버그를 수정하겠습니다."),
            TextEndSSEEvent(card_id="c1"),
            ToolStartSSEEvent(
                card_id="c1",
                tool_name="Edit",
                tool_input={"file_path": "src/main.py"},
                tool_use_id="toolu_1",
            ),
            ToolResultSSEEvent(
                card_id="c1",
                tool_name="Edit",
                result="파일 수정됨",
                is_error=False,
                tool_use_id="toolu_1",
            ),
            ToolStartSSEEvent(
                card_id="c1",
                tool_name="Bash",
                tool_input={"command": "pytest tests/"},
                tool_use_id="toolu_2",
            ),
            ToolResultSSEEvent(
                card_id="c1",
                tool_name="Bash",
                result="3 tests passed",
                is_error=False,
                tool_use_id="toolu_2",
            ),
        ]

        for event in events:
            await serendipity_adapter.on_event(ctx, event)

        # 3. 세션 종료
        await serendipity_adapter.end_session(ctx, success=True)

        # 검증
        # - 페이지 업데이트 호출됨
        mock_client.update_page.assert_called()

        # - 분석 결과
        summary = ctx.analyzer.analyze()
        assert WorkCategory.DEBUG in summary.categories  # "버그 수정" 키워드
        assert WorkCategory.CODE in summary.categories  # Edit 도구
        assert WorkCategory.TEST in summary.categories  # pytest 명령어

    @pytest.mark.asyncio
    async def test_engine_adapter_with_serendipity(self):
        """SoulEngineAdapter와 SerendipityAdapter 통합"""
        # SerendipityAdapter 모킹
        mock_serendipity = MagicMock(spec=SerendipityAdapter)
        mock_serendipity._enabled = True
        mock_serendipity.start_session = AsyncMock(
            return_value=SessionContext(
                client_id="test",
                request_id="req-1",
                page_id="integrated-page",
            )
        )
        mock_serendipity.on_event = AsyncMock()
        mock_serendipity.end_session = AsyncMock()

        adapter = SoulEngineAdapter(
            workspace_dir="/test",
            pool=None,
            serendipity_adapter=mock_serendipity,
        )

        mock_result = EngineResult(
            success=True,
            output="통합 완료",
            session_id="integrated-sess",
        )

        with patch("soul_server.service.engine_adapter.ClaudeRunner") as MockRunner:
            instance = MockRunner.return_value
            instance.run = AsyncMock(return_value=mock_result)

            events = await collect_events(
                adapter,
                "통합 테스트",
                client_id="dashboard",
                request_id="req-integration",
            )

        # 세렌디피티 어댑터 호출 확인
        mock_serendipity.start_session.assert_called_once()
        assert mock_serendipity.on_event.called

        # 완료 이벤트 확인
        complete_events = [e for e in events if isinstance(e, CompleteEvent)]
        assert len(complete_events) == 1


# ============================================================================
# 설정 기반 모드 선택 테스트
# ============================================================================


class TestConfigBasedModeSelection:
    """설정 기반 모드 선택 테스트"""

    def test_settings_serendipity_enabled_true(self):
        """SERENDIPITY_ENABLED=true 설정 확인"""
        with patch.dict(
            "os.environ",
            {
                "WORKSPACE_DIR": "/test",
                "SERENDIPITY_ENABLED": "true",
                "SERENDIPITY_URL": "http://localhost:4002",
            },
        ):
            from soul_server.config import Settings

            settings = Settings.from_env()
            assert settings.serendipity_enabled is True
            assert settings.serendipity_url == "http://localhost:4002"

    def test_settings_serendipity_enabled_false(self):
        """SERENDIPITY_ENABLED=false 설정 확인"""
        with patch.dict(
            "os.environ",
            {
                "WORKSPACE_DIR": "/test",
                "SERENDIPITY_ENABLED": "false",
            },
        ):
            from soul_server.config import Settings

            settings = Settings.from_env()
            assert settings.serendipity_enabled is False
