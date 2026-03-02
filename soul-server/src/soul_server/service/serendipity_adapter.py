"""Serendipity Adapter

SSE 이벤트를 세렌디피티 블록으로 변환하여 저장하는 어댑터.
engine_adapter의 이벤트 훅에서 호출됩니다.

## 블록 타입 매핑

| SSE Event | Block Type | 설명 |
|-----------|------------|------|
| prompt (최초) | soul:user | 사용자 프롬프트 |
| ThinkingSSEEvent | soul:thinking | Extended Thinking |
| TextDeltaSSEEvent | soul:assistant | Claude 응답 텍스트 |
| ToolStartSSEEvent | soul:tool_use | 도구 호출 시작 |
| ToolResultSSEEvent | soul:tool-result | 도구 실행 결과 |
| InterventionSentEvent | soul:intervention | 사용자 개입 |
| CompleteEvent | (페이지 제목 업데이트) | 세션 완료 |
| ErrorEvent | soul:error | 시스템 오류 |

## Content 구조

모든 soul:* 블록은 다음 구조를 따릅니다:
```json
{
  "_version": 1,
  "content": [...],  // Portable Text
  "soul": {
    "nodeId": "abc-123",
    "timestamp": "2026-03-01T15:30:00Z",
    "toolName": "Bash",  // tool-call, tool-result
    "toolInput": {...},   // tool-call
    "toolUseId": "toolu_xxx",  // tool-call, tool-result
    "isError": false,     // tool-result
    "cardId": "card123"   // 연관 카드 ID
  }
}
```
"""

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Optional, TYPE_CHECKING

from soul_server.models import (
    CompleteEvent,
    ErrorEvent,
    InterventionSentEvent,
    TextDeltaSSEEvent,
    TextEndSSEEvent,
    TextStartSSEEvent,
    ThinkingSSEEvent,
    ToolResultSSEEvent,
    ToolStartSSEEvent,
)
from soul_server.service.serendipity_client import (
    AsyncSerendipityClient,
    create_text_content,
    create_soul_content,
    date_label_title,
    generate_key,
)
from soul_server.service.session_analyzer import (
    SessionAnalyzer,
    SessionEvent,
    SessionSummary,
    CATEGORY_LABELS,
)

if TYPE_CHECKING:
    from pydantic import BaseModel

logger = logging.getLogger(__name__)


# ============================================================================
# Constants
# ============================================================================

# 자동 부착 레이블
SOUL_SESSION_LABEL = "🤖 Soul Session"

# 블록 타입
BLOCK_TYPE_USER = "soul:user"
BLOCK_TYPE_THINKING = "soul:thinking"    # Extended Thinking
BLOCK_TYPE_ASSISTANT = "soul:assistant"  # Claude 응답 텍스트
BLOCK_TYPE_TOOL_USE = "soul:tool_use"    # 도구 호출 시작
BLOCK_TYPE_TOOL_RESULT = "soul:tool-result"
BLOCK_TYPE_INTERVENTION = "soul:intervention"
BLOCK_TYPE_ERROR = "soul:error"          # 시스템 오류

# Deprecated aliases (backward compatibility)
BLOCK_TYPE_RESPONSE = BLOCK_TYPE_ASSISTANT
BLOCK_TYPE_TOOL_CALL = BLOCK_TYPE_TOOL_USE
BLOCK_TYPE_SYSTEM = BLOCK_TYPE_ERROR


# ============================================================================
# Data Classes
# ============================================================================

@dataclass
class SessionContext:
    """세션 저장 컨텍스트

    세션 동안 유지되는 상태 정보를 관리합니다.
    """
    client_id: str
    request_id: str
    page_id: Optional[str] = None
    page_title: str = ""
    user_block_id: Optional[str] = None
    current_card_id: Optional[str] = None
    current_response_block_id: Optional[str] = None
    start_time: float = field(default_factory=time.time)
    block_order: int = 0

    # 텍스트 블록 버퍼 (card_id → text)
    text_buffers: Dict[str, str] = field(default_factory=dict)

    # tool_use_id → 블록 정보 매핑
    tool_blocks: Dict[str, Dict[str, Any]] = field(default_factory=dict)

    # 세션 분석기 (자동 메타데이터 생성용)
    analyzer: Optional[SessionAnalyzer] = field(default_factory=SessionAnalyzer)

    def next_order(self) -> int:
        """다음 블록 순서 반환 및 증가"""
        order = self.block_order
        self.block_order += 1
        return order


