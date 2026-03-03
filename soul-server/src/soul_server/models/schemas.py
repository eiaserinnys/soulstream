"""
Pydantic 모델 - Request/Response 스키마
"""

from datetime import datetime
from enum import Enum
from typing import Optional, List
from pydantic import BaseModel, Field


# === Enums ===

class SSEEventType(str, Enum):
    """SSE 이벤트 타입"""
    PROGRESS = "progress"
    MEMORY = "memory"
    SESSION = "session"
    INTERVENTION_SENT = "intervention_sent"
    DEBUG = "debug"
    COMPLETE = "complete"
    ERROR = "error"
    # 세분화 이벤트 (dashboard용)
    THINKING = "thinking"
    TEXT_START = "text_start"
    TEXT_DELTA = "text_delta"
    TEXT_END = "text_end"
    TOOL_START = "tool_start"
    TOOL_RESULT = "tool_result"
    RESULT = "result"
    CREDENTIAL_ALERT = "credential_alert"


# === Request Models ===

class InterveneRequest(BaseModel):
    """개입 메시지 요청 (Task API 호환)"""
    text: str = Field(..., description="메시지 텍스트")
    user: str = Field(..., description="요청한 사용자")
    attachment_paths: Optional[List[str]] = Field(None, description="첨부 파일 경로 목록")


# === Response Models ===

class InterveneResponse(BaseModel):
    """개입 메시지 응답"""
    queued: bool
    queue_position: int


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


class HealthResponse(BaseModel):
    """헬스 체크 응답"""
    status: str
    version: str
    uptime_seconds: int
    environment: Optional[str] = None


# === Error Response ===

class ErrorDetail(BaseModel):
    """에러 상세 정보"""
    code: str
    message: str
    details: dict = Field(default_factory=dict)


class ErrorResponse(BaseModel):
    """에러 응답"""
    error: ErrorDetail


# === SSE Event Models ===

class SessionEvent(BaseModel):
    """세션 ID 조기 통지 이벤트

    Claude Code 세션이 시작되면 session_id를 클라이언트에 즉시 알립니다.
    클라이언트는 이 session_id로 인터벤션 API를 호출할 수 있습니다.
    """
    type: str = "session"
    session_id: str


class ProgressEvent(BaseModel):
    """진행 상황 이벤트"""
    type: str = "progress"
    text: str


class MemoryEvent(BaseModel):
    """메모리 사용량 이벤트"""
    type: str = "memory"
    used_gb: float
    total_gb: float
    percent: float


class InterventionSentEvent(BaseModel):
    """개입 메시지 전송 확인 이벤트"""
    type: str = "intervention_sent"
    user: str
    text: str


class CompleteEvent(BaseModel):
    """실행 완료 이벤트"""
    type: str = "complete"
    result: str
    attachments: List[str] = Field(default_factory=list)
    claude_session_id: Optional[str] = Field(None, description="Claude Code 세션 ID (다음 쿼리에서 resume용)")


class ErrorEvent(BaseModel):
    """오류 이벤트"""
    type: str = "error"
    message: str
    error_code: Optional[str] = Field(None, description="에러 코드 (예: SESSION_NOT_FOUND)")


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


# === Task API Models ===

class TaskStatus(str, Enum):
    """태스크 상태"""
    RUNNING = "running"
    COMPLETED = "completed"
    ERROR = "error"


class ExecuteRequest(BaseModel):
    """실행 요청

    agent_session_id를 제공하면 해당 세션을 resume합니다.
    미제공 시 서버가 새 agent_session_id를 생성합니다.
    """
    prompt: str = Field(..., description="실행할 프롬프트")
    agent_session_id: Optional[str] = Field(None, description="세션 식별자. 제공하면 resume, 미제공 시 서버가 생성.")
    client_id: Optional[str] = Field(None, description="클라이언트 식별자 (메타데이터, 로깅용)")
    attachment_paths: Optional[List[str]] = Field(None, description="첨부 파일 경로 목록")
    allowed_tools: Optional[List[str]] = Field(None, description="허용 도구 목록 (None이면 제한 없음)")
    disallowed_tools: Optional[List[str]] = Field(None, description="금지 도구 목록")
    use_mcp: bool = Field(True, description="MCP 서버 연결 여부")


class SessionResponse(BaseModel):
    """세션 정보 응답"""
    agent_session_id: str
    status: TaskStatus
    result: Optional[str] = None
    error: Optional[str] = None
    claude_session_id: Optional[str] = None
    created_at: datetime
    completed_at: Optional[datetime] = None


class SessionListResponse(BaseModel):
    """세션 목록 응답"""
    sessions: List[SessionResponse]


class InitSSEEvent(BaseModel):
    """세션 초기화 이벤트

    SSE 스트림의 첫 이벤트로 전송됩니다.
    클라이언트는 이 이벤트에서 agent_session_id를 확보합니다.
    """
    type: str = "init"
    agent_session_id: str = Field(..., description="서버가 할당한 세션 식별자")


# === 세분화 SSE Event Models (dashboard용) ===
#
# ThinkingBlock(extended thinking)과 TextBlock(assistant 가시적 응답)을
# "카드" 단위로 추상화합니다.


