"""
공통 Pydantic 모델 — soul-server와 soulstream-server가 공유

soulstream-server(오케스트레이터)가 import하는 모델만 여기에 위치한다.
soul-server 전용 모델(AttachmentUploadResponse, SettingMeta 등)은
soul-server의 models/schemas.py에 잔류한다.
"""

from datetime import datetime
from enum import Enum
from typing import Any, Optional, List
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
    # 서브에이전트 이벤트
    SUBAGENT_START = "subagent_start"
    SUBAGENT_STOP = "subagent_stop"
    # 메타데이터 이벤트
    METADATA_UPDATED = "metadata_updated"
    # 사용자 입력 요청 이벤트
    INPUT_REQUEST = "input_request"
    INPUT_REQUEST_EXPIRED = "input_request_expired"
    INPUT_REQUEST_RESPONDED = "input_request_responded"


class TaskStatus(str, Enum):
    """태스크 상태"""
    RUNNING = "running"
    COMPLETED = "completed"
    ERROR = "error"
    INTERRUPTED = "interrupted"


# === Request Models ===

class InterveneRequest(BaseModel):
    """개입 메시지 요청 (Task API 호환)"""
    text: str = Field(..., description="메시지 텍스트")
    user: str = Field(..., description="요청한 사용자")
    attachment_paths: Optional[List[str]] = Field(None, description="첨부 파일 경로 목록")


class InputResponseRequest(BaseModel):
    """AskUserQuestion 응답 요청"""
    request_id: str = Field(..., description="input_request 이벤트의 request_id")
    answers: dict = Field(..., description="질문별 응답. {question_text: selected_label}")


# === Response Models ===

class InterveneResponse(BaseModel):
    """개입 메시지 응답"""
    queued: bool
    queue_position: int


class HealthResponse(BaseModel):
    """헬스 체크 응답"""
    status: str
    version: str
    uptime_seconds: int
    environment: Optional[str] = None


class CreateSessionResponse(BaseModel):
    """세션 생성 응답 (오케스트레이터 + soul-dashboard 공통)"""
    agentSessionId: str = Field(..., description="생성된 세션 식별자")
    nodeId: Optional[str] = Field(None, description="세션이 생성된 노드 ID")


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
    """세션 ID 조기 통지 이벤트"""
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
    claude_session_id: Optional[str] = Field(None, description="Claude Code 세션 ID (resume용)")
    parent_event_id: Optional[str] = Field(None, description="부모 이벤트 ID")


class ErrorEvent(BaseModel):
    """오류 이벤트"""
    type: str = "error"
    message: str
    error_code: Optional[str] = Field(None, description="에러 코드")
    parent_event_id: Optional[str] = Field(None, description="부모 이벤트 ID")


# === Session List API Models ===

class SessionInfo(BaseModel):
    """세션 요약 정보 (목록용)"""
    agent_session_id: str = Field(..., description="세션 식별자")
    status: Optional[TaskStatus] = Field(None, description="세션 상태")
    prompt: Optional[str] = Field(None, description="실행 프롬프트")
    created_at: Optional[datetime] = Field(None, description="생성 시각")
    updated_at: Optional[datetime] = Field(None, description="마지막 업데이트 시각")
    pid: Optional[int] = Field(None, description="프로세스 ID")
    session_type: str = Field("claude", description="세션 타입: claude | llm")
    last_message: Optional[dict] = Field(None, description="마지막 메시지 정보")
    llm_provider: Optional[str] = Field(None, description="LLM 프로바이더")
    llm_model: Optional[str] = Field(None, description="LLM 모델명")
    llm_usage: Optional[dict] = Field(None, description="LLM 토큰 사용량")
    client_id: Optional[str] = Field(None, description="클라이언트 식별자")
    metadata: Optional[List[dict]] = Field(None, description="세션 메타데이터")
    display_name: Optional[str] = Field(None, description="세션 표시 이름")
    node_id: Optional[str] = Field(None, description="노드 식별자")


class SessionsListResponse(BaseModel):
    """세션 목록 응답 (GET /sessions)"""
    sessions: List[SessionInfo] = Field(default_factory=list)
    total: int = Field(0, description="전체 세션 수")


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


class MetadataUpdatedSSEEvent(BaseModel):
    """세션 메타데이터 업데이트 SSE 이벤트"""
    type: str = "metadata_updated"
    session_id: str = Field(..., description="세션 식별자")
    entry: dict = Field(..., description="새로 추가된 메타데이터 엔트리")
    metadata: List[dict] = Field(default_factory=list, description="전체 메타데이터 배열")


class SessionDeletedSSEEvent(BaseModel):
    """세션 삭제 SSE 이벤트"""
    type: str = "session_deleted"
    agent_session_id: str = Field(..., description="삭제된 세션 식별자")
