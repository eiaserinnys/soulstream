"""
Pydantic 모델 - Request/Response 스키마

공통 모델은 soul_common.models.schemas에서 re-export한다.
이 파일에는 soul-server 전용 모델만 정의한다.
"""

import re
from datetime import datetime
from typing import Any, Optional, List
from pydantic import BaseModel, Field, field_validator

# === soul-common re-export (하위 호환성) ===
from soul_common.models.schemas import (  # noqa: F401
    SSEEventType,
    TaskStatus,
    InterveneRequest,
    InputResponseRequest,
    InterveneResponse,
    HealthResponse,
    ErrorDetail,
    ErrorResponse,
    SessionEvent,
    ProgressEvent,
    MemoryEvent,
    InterventionSentEvent,
    CompleteEvent,
    ErrorEvent,
    SessionInfo,
    SessionsListResponse,
    SessionListSSEEvent,
    SessionCreatedSSEEvent,
    SessionUpdatedSSEEvent,
    SessionDeletedSSEEvent,
    MetadataUpdatedSSEEvent,
    CreateSessionResponse,
)

_TAG_NAME_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_\-]*$")


# === soul-server 전용 모델 ===

class AttachmentUploadResponse(BaseModel):
    """첨부 파일 업로드 응답"""
    path: str
    filename: str
    size: int
    content_type: str


class AttachmentCleanupResponse(BaseModel):
    """첨부 파일 정리 응답"""
    cleaned: bool
    files_removed: int


class ContextUsageEvent(BaseModel):
    """컨텍스트 사용량 이벤트"""
    type: str = "context_usage"
    used_tokens: int = Field(..., description="사용된 토큰 수")
    max_tokens: int = Field(..., description="최대 토큰 수")
    percent: float = Field(..., description="사용 퍼센트 (0-100)")


class CompactEvent(BaseModel):
    """컴팩트 실행 이벤트"""
    type: str = "compact"
    trigger: str = Field(..., description="트리거 타입 (manual 또는 auto)")
    message: str = Field(..., description="컴팩트 상태 메시지")


class DebugEvent(BaseModel):
    """디버그 정보 이벤트 (rate_limit 경고, SDK Notification 등)"""
    type: str = "debug"
    message: str = Field(..., description="디버그 메시지")
    timestamp: float = 0.0
    parent_event_id: Optional[int] = None


class ContextItem(BaseModel):
    """하나의 맥락 항목."""
    key: str = Field(..., description="항목 이름, 프롬프트 조립 시 XML 태그명으로 사용.")
    label: str = Field(..., description="대시보드 표시용 라벨")
    content: Any = Field(..., description="항목 내용")

    @field_validator("key")
    @classmethod
    def validate_key(cls, v: str) -> str:
        if not _TAG_NAME_RE.fullmatch(v):
            raise ValueError(
                f"key must be a valid XML tag name (alphanumeric, underscore, hyphen; "
                f"must start with letter or '_'): {v!r}"
            )
        return v


class StructuredContext(BaseModel):
    """구조화된 맥락. execute 요청에 prompt와 함께 전달."""
    items: List[ContextItem] = Field(..., description="맥락 항목 리스트 (순서 유지)")


class ExecuteRequest(BaseModel):
    """실행 요청"""
    prompt: str = Field(..., description="실행할 프롬프트")
    context: Optional[StructuredContext] = Field(None, description="구조화된 맥락")
    agent_session_id: Optional[str] = Field(None, description="세션 식별자.")
    client_id: Optional[str] = Field(None, description="클라이언트 식별자")
    attachment_paths: Optional[List[str]] = Field(None, description="첨부 파일 경로 목록")
    allowed_tools: Optional[List[str]] = Field(None, description="허용 도구 목록")
    disallowed_tools: Optional[List[str]] = Field(None, description="금지 도구 목록")
    use_mcp: bool = Field(True, description="MCP 서버 연결 여부")
    context_items: Optional[List[dict]] = Field(None, description="추가 컨텍스트 항목 목록.")
    model: Optional[str] = Field(None, description="Claude 모델명.")
    folder_id: Optional[str] = Field(None, description="세션을 배치할 폴더 ID.")
    system_prompt: Optional[str] = Field(None, description="Claude API system 파라미터로 전달할 시스템 프롬프트.")
    profile: Optional[str] = Field(None, description="에이전트 프로필 ID.")
    caller_info: Optional[dict] = Field(None, description="발신자 정보. 비어있으면 서버가 HTTP Request에서 조립한다.")


