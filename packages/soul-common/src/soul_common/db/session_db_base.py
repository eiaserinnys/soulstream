"""
SessionDB 공용 인터페이스 및 유틸리티

두 SessionDB 구현(PostgresSessionDB, SqliteSessionDB)의 인터페이스를 정본화하고,
완전히 동일한 코드를 공용 모듈로 추출한다.

모든 SessionDB 구현은 SessionDBBase를 상속하여 인터페이스 일관성을 보장한다.
"""

import json
from abc import ABC, abstractmethod
from collections.abc import AsyncGenerator
from typing import Optional, Union

# ── 공유 상수 ──

SESSION_COLUMNS = frozenset({
    "folder_id", "display_name", "session_type", "status",
    "prompt", "client_id", "claude_session_id", "last_message",
    "metadata", "was_running_at_shutdown",
    "last_event_id", "last_read_event_id",
    "created_at", "updated_at", "node_id", "agent_id",
})

FOLDER_COLUMNS = frozenset({"name", "sort_order", "settings"})

FOLDER_JSONB_COLUMNS = frozenset({"settings"})

JSONB_COLUMNS = frozenset({"last_message", "metadata"})

TIMESTAMP_COLUMNS = frozenset({"created_at", "updated_at"})

IMMUTABLE_FIELDS: frozenset[str] = frozenset({
    "claude_session_id", "node_id", "agent_id",
})

UPDATE_SESSION_IMMUTABLE = frozenset({
    "node_id", "agent_id", "claude_session_id", "session_type", "created_at",
})

DEFAULT_FOLDERS: dict[str, str] = {
    "claude": "⚙️ 클로드 코드 세션",
    "llm": "⚙️ LLM 세션",
}


# ── 공용 유틸리티 함수 ──

def extract_searchable_text(event: dict) -> str:
    """이벤트에서 전문검색 인덱싱 대상 텍스트를 추출한다."""
    event_type = event.get("type")
    if event_type == "text_delta":
        return event.get("text", "")
    elif event_type == "thinking":
        return event.get("thinking", "")
    elif event_type in ("tool_use", "tool_start"):
        inp = event.get("input") or event.get("tool_input")
        if isinstance(inp, str):
            return inp
        if isinstance(inp, dict):
            return json.dumps(inp, ensure_ascii=False)
    elif event_type == "tool_result":
        content = event.get("result") or event.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            texts = [c.get("text", "") for c in content if isinstance(c, dict)]
            return " ".join(filter(None, texts))
    elif event_type in ("user", "user_message"):
        text = event.get("text") or event.get("content")
        if isinstance(text, str):
            return text
        if isinstance(text, list):
            texts = [c.get("text", "") for c in text if isinstance(c, dict)]
            return " ".join(filter(None, texts))
    return ""


def validate_immutable_fields(
    existing: dict,
    updates: dict[str, object],
) -> None:
    """불변 필드 덮어쓰기를 방지한다.

    기존 값이 설정되어 있고(not None), 새 값이 기존 값과 다르면
    ValueError를 발생시킨다. None으로의 덮어쓰기도 차단한다.

    Args:
        existing: DB에서 조회한 기존 레코드 (dict)
        updates: 덮어쓰려는 불변 필드와 값 ({field: new_val})
    """
    for field, new_val in updates.items():
        old_val = existing.get(field)
        if old_val is not None and old_val != new_val:
            raise ValueError(
                f"Immutable field '{field}' already set to {old_val!r}, "
                f"cannot overwrite with {new_val!r}"
            )


# ── 추상 기반 클래스 ──

