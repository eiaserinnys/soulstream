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


class NodeMismatchError(Exception):
    """세션이 다른 노드 소속임을 나타내는 예외."""

    def __init__(self, session_node_id: str, current_node_id: str):
        self.session_node_id = session_node_id
        self.current_node_id = current_node_id
        super().__init__(
            f"Session belongs to node '{session_node_id}', "
            f"but current node is '{current_node_id}'"
        )


def utc_now() -> datetime:
    """현재 UTC 시간 반환"""
    return datetime.now(timezone.utc)


def datetime_to_str(dt: datetime) -> str:
    """datetime을 ISO 문자열로 변환"""
    return dt.isoformat()


def str_to_datetime(s: str | datetime) -> datetime:
    """ISO 문자열 또는 datetime을 datetime으로 변환.

    asyncpg는 datetime 객체를 직접 반환하므로 이미 datetime이면 그대로 반환.
    """
    if isinstance(s, datetime):
        return s
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

    # 에이전트 프로필 ID (DB에 agent_id로 영속화)
    profile_id: Optional[str] = field(default=None, repr=False)

    # 발신 세션 ID (DB 저장 — 완료 시 자동 보고 대상)
    caller_session_id: Optional[str] = None

    # 발신자 정보 (runtime + DB metadata 양쪽에 저장)
    # {"source": "slack"|"browser"|"agent"|"api",
    #  "ip": str?, "user_agent": str?, "referer": str?, "forwarded_for": str?,
    #  "agent_node": str?, "agent_id": str?, "agent_name": str?,
    #  "slack": dict?, "bot_name": str?}
    caller_info: Optional[dict] = field(default=None, repr=False)

    # OAuth 토큰 직접 지정 (런타임 전용, 영속화 안 됨)
    oauth_token: Optional[str] = field(default=None, repr=False)

    # 모델 지정 (런타임 전용, 영속화 안 됨)
    model: Optional[str] = field(default=None, repr=False)

    # 시스템 프롬프트 (런타임 전용, 영속화 안 됨)
    system_prompt: Optional[str] = field(default=None, repr=False)

    # 첨부 파일 경로 (런타임 전용, 영속화 안 됨 — DB events payload에 별도 기록)
    attachment_paths: Optional[List[str]] = field(default=None, repr=False)

    # LLM 프록시 메타데이터
    session_type: str = "claude"        # "claude" | "llm"
    llm_provider: Optional[str] = None  # "openai" | "anthropic"
    llm_model: Optional[str] = None     # ex. "gpt-5-mini"
    llm_usage: Optional[dict] = field(default=None, repr=False)  # {"input_tokens": N, "output_tokens": N}

    # 구조화된 맥락 (실행 파라미터, 이력 추적용으로 영속화됨)
    context: Optional[dict] = field(default=None, repr=False)

    # 세션 메타데이터 (커밋, 브랜치, 카드 등 산출물 기록, 영속화됨)
    metadata: List[dict] = field(default_factory=list, repr=False)

    # 읽음 상태 추적
    last_event_id: int = 0
    last_read_event_id: int = 0

    # 결과
    result: Optional[str] = None
    error: Optional[str] = None

    # 타임스탬프
    created_at: datetime = field(default_factory=utc_now)
    completed_at: Optional[datetime] = None

    # 노드 식별 (런타임 전용, DB에서 별도 관리)
    node_id: Optional[str] = None

    # 대기 중인 폴더 배정 (런타임 전용, 영속화 안 됨)
    # create_task()에서 지정한 folder_id를 보관했다가 register_session() 시점(DB INSERT 완료 후)에 처리한다.
    pending_folder_id: Optional[str] = field(default=None, repr=False)

    # 런타임 전용 (영속화 안 됨)
    preserve_claude_session_id_on_register: bool = field(default=False, repr=False)
    intervention_queue: asyncio.Queue = field(default_factory=asyncio.Queue, repr=False)
    execution_task: Optional[asyncio.Task] = field(default=None, repr=False)
    last_progress_text: Optional[str] = field(default=None, repr=False)
    # 마지막 어시스턴트 응답 텍스트 — 최종 assistant_message로 덮어쓴다.
    # 푸시 알림 body·세션 카드 preview에 사용 (push notifier _push_body_preview).
    # last_progress_text("진행 안내 메시지")와 의미가 다르므로 분리한다.
    last_assistant_text: Optional[str] = field(default=None, repr=False)
    # AskUserQuestion 응답 전달 콜백 (실행 중에만 유효)
    # Callable[[str, dict], bool]: (request_id, answers) -> success
    _deliver_input_response: object = field(default=None, repr=False)
    # 현재 turn을 실행 중인 runner. interrupt_task()가 interrupt() 공개 인터페이스만 호출한다.
    _runner: object = field(default=None, repr=False)

    @property
    def key(self) -> str:
        """세션 키 (= agent_session_id)"""
        return self.agent_session_id

    def to_session_info(
        self,
        agent_name: Optional[str] = None,
        agent_portrait_url: Optional[str] = None,
        agent_backend: Optional[str] = None,
    ) -> dict:
        """대시보드용 세션 요약 정보 dict 변환

        GET /sessions 응답, SSE session_list/session_created 이벤트에서 사용합니다.

        Args:
            agent_name: 에이전트 이름 (AgentRegistry에서 호출자가 조회하여 전달).
            agent_portrait_url: 에이전트 portrait 서빙 URL (호출자가 조회하여 전달).
            agent_backend: 에이전트 실행 백엔드 ("claude" | "codex" 등). 옵션 D Phase A.
                None이면 wire에 `backend: None`이 박힘 — graceful (orch enrichment는 source 키 부재로 동작 일관).
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
        # caller_session_id는 immutable이며 항상 노출 (None 가능).
        # 부모 세션 식별의 정본이 caller_info.parent_session_id가 아닌 이 컬럼임을
        # wire에서도 1급으로 표현한다 (design-principles §3 "정본 하나").
        info["caller_session_id"] = self.caller_session_id
        info["metadata"] = self.metadata
        info["last_event_id"] = self.last_event_id
        info["last_read_event_id"] = self.last_read_event_id
        if self.node_id:
            info["node_id"] = self.node_id
        # 에이전트 프로필 정보
        if self.profile_id:
            info["agentId"] = self.profile_id
            info["agentName"] = agent_name
            info["agentPortraitUrl"] = agent_portrait_url
            # 옵션 D Phase A: agent backend wire 운반. None이면 None 값으로 박힘 (graceful).
            info["backend"] = agent_backend
        # F-10C fix(2026-05-08): 사용자 프로필 정보 (catalog API와 정합 — caller_info 직접 사용).
        # session_created/list 이벤트가 wire에 user 프로필을 운반하지 못해 클라이언트가
        # 폴백 표시되던 결함을 차단한다. self.caller_info가 None이면 누락 (graceful —
        # orch session_serializer의 node_id fallback과 동일 graceful 정책).
        caller_info_dict = self.caller_info or {}
        display_name = caller_info_dict.get("display_name")
        avatar_url = caller_info_dict.get("avatar_url")
        if isinstance(display_name, str) and display_name:
            info["userName"] = display_name
        if isinstance(avatar_url, str) and avatar_url:
            info["userPortraitUrl"] = avatar_url
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
            "last_event_id": self.last_event_id,
            "last_read_event_id": self.last_read_event_id,
            "result": self.result,
            "error": self.error,
            "created_at": datetime_to_str(self.created_at),
            "completed_at": datetime_to_str(self.completed_at) if self.completed_at else None,
            "profile_id": self.profile_id,
            "caller_session_id": self.caller_session_id,
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
            last_event_id=data.get("last_event_id", 0),
            last_read_event_id=data.get("last_read_event_id", 0),
            result=data.get("result"),
            error=data.get("error"),
            created_at=str_to_datetime(data["created_at"]),
            completed_at=str_to_datetime(data["completed_at"]) if data.get("completed_at") else None,
            profile_id=data.get("profile_id"),
            caller_session_id=data.get("caller_session_id"),
        )


# 이벤트 타입별 미리보기 텍스트 필드 매핑 (readable durable events only)
# - thinking: ThinkingSSEEvent.thinking
# - assistant_message: AssistantMessageSSEEvent.content
# - result: ResultSSEEvent.output
# - complete: CompleteEvent.result
# - error: ErrorEvent.message
# intervention_sent는 별도 처리 (EventPersistence.update_last_message)
PREVIEW_FIELD_MAP: dict[str, str] = {
    "thinking":      "thinking",
    "assistant_message": "content",
    "text_delta":    "text",
    "result":        "output",
    "complete":      "result",
    "error":         "message",
    "away_summary":  "content",
}