class SessionResponse(BaseModel):
    """세션 정보 응답"""
    agent_session_id: str
    status: TaskStatus
    result: Optional[str] = None
    error: Optional[str] = None
    claude_session_id: Optional[str] = None
    pid: Optional[int] = Field(None, description="Claude Code 프로세스 ID")
    created_at: datetime
    completed_at: Optional[datetime] = None


class SessionListResponse(BaseModel):
    """세션 목록 응답"""
    sessions: List[SessionResponse]


class InitSSEEvent(BaseModel):
    """세션 초기화 이벤트"""
    type: str = "init"
    agent_session_id: str = Field(..., description="서버가 할당한 세션 식별자")


# === 세분화 SSE Event Models (dashboard용) ===

class ThinkingSSEEvent(BaseModel):
    """Extended Thinking 이벤트"""
    type: str = "thinking"
    timestamp: float
    thinking: str
    signature: str = ""
    parent_event_id: Optional[int] = None


class TextStartSSEEvent(BaseModel):
    """텍스트 블록 시작 이벤트"""
    type: str = "text_start"
    timestamp: float
    parent_event_id: Optional[int] = None


class TextDeltaSSEEvent(BaseModel):
    """텍스트 블록 내용 이벤트"""
    type: str = "text_delta"
    timestamp: float
    text: str
    parent_event_id: Optional[int] = None


class TextEndSSEEvent(BaseModel):
    """텍스트 블록 완료 이벤트"""
    type: str = "text_end"
    timestamp: float
    parent_event_id: Optional[int] = None


class ToolStartSSEEvent(BaseModel):
    """도구 호출 시작 이벤트"""
    type: str = "tool_start"
    timestamp: float
    tool_name: str
    tool_input: dict = Field(default_factory=dict)
    tool_use_id: Optional[str] = None
    parent_event_id: Optional[int] = None


class ToolResultSSEEvent(BaseModel):
    """도구 결과 이벤트"""
    type: str = "tool_result"
    timestamp: float
    tool_name: str
    result: str
    is_error: bool = False
    tool_use_id: Optional[str] = None
    parent_event_id: Optional[int] = None


class ResultSSEEvent(BaseModel):
    """엔진 최종 결과 이벤트 (dashboard 전용)"""
    type: str = "result"
    timestamp: float
    success: bool
    output: str
    error: Optional[str] = None
    usage: Optional[dict] = None
    total_cost_usd: Optional[float] = None
    parent_event_id: Optional[int] = None
    stop_reason: Optional[str] = None
    errors: Optional[List[str]] = None
    model_usage: Optional[dict] = None
    permission_denials: Optional[List[str]] = None


class AwaySummarySSEEvent(BaseModel):
    """away_summary (recap) 이벤트 — 세션 복귀 시 요약"""
    type: str = "away_summary"
    timestamp: float
    content: str
    parent_event_id: Optional[str] = None


class SubagentStartSSEEvent(BaseModel):
    """서브에이전트 시작 이벤트"""
    type: str = "subagent_start"
    timestamp: float
    agent_id: str
    agent_type: str
    parent_event_id: Optional[int] = None


class SubagentStopSSEEvent(BaseModel):
    """서브에이전트 종료 이벤트"""
    type: str = "subagent_stop"
    timestamp: float
    agent_id: str
    parent_event_id: Optional[int] = None