class SessionDBBase(ABC):
    """SessionDB 인터페이스 정본.

    모든 SessionDB 구현은 이 ABC를 상속하여 인터페이스 일관성을 보장한다.
    메서드를 추가·삭제·시그니처 변경할 때는 이 ABC를 먼저 수정한다.

    구현 전용 확장 메서드(예: PostgresSessionDB.get_folder_counts,
    PostgresSessionDB.get_all_sessions의 feed_only 파라미터)는
    ABC에 포함하지 않는다.
    """

    DEFAULT_FOLDERS = DEFAULT_FOLDERS  # 하위 호환: Cls.DEFAULT_FOLDERS 접근 유지

    @property
    @abstractmethod
    def node_id(self) -> Optional[str]: ...

    # ── 연결 관리 ──

    @abstractmethod
    async def connect(self) -> None: ...

    @abstractmethod
    async def close(self) -> None: ...

    # ── 세션 CRUD ──

    @abstractmethod
    async def upsert_session(self, session_id: str, **fields) -> None: ...

    @abstractmethod
    async def register_session_initial(
        self,
        session_id: str,
        node_id: str,
        agent_id: Optional[str] = None,
        claude_session_id: Optional[str] = None,
        session_type: str = "claude",
        prompt: Optional[str] = None,
        client_id: Optional[str] = None,
        status: str = "running",
        created_at=None,
        updated_at=None,
        caller_session_id: Optional[str] = None,
    ) -> None: ...

    @abstractmethod
    async def set_claude_session_id(
        self, session_id: str, claude_session_id: str,
    ) -> None: ...

    @abstractmethod
    async def update_session(self, session_id: str, **fields) -> None: ...

    @abstractmethod
    async def get_session(self, session_id: str) -> Optional[dict]: ...

    @abstractmethod
    async def get_all_sessions(
        self,
        offset: int = 0,
        limit: int = 0,
        session_type: Optional[str] = None,
        folder_id: Optional[str] = None,
        node_id: Optional[str] = None,
        status: Optional[Union[str, list[str]]] = None,
    ) -> tuple[list[dict], int]: ...

    @abstractmethod
    async def delete_session(self, session_id: str) -> None: ...

    @abstractmethod
    async def update_session_status(self, session_id: str, status: str) -> None: ...

    @abstractmethod
    async def append_metadata(self, session_id: str, entry: dict) -> None: ...

    @abstractmethod
    async def update_last_message(self, session_id: str, last_message: dict) -> None: ...

    # ── 읽음 상태 관리 ──

    @abstractmethod
    async def update_last_read_event_id(self, session_id: str, event_id: int) -> bool: ...

    @abstractmethod
    async def get_read_position(self, session_id: str) -> tuple[int, int]: ...

    @abstractmethod
    async def mark_running_at_shutdown(self, session_ids: list[str] | None = None) -> None: ...

    @abstractmethod
    async def get_shutdown_sessions(self) -> list[dict]: ...

    @abstractmethod
    async def repair_broken_read_positions(self) -> int: ...

    @abstractmethod
    async def clear_shutdown_flags(self) -> None: ...

    # ── 이벤트 CRUD ──

    @abstractmethod
    async def append_event(
        self,
        session_id: str,
        event_type: str,
        payload: str,
        searchable_text: str,
        created_at: str,
    ) -> int: ...

    @abstractmethod
    async def read_events(
        self, session_id: str, after_id: int = 0,
        limit: int | None = None, event_types: list[str] | None = None,
    ) -> list[dict]: ...

    @abstractmethod
    async def stream_events_raw(
        self, session_id: str, after_id: int = 0,
    ) -> AsyncGenerator[tuple[int, str, str], None]: ...

    @abstractmethod
    async def read_one_event(self, session_id: str, event_id: int) -> Optional[dict]: ...

    @abstractmethod
    async def count_events(self, session_id: str) -> int: ...

    # ── 폴더 CRUD ──

    @abstractmethod
    async def create_folder(self, folder_id: str, name: str, sort_order: int = 0) -> None: ...

    @abstractmethod
    async def update_folder(self, folder_id: str, **fields) -> None: ...

    @abstractmethod
    async def get_folder(self, folder_id: str) -> Optional[dict]: ...

    @abstractmethod
    async def delete_folder(self, folder_id: str) -> None: ...

    @abstractmethod
    async def get_all_folders(self) -> list[dict]: ...

    @abstractmethod
    async def get_default_folder(self, name: str) -> Optional[dict]: ...

    @abstractmethod
    async def ensure_default_folders(self) -> None: ...

    @abstractmethod
    async def ensure_indexes(self) -> None: ...

    # ── 카탈로그 ──

    @abstractmethod
    async def assign_session_to_folder(
        self, session_id: str, folder_id: Optional[str],
    ) -> None: ...

    @abstractmethod
    async def rename_session(self, session_id: str, display_name: Optional[str]) -> None: ...

    @abstractmethod
    async def get_catalog(self) -> dict: ...

    # ── 경량 세션 목록 ──

    @abstractmethod
    async def list_sessions_summary(
        self,
        search: str | None = None,
        session_type: str | None = None,
        limit: int = 20,
        offset: int = 0,
        folder_id: str | None = None,
        node_id: str | None = None,
    ) -> tuple[list[dict], int]: ...

    # ── 전문검색 ──

    @abstractmethod
    async def search_events(
        self,
        query: str,
        session_ids: Optional[list[str]] = None,
        limit: int = 50,
        event_types: Optional[list[str]] = None,
    ) -> list[dict]: ...

    @abstractmethod
    async def search_events_by_session_id(
        self,
        session_id_query: str,
        event_types: Optional[list[str]] = None,
        limit: int = 50,
    ) -> list[dict]: ...

    # ── 하위 호환 staticmethod ──

    @staticmethod
    def extract_searchable_text(event: dict) -> str:
        """하위 호환용. 독립 함수 extract_searchable_text()를 위임한다."""
        return extract_searchable_text(event)
