"""
Pydantic 모델 - Request/Response 스키마
"""

import re
from datetime import datetime
from enum import Enum
from typing import Any, Optional, List
from pydantic import BaseModel, Field, field_validator

_TAG_NAME_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_\-]*$")


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
    # 서브에이전트 이벤트
    SUBAGENT_START = "subagent_start"
    SUBAGENT_STOP = "subagent_stop"
    # 사용자 입력 요청 이벤트
    INPUT_REQUEST = "input_request"
    INPUT_REQUEST_EXPIRED = "input_request_expired"


# === Request Models ===

class InterveneRequest(BaseModel):
    """개입 메시지 요청 (Task API 호환)"""
    text: str = Field(..., description="메시지 텍스트")
    user: str = Field(..., description="요청한 사용자")
    attachment_paths: Optional[List[str]] = Field(None, description="첨부 파일 경로 목록")


class InputResponseRequest(BaseModel):
    """AskUserQuestion 응답 요청

    클라이언트가 input_request 이벤트에 대한 사용자 응답을 전송합니다.
    """
    request_id: str = Field(..., description="input_request 이벤트의 request_id")
    answers: dict = Field(..., description="질문별 응답. {question_text: selected_label}")


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
    pid: Optional[int] = Field(None, description="Claude Code 프로세스 ID")


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
    parent_event_id: Optional[str] = Field(None, description="부모 이벤트 ID (task_executor가 user_request_id로 채움)")


class ErrorEvent(BaseModel):
    """오류 이벤트"""
    type: str = "error"
    message: str
    error_code: Optional[str] = Field(None, description="에러 코드 (예: SESSION_NOT_FOUND)")
    parent_event_id: Optional[str] = Field(None, description="부모 이벤트 ID (task_executor가 user_request_id로 채움)")


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
    INTERRUPTED = "interrupted"


class ContextItem(BaseModel):
    """하나의 맥락 항목."""
    key: str = Field(..., description="항목 이름, 프롬프트 조립 시 XML 태그명으로 사용. 알파벳/숫자/언더스코어/하이픈만 허용, 알파벳 또는 '_'로 시작.")
    label: str = Field(..., description="대시보드 표시용 라벨")
    content: Any = Field(..., description="항목 내용 — 네이티브 JSON (dict, list, str, number 등)")

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
    """실행 요청

    agent_session_id를 제공하면 해당 세션을 resume합니다.
    미제공 시 서버가 새 agent_session_id를 생성합니다.
    """
    prompt: str = Field(..., description="실행할 프롬프트")
    context: Optional[StructuredContext] = Field(None, description="구조화된 맥락")
    agent_session_id: Optional[str] = Field(None, description="세션 식별자. 제공하면 resume, 미제공 시 서버가 생성.")
    client_id: Optional[str] = Field(None, description="클라이언트 식별자 (메타데이터, 로깅용)")
    attachment_paths: Optional[List[str]] = Field(None, description="첨부 파일 경로 목록")
    allowed_tools: Optional[List[str]] = Field(None, description="허용 도구 목록 (None이면 제한 없음)")
    disallowed_tools: Optional[List[str]] = Field(None, description="금지 도구 목록")
    use_mcp: bool = Field(True, description="MCP 서버 연결 여부")
    context_items: Optional[List[dict]] = Field(
        None,
        description="추가 컨텍스트 항목 목록. 각 항목은 {key, label, content} 형태.",
    )
    model: Optional[str] = Field(None, description="Claude 모델명. 미지정 시 서버 기본 모델 사용.")


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
    """Extended Thinking 이벤트"""
    type: str = "thinking"
    timestamp: float = Field(..., description="이벤트 발행 시각 (Unix epoch)")
    thinking: str = Field(..., description="사고 과정 텍스트")
    signature: str = Field(default="", description="사고 블록 서명")
    parent_event_id: Optional[str] = Field(None, description="서브에이전트 내부인 경우 부모 이벤트 ID")


class TextStartSSEEvent(BaseModel):
    """텍스트 블록 시작 이벤트"""
    type: str = "text_start"
    timestamp: float = Field(..., description="이벤트 발행 시각 (Unix epoch)")
    parent_event_id: Optional[str] = Field(None, description="서브에이전트 내부인 경우 부모 이벤트 ID")


class TextDeltaSSEEvent(BaseModel):
    """텍스트 블록 내용 이벤트"""
    type: str = "text_delta"
    timestamp: float = Field(..., description="이벤트 발행 시각 (Unix epoch)")
    text: str = Field(..., description="텍스트 내용")
    parent_event_id: Optional[str] = Field(None, description="서브에이전트 내부인 경우 부모 이벤트 ID")


class TextEndSSEEvent(BaseModel):
    """텍스트 블록 완료 이벤트"""
    type: str = "text_end"
    timestamp: float = Field(..., description="이벤트 발행 시각 (Unix epoch)")
    parent_event_id: Optional[str] = Field(None, description="서브에이전트 내부인 경우 부모 이벤트 ID")


class ToolStartSSEEvent(BaseModel):
    """도구 호출 시작 이벤트"""
    type: str = "tool_start"
    timestamp: float = Field(..., description="이벤트 발행 시각 (Unix epoch)")
    tool_name: str = Field(..., description="도구 이름")
    tool_input: dict = Field(default_factory=dict, description="도구 입력 파라미터")
    tool_use_id: Optional[str] = Field(None, description="SDK ToolUseBlock ID (tool_result 매칭용)")
    parent_event_id: Optional[str] = Field(None, description="서브에이전트 내부인 경우 부모 이벤트 ID")