class InputRequestQuestion(BaseModel):
    """AskUserQuestion의 개별 질문"""
    question: str
    header: str = ""
    options: List[dict] = Field(default_factory=list)
    multi_select: bool = False


class InputRequestSSEEvent(BaseModel):
    """사용자 입력 요청 이벤트"""
    type: str = "input_request"
    timestamp: float
    request_id: str
    tool_use_id: str = ""
    questions: List[InputRequestQuestion]
    parent_event_id: Optional[int] = None
    started_at: float
    timeout_sec: float


class InputRequestExpiredSSEEvent(BaseModel):
    """사용자 입력 요청 만료 이벤트"""
    type: str = "input_request_expired"
    request_id: str
    parent_event_id: Optional[int] = None
    timestamp: float


class InputRequestRespondedSSEEvent(BaseModel):
    """사용자 입력 요청 응답 완료 이벤트"""
    type: str = "input_request_responded"
    request_id: str
    parent_event_id: Optional[int] = None
    timestamp: float


class AssistantErrorSSEEvent(BaseModel):
    """Claude API 에러 이벤트 (인증 실패, 과금 에러 등)"""
    type: str = "assistant_error"
    timestamp: float
    error_type: str = Field(..., description="에러 타입: authentication_failed, billing_error, rate_limit 등")
    model: str = ""
    message_id: Optional[str] = None
    parent_event_id: Optional[int] = None


class CredentialAlertEvent(BaseModel):
    """rate limit 사용량 경고 이벤트"""
    type: str = "credential_alert"
    utilization: Optional[float] = None
    rate_limit_type: Optional[str] = None
    status: Optional[str] = None
    resets_at: Optional[str] = None
    timestamp: float = 0.0
    parent_event_id: Optional[int] = None


class SubtreeUpdateSSEEvent(BaseModel):
    """서브트리 높이 전파 이벤트.

    새 이벤트가 추가되어 조상 이벤트들의 subtree_height가 증가할 때 발행된다.
    클라이언트는 이 이벤트로 가상화된 뷰포트의 높이 정보를 동기화한다.

    Note: deltas는 dict[int, int]이지만 JSON 직렬화 시 키가 문자열이 된다
    (JSON 스펙상 object key는 string만 허용). 클라이언트는 Number()로 재변환해야 한다.
    """
    type: str = "subtree_update"
    timestamp: float
    affected_event_ids: List[int] = Field(..., description="subtree_height가 변경된 조상 이벤트 ID 목록")
    deltas: dict[int, int] = Field(..., description="{event_id: subtree_height 증가량}. JSON 직렬화 시 key는 str.")
    new_total_subtree_height: int = Field(..., description="세션 전체의 새로운 subtree_height 합계")
    trigger_event_id: Optional[int] = Field(None, description="이 업데이트를 유발한 신규 이벤트 ID")


class ViewportEvent(BaseModel):
    """뷰포트 쿼리 결과의 개별 이벤트 항목."""
    id: int
    parent_event_id: Optional[int] = None
    event_type: str
    depth: int = Field(..., description="트리 깊이 (루트=0)")
    y_start: int = Field(..., description="가상 Y축 시작 위치 (1-based)")
    y_end: int = Field(..., description="가상 Y축 끝 위치 (inclusive)")
    payload: dict = Field(default_factory=dict)


class ViewportResponse(BaseModel):
    """뷰포트 조회 응답."""
    events: List[ViewportEvent]
    total_subtree_height: int = Field(..., description="세션 전체의 subtree_height 합계")


class MessageItem(BaseModel):
    """메시지 페이지네이션 항목."""
    id: int
    parent_event_id: Optional[int] = None
    event_type: str
    payload: dict = Field(default_factory=dict)
    created_at: str


class MessagesResponse(BaseModel):
    """메시지 페이지네이션 응답."""
    messages: List[MessageItem]
    next_cursor: Optional[str] = Field(None, description="다음 페이지 커서 (ISO timestamp)")