class ThinkingSSEEvent(BaseModel):
    """Extended Thinking 이벤트

    Claude의 ThinkingBlock(extended thinking) 내용을 전달합니다.
    thinking: 모델의 사고 과정 텍스트
    signature: 사고 블록 서명 (무결성 검증용)
    """
    type: str = "thinking"
    card_id: str = Field(..., description="사고 블록 단위 카드 ID")
    thinking: str = Field(..., description="사고 과정 텍스트")
    signature: str = Field(default="", description="사고 블록 서명")


class TextStartSSEEvent(BaseModel):
    """텍스트 블록 시작 이벤트

    AssistantMessage의 TextBlock 하나를 '카드'로 추상화하여
    시작 시점을 알립니다.
    """
    type: str = "text_start"
    card_id: str = Field(..., description="텍스트 블록 단위 카드 ID")


class TextDeltaSSEEvent(BaseModel):
    """텍스트 블록 내용 이벤트

    TextBlock의 전체 텍스트 내용. SDK가 청크 스트리밍을 지원하지
    않으므로 한 번에 전체 텍스트가 전달됩니다.
    """
    type: str = "text_delta"
    card_id: str = Field(..., description="카드 ID")
    text: str = Field(..., description="텍스트 내용")


class TextEndSSEEvent(BaseModel):
    """텍스트 블록 완료 이벤트"""
    type: str = "text_end"
    card_id: str = Field(..., description="카드 ID")


class ToolStartSSEEvent(BaseModel):
    """도구 호출 시작 이벤트"""
    type: str = "tool_start"
    card_id: Optional[str] = Field(None, description="연관된 텍스트 블록의 카드 ID")
    tool_name: str = Field(..., description="도구 이름")
    tool_input: dict = Field(default_factory=dict, description="도구 입력 파라미터")
    tool_use_id: Optional[str] = Field(None, description="SDK ToolUseBlock ID (tool_result 매칭용)")


class ToolResultSSEEvent(BaseModel):
    """도구 결과 이벤트"""
    type: str = "tool_result"
    card_id: Optional[str] = Field(None, description="연관된 텍스트 블록의 카드 ID")
    tool_name: str = Field(..., description="도구 이름")
    result: str = Field(..., description="도구 실행 결과")
    is_error: bool = Field(False, description="오류 여부")
    tool_use_id: Optional[str] = Field(None, description="SDK ToolUseBlock ID (tool_start 매칭용)")


class ResultSSEEvent(BaseModel):
    """엔진 최종 결과 이벤트 (dashboard 전용)

    CompleteEvent/ErrorEvent와 병행 발행됩니다.
    슬랙봇은 CompleteEvent/ErrorEvent를 소비하고,
    대시보드는 ResultSSEEvent를 소비합니다.
    """
    type: str = "result"
    success: bool = Field(..., description="성공 여부")
    output: str = Field(..., description="출력 텍스트")
    error: Optional[str] = Field(None, description="오류 메시지")


class RateLimitProfileStatus(BaseModel):
    """프로필별 rate limit 타입 상태"""
    utilization: float | str = Field(..., description="사용률 (0~1) 또는 'unknown'")
    resets_at: Optional[str] = Field(None, description="리셋 시각 (ISO 8601)")


class RateLimitProfileInfo(BaseModel):
    """프로필의 rate limit 정보"""
    name: str = Field(..., description="프로필 이름")
    five_hour: RateLimitProfileStatus = Field(..., description="5시간 rate limit")
    seven_day: RateLimitProfileStatus = Field(..., description="7일 rate limit")


class CredentialAlertEvent(BaseModel):
    """크레덴셜 rate limit 알림 이벤트

    활성 프로필의 rate limit utilization이 95%를 넘으면 발행됩니다.
    모든 프로필의 rate limit 상태를 포함합니다.
    """
    type: str = "credential_alert"
    active_profile: str = Field(..., description="현재 활성 프로필")
    profiles: List[RateLimitProfileInfo] = Field(
        ..., description="전체 프로필 rate limit 상태"
    )


# === Session List API Models ===

class SessionInfo(BaseModel):
    """세션 요약 정보 (목록용)"""
    agent_session_id: str = Field(..., description="세션 식별자")
    status: TaskStatus = Field(..., description="세션 상태")
    prompt: str = Field(..., description="실행 프롬프트")
    created_at: datetime = Field(..., description="생성 시각")
    updated_at: datetime = Field(..., description="마지막 업데이트 시각")


class SessionsListResponse(BaseModel):
    """세션 목록 응답 (GET /sessions)"""
    sessions: List[SessionInfo] = Field(default_factory=list)


class SessionListSSEEvent(BaseModel):
    """세션 목록 SSE 이벤트 (연결 시 초기 목록)"""
    type: str = "session_list"
    sessions: List[SessionInfo] = Field(default_factory=list)


class SessionCreatedSSEEvent(BaseModel):
    """세션 생성 SSE 이벤트"""
    type: str = "session_created"
    session: SessionInfo = Field(..., description="생성된 세션 정보")


class SessionUpdatedSSEEvent(BaseModel):
    """세션 업데이트 SSE 이벤트"""
    type: str = "session_updated"
    agent_session_id: str = Field(..., description="세션 식별자")
    status: TaskStatus = Field(..., description="변경된 상태")
    updated_at: datetime = Field(..., description="업데이트 시각")


class SessionDeletedSSEEvent(BaseModel):
    """세션 삭제 SSE 이벤트"""
    type: str = "session_deleted"
    agent_session_id: str = Field(..., description="삭제된 세션 식별자")
