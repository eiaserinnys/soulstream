"""
Task Models - 세션 태스크 데이터 모델 및 예외

세션(agent_session_id) 단위의 태스크 데이터 구조를 정의합니다.
"""

import asyncio
import secrets
from datetime import datetime, timezone
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional, List


class TaskStatus(str, Enum):
    """태스크 상태"""
    RUNNING = "running"
    COMPLETED = "completed"
    ERROR = "error"
    INTERRUPTED = "interrupted"


class TaskConflictError(Exception):
    """태스크 충돌 오류 (같은 세션에 running 태스크 존재)"""
    pass


class TaskNotFoundError(Exception):
    """태스크 없음 오류"""
    pass


class TaskNotRunningError(Exception):
    """태스크가 running 상태가 아님"""
    pass


def utc_now() -> datetime:
    """현재 UTC 시간 반환"""
    return datetime.now(timezone.utc)


def datetime_to_str(dt: datetime) -> str:
    """datetime을 ISO 문자열로 변환"""
    return dt.isoformat()


def str_to_datetime(s: str) -> datetime:
    """ISO 문자열을 datetime으로 변환"""
    return datetime.fromisoformat(s)


def generate_agent_session_id() -> str:
    """서버에서 고유한 agent_session_id 생성"""
    timestamp = utc_now().strftime("%Y%m%d%H%M%S")
    random_part = secrets.token_hex(4)
    return f"sess-{timestamp}-{random_part}"


@dataclass
class Task:
    """세션 태스크 데이터

    agent_session_id가 primary key입니다.
    하나의 세션은 여러 턴(user_message → complete)을 가질 수 있고,
    모든 이벤트는 같은 JSONL 파일에 축적됩니다.
    """
    agent_session_id: str
    prompt: str
    status: TaskStatus = TaskStatus.RUNNING

    # 메타데이터 (로깅용)
    client_id: Optional[str] = None

    # Claude Code 관련
    resume_session_id: Optional[str] = None
    claude_session_id: Optional[str] = None
    pid: Optional[int] = None  # 런타임 전용 (영속화 안 됨)

    # 도구 설정 (런타임 전용, 영속화 안 됨)
    allowed_tools: Optional[List[str]] = field(default=None, repr=False)
    disallowed_tools: Optional[List[str]] = field(default=None, repr=False)
    use_mcp: bool = field(default=True, repr=False)

    # 추가 컨텍스트 항목 (런타임 전용, 영속화 안 됨)
    # 각 항목은 {"key": str, "label": str, "content": Any} 형태
    context_items: Optional[List[dict]] = field(default=None, repr=False)

    # 모델 지정 (런타임 전용, 영속화 안 됨)
    model: Optional[str] = field(default=None, repr=False)

    # LLM 프록시 메타데이터
    session_type: str = "claude"        # "claude" | "llm"
    llm_provider: Optional[str] = None  # "openai" | "anthropic"
    llm_model: Optional[str] = None     # ex. "gpt-5-mini"
    llm_usage: Optional[dict] = field(default=None, repr=False)  # {"input_tokens": N, "output_tokens": N}

    # 구조화된 맥락 (실행 파라미터, 이력 추적용으로 영속화됨)
    context: Optional[dict] = field(default=None, repr=False)

    # 세션 메타데이터 (커밋, 브랜치, 카드 등 산출물 기록, 영속화됨)
    metadata: List[dict] = field(default_factory=list, repr=False)

    # 결과
    result: Optional[str] = None
    error: Optional[str] = None

    # 타임스탬프
    created_at: datetime = field(default_factory=utc_now)
    completed_at: Optional[datetime] = None

    # 런타임 전용 (영속화 안 됨)
    listeners: List[asyncio.Queue] = field(default_factory=list, repr=False)
    intervention_queue: asyncio.Queue = field(default_factory=asyncio.Queue, repr=False)
    execution_task: Optional[asyncio.Task] = field(default=None, repr=False)
    last_progress_text: Optional[str] = field(default=None, repr=False)
    # AskUserQuestion 응답 전달 콜백 (실행 중에만 유효)
    # Callable[[str, dict], bool]: (request_id, answers) -> success
    _deliver_input_response: object = field(default=None, repr=False)

    @property
    def key(self) -> str:
        """세션 키 (= agent_session_id)"""
        return self.agent_session_id

    def to_session_info(self) -> dict:
        """대시보드용 세션 요약 정보 dict 변환

        GET /sessions 응답, SSE session_list/session_created 이벤트에서 사용합니다.
        """
        updated_at = self.completed_at or self.created_at
        info = {
            "agent_session_id": self.agent_session_id,
            "status": self.status.value,
            "prompt": self.prompt,
            "created_at": self.created_at.isoformat(),
            "updated_at": updated_at.isoformat(),
            "pid": self.pid,
            "session_type": self.session_type,
        }
        if self.session_type != "claude":
            info["llm_provider"] = self.llm_provider
            info["llm_model"] = self.llm_model
            info["llm_usage"] = self.llm_usage
            info["client_id"] = self.client_id
        info["metadata"] = self.metadata
        return info

    def to_dict(self) -> dict:
        """영속화용 dict 변환"""
        return {
            "agent_session_id": self.agent_session_id,
            "prompt": self.prompt,
            "status": self.status.value,
            "client_id": self.client_id,
            "resume_session_id": self.resume_session_id,
            "claude_session_id": self.claude_session_id,
            "session_type": self.session_type,
            "llm_provider": self.llm_provider,
            "llm_model": self.llm_model,
            "llm_usage": self.llm_usage,
            "context": self.context,
            "metadata": self.metadata,
            "result": self.result,
            "error": self.error,
            "created_at": datetime_to_str(self.created_at),
            "completed_at": datetime_to_str(self.completed_at) if self.completed_at else None,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Task":
        """dict에서 복원"""
        return cls(
            agent_session_id=data["agent_session_id"],
            prompt=data.get("prompt", ""),
            status=TaskStatus(data["status"]),
            client_id=data.get("client_id"),
            resume_session_id=data.get("resume_session_id"),
            claude_session_id=data.get("claude_session_id"),
            session_type=data.get("session_type", "claude"),
            llm_provider=data.get("llm_provider"),
            llm_model=data.get("llm_model"),
            llm_usage=data.get("llm_usage"),
            context=data.get("context"),
            metadata=data.get("metadata", []),
            result=data.get("result"),
            error=data.get("error"),
            created_at=str_to_datetime(data["created_at"]),
            completed_at=str_to_datetime(data["completed_at"]) if data.get("completed_at") else None,
        )


# 이벤트 타입별 미리보기 텍스트 필드 매핑 (readable events only)
# - thinking: ThinkingSSEEvent.thinking
# - text_delta: TextDeltaSSEEvent.text (block.text 전체, 청크 아님)
# - result: ResultSSEEvent.output
# - complete: CompleteEvent.result
# - error: ErrorEvent.message
# intervention_sent는 별도 처리 (_update_and_broadcast_last_message L291~292)
PREVIEW_FIELD_MAP: dict[str, str] = {
    "thinking":   "thinking",
    "text_delta": "text",
    "result":     "output",
    "complete":   "result",
    "error":      "error",
}
