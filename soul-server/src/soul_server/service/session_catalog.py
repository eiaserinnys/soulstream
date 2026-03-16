"""
SessionCatalog - 세션 카탈로그 (경량 인덱스)

모든 세션의 메타데이터를 유지하는 경량 인덱스입니다.
TaskManager._tasks에서 퇴거된 세션도 카탈로그에는 남아있어,
세션 목록 조회(GET /sessions)를 메모리 효율적으로 처리합니다.

영속화: session_catalog.json (atomic write, 500ms 디바운스)
동시성: asyncio.Lock (단일 프로세스)
"""

import asyncio
import json
import logging
from pathlib import Path
from typing import Dict, Optional

from soul_server.service.task_models import (
    Task,
    datetime_to_str,
    utc_now,
)

logger = logging.getLogger(__name__)


class SessionCatalog:
    """세션 카탈로그 - 모든 세션의 메타데이터 인덱스"""

    def __init__(self, catalog_path: Optional[Path] = None):
        """
        Args:
            catalog_path: 카탈로그 파일 경로 (None이면 영속화 안 함)
        """
        self._catalog_path = catalog_path
        self._entries: Dict[str, dict] = {}
        self._lock = asyncio.Lock()
        self._save_scheduled = False
        self._pending_save_task: Optional[asyncio.Task] = None

    # === 빌드 ===

    async def build_from_tasks(self, tasks: Dict[str, Task]) -> None:
        """카탈로그를 전체 리빌드한다 (카탈로그 손상 시 복구 전용).

        기존 엔트리를 모두 clear한 뒤 tasks에 있는 세션만 재생성한다.
        정상 기동 경로에서는 사용하지 않는다 — load() 후 upsert_from_task()를 사용한다.

        Args:
            tasks: 로드된 Task 딕셔너리
        """
        async with self._lock:
            # 기존 카탈로그에서 last_message 보존
            old_entries = dict(self._entries)
            self._entries.clear()

            for session_id, task in tasks.items():
                entry = self._task_to_entry(task)
                # 기존 카탈로그의 last_message 복원
                old = old_entries.get(session_id)
                if old and old.get("last_message"):
                    entry["last_message"] = old["last_message"]
                self._entries[session_id] = entry

            await self._save_to_file()
            logger.info(f"SessionCatalog built: {len(self._entries)} entries")

    @staticmethod
    def _task_to_entry(task: Task) -> dict:
        """Task를 카탈로그 엔트리로 변환

        last_message는 Task에 존재하지 않는 카탈로그 전용 필드이므로
        이 메서드에서 생성하지 않는다. 기존 엔트리의 last_message 보존은
        upsert_from_task()가 담당한다.
        """
        return {
            "status": task.status.value,
            "prompt": task.prompt,
            "session_type": task.session_type,
            "llm_provider": task.llm_provider,
            "llm_model": task.llm_model,
            "client_id": task.client_id,
            "claude_session_id": task.claude_session_id,
            "created_at": datetime_to_str(task.created_at),
            "completed_at": (
                datetime_to_str(task.completed_at) if task.completed_at else None
            ),
            "pid": task.pid,
        }

    def __len__(self) -> int:
        """카탈로그 엔트리 수"""
        return len(self._entries)

    def known_session_ids(self) -> set:
        """카탈로그에 등록된 모든 세션 ID를 반환한다."""
        return set(self._entries.keys())

    # === CRUD ===

    def upsert_from_task(self, task: Task) -> None:
        """Task 객체로부터 카탈로그 엔트리 생성/업데이트

        _task_to_entry()는 last_message를 포함하지 않으므로,
        기존 엔트리의 last_message는 upsert()의 update()에서 자연스럽게 유지된다.

        Args:
            task: 등록할 Task 인스턴스
        """
        self.upsert(task.agent_session_id, **self._task_to_entry(task))

    def upsert(self, session_id: str, **fields) -> None:
        """카탈로그 엔트리 생성 또는 업데이트

        Args:
            session_id: 세션 식별자
            **fields: 업데이트할 필드 (status, prompt, completed_at 등)
        """
        if session_id not in self._entries:
            self._entries[session_id] = {}
        self._entries[session_id].update(fields)
        self.schedule_save()

    def update_last_message(
        self, session_id: str, msg_type: str, preview: str, timestamp: str
    ) -> None:
        """세션의 마지막 메시지 정보 업데이트

        Args:
            session_id: 세션 식별자
            msg_type: 이벤트 타입 (user_message, thinking, complete 등)
            preview: 메시지 미리보기 (최대 200자)
            timestamp: ISO 8601 타임스탬프
        """
        entry = self._entries.get(session_id)
        if not entry:
            return
        entry["last_message"] = {
            "type": msg_type,
            "preview": preview[:200],
            "timestamp": timestamp,
        }
        entry["updated_at"] = timestamp
        self.schedule_save()

    def remove(self, session_id: str) -> None:
        """카탈로그에서 세션 제거"""
        self._entries.pop(session_id, None)
        self.schedule_save()

    # === 조회 ===

    def get_all(
        self, offset: int = 0, limit: int = 0
    ) -> tuple[list[dict], int]:
        """전체 카탈로그 엔트리 반환 (마지막 활동 시간 내림차순)

        updated_at(마지막 메시지 수신 시간)이 있으면 그것을 기준으로 정렬하고,
        없으면 created_at으로 폴백한다.

        Args:
            offset: 건너뛸 항목 수
            limit: 반환할 최대 항목 수 (0이면 전체)

        Returns:
            (엔트리 리스트, 전체 수) 튜플
        """
        all_entries = [
            {"agent_session_id": sid, **entry}
            for sid, entry in self._entries.items()
        ]
        all_entries.sort(
            key=lambda e: e.get("updated_at") or e.get("created_at", ""),
            reverse=True,
        )
        total = len(all_entries)

        if offset > 0:
            all_entries = all_entries[offset:]
        if limit > 0:
            all_entries = all_entries[:limit]

        return all_entries, total

    def get(self, session_id: str) -> Optional[dict]:
        """단일 카탈로그 엔트리 조회

        Returns:
            엔트리 dict (agent_session_id 포함) 또는 None
        """
        entry = self._entries.get(session_id)
        if entry is not None:
            return {"agent_session_id": session_id, **entry}
        return None

    # === 영속화 ===

    def schedule_save(self) -> None:
        """500ms 디바운스 저장 예약"""
        if self._save_scheduled:
            return
        self._save_scheduled = True
        try:
            loop = asyncio.get_running_loop()
            self._pending_save_task = loop.create_task(self._debounced_save())
        except RuntimeError:
            # 이벤트 루프 없음 (테스트 등)
            self._save_scheduled = False

    async def _debounced_save(self) -> None:
        """디바운스된 저장 실행"""
        await asyncio.sleep(0.5)
        self._save_scheduled = False
        self._pending_save_task = None
        await self._save_to_file()

    async def save_now(self) -> None:
        """즉시 저장 (셧다운 등)"""
        # 대기 중인 디바운스 취소
        if self._pending_save_task and not self._pending_save_task.done():
            self._pending_save_task.cancel()
            try:
                await self._pending_save_task
            except asyncio.CancelledError:
                pass
        self._save_scheduled = False
        self._pending_save_task = None
        await self._save_to_file()

    async def _save_to_file(self) -> None:
        """카탈로그를 파일에 저장 (atomic write)"""
        if not self._catalog_path:
            return
        try:
            data = {
                "entries": self._entries,
                "last_saved": datetime_to_str(utc_now()),
            }
            self._catalog_path.parent.mkdir(parents=True, exist_ok=True)
            temp_path = self._catalog_path.with_suffix(".tmp")
            temp_path.write_text(
                json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            temp_path.replace(self._catalog_path)
            logger.debug(f"SessionCatalog saved: {len(self._entries)} entries")
        except Exception as e:
            logger.error(f"Failed to save session catalog: {e}")

    async def load(self) -> None:
        """파일에서 카탈로그 로드"""
        if not self._catalog_path or not self._catalog_path.exists():
            return
        try:
            raw = self._catalog_path.read_text(encoding="utf-8")
            data = json.loads(raw)
            self._entries = data.get("entries", {})
            logger.info(f"SessionCatalog loaded: {len(self._entries)} entries")
        except Exception as e:
            logger.error(f"Failed to load session catalog: {e}")

    async def flush_pending_save(self) -> None:
        """대기 중인 저장 완료 대기"""
        if self._pending_save_task and not self._pending_save_task.done():
            await self._pending_save_task