class ToolResultSSEEvent(BaseModel):
    """도구 결과 이벤트"""
    type: str = "tool_result"
    timestamp: float = Field(..., description="이벤트 발행 시각 (Unix epoch)")
    tool_name: str = Field(..., description="도구 이름")
    result: str = Field(..., description="도구 실행 결과")
    is_error: bool = Field(False, description="오류 여부")
    tool_use_id: Optional[str] = Field(None, description="SDK ToolUseBlock ID (tool_start 매칭용)")
    parent_event_id: Optional[str] = Field(None, description="서브에이전트 내부인 경우 부모 이벤트 ID")


class ResultSSEEvent(BaseModel):
    """엔진 최종 결과 이벤트 (dashboard 전용)

    CompleteEvent/ErrorEvent와 병행 발행됩니다.
    슬랙봇은 CompleteEvent/ErrorEvent를 소비하고,
    대시보드는 ResultSSEEvent를 소비합니다.
    """
    type: str = "result"
    timestamp: float = Field(..., description="이벤트 발행 시각 (Unix epoch)")
    success: bool = Field(..., description="성공 여부")
    output: str = Field(..., description="출력 텍스트")
    error: Optional[str] = Field(None, description="오류 메시지")
    usage: Optional[dict] = Field(None, description="토큰 사용량 {input_tokens, output_tokens}")
    total_cost_usd: Optional[float] = Field(None, description="총 비용 (USD)")
    parent_event_id: Optional[str] = Field(None, description="서브에이전트 내부인 경우 부모 이벤트 ID")


class SubagentStartSSEEvent(BaseModel):
    """서브에이전트 시작 이벤트"""
    type: str = "subagent_start"
    timestamp: float = Field(..., description="이벤트 발행 시각 (Unix epoch)")
    agent_id: str = Field(..., description="서브에이전트 고유 ID")
    agent_type: str = Field(..., description="서브에이전트 타입 (Explore, Plan 등)")
    parent_event_id: Optional[str] = Field(None, description="부모 이벤트 ID")


class SubagentStopSSEEvent(BaseModel):
    """서브에이전트 종료 이벤트"""
    type: str = "subagent_stop"
    timestamp: float = Field(..., description="이벤트 발행 시각 (Unix epoch)")
    agent_id: str = Field(..., description="서브에이전트 고유 ID")
    parent_event_id: Optional[str] = Field(None, description="부모 이벤트 ID")


class InputRequestQuestion(BaseModel):
    """AskUserQuestion의 개별 질문"""
    question: str = Field(..., description="질문 텍스트")
    header: str = Field(default="", description="질문 헤더")
    options: List[dict] = Field(default_factory=list, description="선택지 목록. [{label, description}]")
    multi_select: bool = Field(False, description="복수 선택 허용 여부")


class InputRequestSSEEvent(BaseModel):
    """사용자 입력 요청 이벤트 (AskUserQuestion)

    Claude Code가 AskUserQuestion 도구를 호출하면 발행됩니다.
    클라이언트는 이 이벤트를 받아 사용자에게 선택지를 표시하고,
    POST /sessions/{id}/respond로 응답을 전송합니다.
    """
    type: str = "input_request"
    timestamp: float = Field(..., description="이벤트 발행 시각 (Unix epoch)")
    request_id: str = Field(..., description="응답 시 사용할 요청 식별자")
    tool_use_id: str = Field(default="", description="SDK tool_use_id")
    questions: List[InputRequestQuestion] = Field(..., description="질문 목록")
    parent_event_id: Optional[str] = Field(None, description="서브에이전트 내부인 경우 부모 이벤트 ID")
    started_at: float = Field(..., description="서버가 타이머를 시작한 시각 (Unix epoch)")
    timeout_sec: float = Field(..., description="응답 대기 타임아웃 (초)")


class InputRequestExpiredSSEEvent(BaseModel):
    """사용자 입력 요청 만료 이벤트

    AskUserQuestion 타임아웃이 발생하면 발행됩니다.
    클라이언트는 이 이벤트를 받아 선택 창을 닫아야 합니다.
    """
    type: str = "input_request_expired"
    request_id: str = Field(..., description="만료된 요청 식별자")
    timestamp: float = Field(..., description="이벤트 발행 시각 (Unix epoch)")


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
    pid: Optional[int] = Field(None, description="프로세스 ID")
    session_type: str = Field("claude", description="세션 타입: claude | llm")
    last_message: Optional[dict] = Field(None, description="마지막 메시지 정보")
    llm_provider: Optional[str] = Field(None, description="LLM 프로바이더 (openai, anthropic 등)")
    llm_model: Optional[str] = Field(None, description="LLM 모델명")
    llm_usage: Optional[dict] = Field(None, description="LLM 토큰 사용량")
    client_id: Optional[str] = Field(None, description="LLM 클라이언트 식별자")


class SessionsListResponse(BaseModel):
    """세션 목록 응답 (GET /sessions)"""
    sessions: List[SessionInfo] = Field(default_factory=list)
    total: int = Field(0, description="전체 세션 수 (페이지네이션용)")


class SessionListSSEEvent(BaseModel):
    """세션 목록 SSE 이벤트 (연결 시 초기 목록)"""
    type: str = "session_list"
    sessions: List[SessionInfo] = Field(default_factory=list)
    total: int = Field(0, description="전체 세션 수")


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