# ============================================================================
# Serendipity Adapter
# ============================================================================

class SerendipityAdapter:
    """SSE 이벤트 → 세렌디피티 블록 변환 어댑터

    engine_adapter의 이벤트 훅에서 호출되어 SSE 이벤트를
    세렌디피티 블록으로 변환하여 저장합니다.

    Usage:
        adapter = SerendipityAdapter("http://localhost:4002")

        # 세션 시작
        ctx = await adapter.start_session("slack", "thread-123", "테스트 요청")

        # 이벤트 처리
        await adapter.on_event(ctx, some_sse_event)

        # 세션 종료
        await adapter.end_session(ctx)
    """

    def __init__(
        self,
        base_url: str = "http://localhost:4002",
        enabled: bool = True,
        client_id_label_prefix: str = "🤖 Soul: ",
    ):
        """
        Args:
            base_url: Serendipity API URL
            enabled: 활성화 여부 (False면 모든 작업 스킵)
            client_id_label_prefix: 클라이언트 ID 레이블 접두사
        """
        self._base_url = base_url
        self._enabled = enabled
        self._client_id_label_prefix = client_id_label_prefix
        self._client: Optional[AsyncSerendipityClient] = None

    async def _ensure_client(self) -> AsyncSerendipityClient:
        """클라이언트 인스턴스 보장"""
        if self._client is None:
            self._client = AsyncSerendipityClient(self._base_url)
        return self._client

    @staticmethod
    def _iso_timestamp() -> str:
        """현재 시각을 ISO 8601 형식으로 반환"""
        return datetime.now(timezone.utc).isoformat()

    @staticmethod
    def _truncate_text(text: str, max_len: int = 5000) -> str:
        """텍스트가 너무 길면 잘라냄"""
        if len(text) > max_len:
            return text[:max_len] + f"\n\n... (truncated, {len(text)} chars total)"
        return text

    # ========== Session Lifecycle ==========

    async def start_session(
        self,
        client_id: str,
        request_id: str,
        prompt: str,
        persona: Optional[str] = None,
    ) -> SessionContext:
        """세션 시작: 페이지 생성 + 라벨 부착 + 사용자 프롬프트 블록 추가

        Args:
            client_id: 클라이언트 ID (예: 'slack', 'dashboard')
            request_id: 요청 ID (예: Slack thread ID)
            prompt: 사용자 프롬프트
            persona: 페르소나 이름 (예: 'Dorothy', 'Shadow')

        Returns:
            세션 컨텍스트
        """
        ctx = SessionContext(client_id=client_id, request_id=request_id)

        # 분석기에 최초 프롬프트 추가
        if ctx.analyzer:
            ctx.analyzer.add_event(SessionEvent(
                event_type="user",
                content=prompt[:2000],  # 길이 제한
            ))

        if not self._enabled:
            logger.debug("SerendipityAdapter disabled, skipping start_session")
            return ctx

        try:
            client = await self._ensure_client()

            # 1. 페이지 생성
            today = date.today()
            timestamp = datetime.now().strftime("%H:%M:%S")
            page_title = f"🤖 Session | {client_id} | {today.isoformat()} {timestamp}"
            ctx.page_title = page_title

            page = await client.create_page(page_title)
            ctx.page_id = page["id"]

            # 2. 레이블 부착
            await self._attach_labels(client, ctx, persona, today)

            # 3. 사용자 프롬프트 블록 추가
            user_block = await self._create_user_block(client, ctx, prompt)
            ctx.user_block_id = user_block["id"]

            logger.info(
                f"start_session(): page '{page_title}' ({ctx.page_id}) created "
                f"with user prompt block"
            )

        except Exception as e:
            logger.error(f"start_session() failed: {e}", exc_info=True)
            # 실패해도 세션은 계속 진행

        return ctx

    async def _attach_labels(
        self,
        client: AsyncSerendipityClient,
        ctx: SessionContext,
        persona: Optional[str],
        today: date,
    ) -> None:
        """페이지에 레이블 부착"""
        if not ctx.page_id:
            return

        labels = [
            SOUL_SESSION_LABEL,
            date_label_title(today),
        ]

        # 페르소나 레이블
        if persona:
            labels.append(f"{self._client_id_label_prefix}{persona}")
        elif ctx.client_id:
            labels.append(f"{self._client_id_label_prefix}{ctx.client_id}")

        for label in labels:
            try:
                await client.add_label(ctx.page_id, label)
            except Exception as e:
                logger.warning(f"Failed to add label '{label}': {e}")

    async def _create_user_block(
        self,
        client: AsyncSerendipityClient,
        ctx: SessionContext,
        prompt: str,
    ) -> Dict[str, Any]:
        """사용자 프롬프트 블록 생성"""
        content = create_soul_content(
            text=prompt,
            soul_metadata={
                "nodeId": generate_key(),
                "timestamp": self._iso_timestamp(),
            },
        )

        return await client.create_block(
            page_id=ctx.page_id,
            content=content,
            block_type=BLOCK_TYPE_USER,
            order=ctx.next_order(),
        )

    async def end_session(
        self,
        ctx: SessionContext,
        success: bool = True,
        summary: Optional[str] = None,
    ) -> None:
        """세션 종료: 분석 기반 메타데이터 업데이트

        세션 분석기를 통해 자동으로:
        - 세션 제목 생성 (프롬프트/작업 내용 기반)
        - 카테고리 라벨 부착 (🔧 코드 작업, 🐛 디버깅 등)

        Args:
            ctx: 세션 컨텍스트
            success: 성공 여부
            summary: 세션 요약 (선택, None이면 자동 생성)
        """
        if not self._enabled or not ctx.page_id:
            return

        try:
            client = await self._ensure_client()

            # 세션 분석 실행
            session_summary: Optional[SessionSummary] = None
            if ctx.analyzer:
                try:
                    session_summary = ctx.analyzer.analyze()
                    logger.debug(
                        f"Session analyzed: title='{session_summary.title}', "
                        f"categories={[c.value for c in session_summary.categories]}, "
                        f"confidence={session_summary.confidence:.2f}"
                    )
                except Exception as e:
                    logger.warning(f"Session analysis failed: {e}")

            # 제목 결정: 명시적 summary > 분석기 제목 > 기본 제목
            status = "✅" if success else "❌"
            elapsed = time.time() - ctx.start_time
            elapsed_str = f"{int(elapsed)}s"

            if summary:
                # 명시적 summary가 제공된 경우
                summary_preview = summary[:50].replace("\n", " ")
                if len(summary) > 50:
                    summary_preview += "..."
                new_title = f"{status} {summary_preview} ({elapsed_str})"
            elif session_summary and session_summary.confidence >= 0.3:
                # 분석기 제목 사용 (신뢰도가 충분한 경우)
                new_title = f"{status} {session_summary.title} ({elapsed_str})"
            else:
                # 기본 제목
                new_title = f"{status} {ctx.page_title} ({elapsed_str})"

            await client.update_page(ctx.page_id, new_title)
            logger.info(f"end_session(): page title updated to '{new_title}'")

            # 카테고리 라벨 부착 (성공 시에만)
            if success and session_summary and session_summary.labels:
                await self._attach_category_labels(client, ctx.page_id, session_summary.labels)

        except Exception as e:
            logger.error(f"end_session() failed: {e}", exc_info=True)

    async def _attach_category_labels(
        self,
        client: AsyncSerendipityClient,
        page_id: str,
        labels: List[str],
    ) -> None:
        """카테고리 라벨 부착

        Args:
            client: 세렌디피티 클라이언트
            page_id: 페이지 ID
            labels: 부착할 라벨 목록
        """
        for label in labels:
            try:
                await client.add_label(page_id, label)
                logger.debug(f"Category label '{label}' attached to page {page_id}")
            except Exception as e:
                # 레이블 부착 실패는 치명적이지 않음
                logger.warning(f"Failed to attach category label '{label}': {e}")

    # ========== Event Handling ==========

    async def on_event(self, ctx: SessionContext, event: Any) -> None:
        """SSE 이벤트 처리

        Args:
            ctx: 세션 컨텍스트
            event: SSE 이벤트 (Pydantic 모델)
        """
        if not self._enabled or not ctx.page_id:
            return

        try:
            # 분석기에 이벤트 수집 (세션 메타데이터 자동 생성용)
            self._collect_event_for_analyzer(ctx, event)

            # 이벤트 타입에 따라 분기
            if isinstance(event, ThinkingSSEEvent):
                await self._on_thinking(ctx, event)
            elif isinstance(event, TextStartSSEEvent):
                await self._on_text_start(ctx, event)
            elif isinstance(event, TextDeltaSSEEvent):
                await self._on_text_delta(ctx, event)
            elif isinstance(event, TextEndSSEEvent):
                await self._on_text_end(ctx, event)
            elif isinstance(event, ToolStartSSEEvent):
                await self._on_tool_start(ctx, event)
            elif isinstance(event, ToolResultSSEEvent):
                await self._on_tool_result(ctx, event)
            elif isinstance(event, InterventionSentEvent):
                await self._on_intervention(ctx, event)
            elif isinstance(event, CompleteEvent):
                await self._on_complete(ctx, event)
            elif isinstance(event, ErrorEvent):
                await self._on_error(ctx, event)
            # 다른 이벤트는 무시 (progress, memory, debug 등)

        except Exception as e:
            logger.error(f"on_event() failed for {type(event).__name__}: {e}", exc_info=True)

    def _collect_event_for_analyzer(self, ctx: SessionContext, event: Any) -> None:
        """분석기에 이벤트 수집 (휴리스틱 분석용)

        Args:
            ctx: 세션 컨텍스트
            event: SSE 이벤트
        """
        if ctx.analyzer is None:
            return

        try:
            if isinstance(event, TextEndSSEEvent):
                # 텍스트 버퍼에서 완료된 텍스트 가져오기
                text = ctx.text_buffers.get(event.card_id, "")
                if text.strip():
                    ctx.analyzer.add_event(SessionEvent(
                        event_type="response",
                        content=text[:1000],  # 길이 제한
                    ))
            elif isinstance(event, ToolStartSSEEvent):
                ctx.analyzer.add_event(SessionEvent(
                    event_type="tool_call",
                    content=event.tool_name,
                    tool_name=event.tool_name,
                    tool_input=event.tool_input,
                ))
            elif isinstance(event, ToolResultSSEEvent):
                # 결과 텍스트 (길이 제한)
                result_str = str(event.result)[:500] if event.result else ""
                ctx.analyzer.add_event(SessionEvent(
                    event_type="tool_result",
                    content=result_str,
                    tool_name=event.tool_name,
                ))
            elif isinstance(event, InterventionSentEvent):
                ctx.analyzer.add_event(SessionEvent(
                    event_type="user",
                    content=event.text[:1000],  # 길이 제한
                ))
        except Exception as e:
            logger.warning(f"Failed to collect event for analyzer: {e}")

    async def _on_thinking(self, ctx: SessionContext, event: ThinkingSSEEvent) -> None:
        """Extended Thinking 블록 생성

        ThinkingBlock의 사고 과정을 soul:thinking 블록으로 저장합니다.
        """
        if not event.thinking.strip():
            return

        client = await self._ensure_client()

        # thinking 텍스트 접두사 추가
        text = f"💭 Thinking\n\n{self._truncate_text(event.thinking, 3000)}"

        content = create_soul_content(
            text=text,
            soul_metadata={
                "nodeId": generate_key(),
                "timestamp": self._iso_timestamp(),
                "cardId": event.card_id,
                "signature": event.signature,
            },
        )

        block = await client.create_block(
            page_id=ctx.page_id,
            content=content,
            block_type=BLOCK_TYPE_THINKING,
            parent_id=ctx.user_block_id,
            order=ctx.next_order(),
        )

        # 현재 응답 블록 ID 갱신 (후속 도구 호출의 부모)
        ctx.current_response_block_id = block["id"]

    async def _on_text_start(self, ctx: SessionContext, event: TextStartSSEEvent) -> None:
        """텍스트 블록 시작: 버퍼 초기화"""
        ctx.current_card_id = event.card_id
        ctx.text_buffers[event.card_id] = ""

    async def _on_text_delta(self, ctx: SessionContext, event: TextDeltaSSEEvent) -> None:
        """텍스트 델타: 버퍼에 텍스트 누적"""
        if event.card_id in ctx.text_buffers:
            ctx.text_buffers[event.card_id] += event.text
        else:
            ctx.text_buffers[event.card_id] = event.text

    async def _on_text_end(self, ctx: SessionContext, event: TextEndSSEEvent) -> None:
        """텍스트 블록 완료: 블록 생성"""
        text = ctx.text_buffers.pop(event.card_id, "")
        if not text.strip():
            return

        client = await self._ensure_client()

        content = create_soul_content(
            text=self._truncate_text(text),
            soul_metadata={
                "nodeId": generate_key(),
                "timestamp": self._iso_timestamp(),
                "cardId": event.card_id,
            },
        )

        block = await client.create_block(
            page_id=ctx.page_id,
            content=content,
            block_type=BLOCK_TYPE_ASSISTANT,
            parent_id=ctx.user_block_id,
            order=ctx.next_order(),
        )

        ctx.current_response_block_id = block["id"]

    async def _on_tool_start(self, ctx: SessionContext, event: ToolStartSSEEvent) -> None:
        """도구 호출 시작: 블록 생성"""
        client = await self._ensure_client()

        # tool_input을 JSON 문자열로 변환 (가독성 위해)
        try:
            tool_input_str = json.dumps(event.tool_input, ensure_ascii=False, indent=2)
        except (TypeError, ValueError):
            tool_input_str = str(event.tool_input)

        text = f"🔧 {event.tool_name}\n\n{self._truncate_text(tool_input_str, 2000)}"

        content = create_soul_content(
            text=text,
            soul_metadata={
                "nodeId": generate_key(),
                "timestamp": self._iso_timestamp(),
                "cardId": event.card_id,
                "toolName": event.tool_name,
                "toolInput": event.tool_input,
                "toolUseId": event.tool_use_id,
            },
        )

        block = await client.create_block(
            page_id=ctx.page_id,
            content=content,
            block_type=BLOCK_TYPE_TOOL_USE,
            parent_id=ctx.current_response_block_id or ctx.user_block_id,
            order=ctx.next_order(),
        )

        # tool_use_id로 블록 정보 저장 (tool_result에서 참조)
        if event.tool_use_id:
            ctx.tool_blocks[event.tool_use_id] = {
                "block_id": block["id"],
                "tool_name": event.tool_name,
            }

    async def _on_tool_result(self, ctx: SessionContext, event: ToolResultSSEEvent) -> None:
        """도구 결과: 블록 생성"""
        client = await self._ensure_client()

        # 결과 텍스트 포맷
        result_text = self._truncate_text(str(event.result), 3000)
        status = "❌" if event.is_error else "✅"
        text = f"{status} {event.tool_name}\n\n{result_text}"

        content = create_soul_content(
            text=text,
            soul_metadata={
                "nodeId": generate_key(),
                "timestamp": self._iso_timestamp(),
                "cardId": event.card_id,
                "toolName": event.tool_name,
                "toolUseId": event.tool_use_id,
                "isError": event.is_error,
            },
        )

        # 부모 블록: tool_use_id로 tool_call 블록 찾기
        parent_id = ctx.current_response_block_id or ctx.user_block_id
        if event.tool_use_id and event.tool_use_id in ctx.tool_blocks:
            parent_id = ctx.tool_blocks[event.tool_use_id]["block_id"]

        await client.create_block(
            page_id=ctx.page_id,
            content=content,
            block_type=BLOCK_TYPE_TOOL_RESULT,
            parent_id=parent_id,
            order=ctx.next_order(),
        )

    async def _on_intervention(self, ctx: SessionContext, event: InterventionSentEvent) -> None:
        """사용자 개입: 블록 생성"""
        client = await self._ensure_client()

        text = f"👤 {event.user}\n\n{event.text}"

        content = create_soul_content(
            text=text,
            soul_metadata={
                "nodeId": generate_key(),
                "timestamp": self._iso_timestamp(),
                "user": event.user,
            },
        )

        await client.create_block(
            page_id=ctx.page_id,
            content=content,
            block_type=BLOCK_TYPE_INTERVENTION,
            parent_id=ctx.user_block_id,
            order=ctx.next_order(),
        )

    async def _on_complete(self, ctx: SessionContext, event: CompleteEvent) -> None:
        """세션 완료: 세션 종료 처리"""
        # 결과 텍스트에서 요약 추출 시도
        summary = event.result[:100] if event.result else None
        await self.end_session(ctx, success=True, summary=summary)

    async def _on_error(self, ctx: SessionContext, event: ErrorEvent) -> None:
        """오류 발생: 시스템 블록 생성 + 세션 종료"""
        client = await self._ensure_client()

        text = f"⚠️ Error: {event.message}"

        content = create_soul_content(
            text=text,
            soul_metadata={
                "nodeId": generate_key(),
                "timestamp": self._iso_timestamp(),
                "errorCode": event.error_code,
            },
        )

        await client.create_block(
            page_id=ctx.page_id,
            content=content,
            block_type=BLOCK_TYPE_ERROR,
            parent_id=ctx.user_block_id,
            order=ctx.next_order(),
        )

        await self.end_session(ctx, success=False, summary=event.message)

    async def close(self) -> None:
        """리소스 정리"""
        if self._client:
            await self._client.close()
            self._client = None
