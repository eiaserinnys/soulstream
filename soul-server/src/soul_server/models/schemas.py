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
    """디버그 정보 이벤트 (rate_limit 경고 등)"""
    type: str = "debug"
    message: str = Field(..., description="디버그 메시지")


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
    parent_event_id: Optional[str] = None


class TextStartSSEEvent(BaseModel):
    """텍스트 블록 시작 이벤트"""
    type: str = "text_start"
    timestamp: float
    parent_event_id: Optional[str] = None


class TextDeltaSSEEvent(BaseModel):
    """텍스트 블록 내용 이벤트"""
    type: str = "text_delta"
    timestamp: float
    text: str
    parent_event_id: Optional[str] = None


class TextEndSSEEvent(BaseModel):
    """텍스트 블록 완료 이벤트"""
    type: str = "text_end"
    timestamp: float
    parent_event_id: Optional[str] = None


class ToolStartSSEEvent(BaseModel):
    """도구 호출 시작 이벤트"""
    type: str = "tool_start"
    timestamp: float
    tool_name: str
    tool_input: dict = Field(default_factory=dict)
    tool_use_id: Optional[str] = None
    parent_event_id: Optional[str] = None


class ToolResultSSEEvent(BaseModel):
    """도구 결과 이벤트"""
    type: str = "tool_result"
    timestamp: float
    tool_name: str
    result: str
    is_error: bool = False
    tool_use_id: Optional[str] = None
    parent_event_id: Optional[str] = None


class ResultSSEEvent(BaseModel):
    """엔진 최종 결과 이벤트 (dashboard 전용)"""
    type: str = "result"
    timestamp: float
    success: bool
    output: str
    error: Optional[str] = None
    usage: Optional[dict] = None
    total_cost_usd: Optional[float] = None
    parent_event_id: Optional[str] = None


class SubagentStartSSEEvent(BaseModel):
    """서브에이전트 시작 이벤트"""
    type: str = "subagent_start"
    timestamp: float
    agent_id: str
    agent_type: str
    parent_event_id: Optional[str] = None


class SubagentStopSSEEvent(BaseModel):
    """서브에이전트 종료 이벤트"""
    type: str = "subagent_stop"
    timestamp: float
    agent_id: str
    parent_event_id: Optional[str] = None


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
    parent_event_id: Optional[str] = None
    started_at: float
    timeout_sec: float


class InputRequestExpiredSSEEvent(BaseModel):
    """사용자 입력 요청 만료 이벤트"""
    type: str = "input_request_expired"
    request_id: str
    parent_event_id: Optional[str] = None
    timestamp: float


class InputRequestRespondedSSEEvent(BaseModel):
    """사용자 입력 요청 응답 완료 이벤트"""
    type: str = "input_request_responded"
    request_id: str
    parent_event_id: Optional[str] = None
    timestamp: float


class RateLimitProfileStatus(BaseModel):
    """프로필별 rate limit 타입 상태"""
    utilization: float | str
    resets_at: Optional[str] = None


class RateLimitProfileInfo(BaseModel):
    """프로필의 rate limit 정보"""
    name: str
    five_hour: RateLimitProfileStatus
    seven_day: RateLimitProfileStatus


class CredentialAlertEvent(BaseModel):
    """크레덴셜 rate limit 알림 이벤트"""
    type: str = "credential_alert"
    active_profile: str
    profiles: List[RateLimitProfileInfo]
