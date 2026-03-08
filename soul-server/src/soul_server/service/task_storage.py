"""
Task Storage - 태스크 영속화 관리

JSON 파일 기반의 태스크 상태 영속화를 담당합니다.
"""

import asyncio
import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Dict, Optional

from soul_server.service.task_models import (
    Task,
    TaskStatus,
    utc_now,
    datetime_to_str,
    str_to_datetime,
)

if TYPE_CHECKING:
    from soul_server.service.event_store import EventStore

logger = logging.getLogger(__name__)

# JSONL 마지막 이벤트 타입 → TaskStatus 매핑 (result는 success 필드에 따라 분기)
_EVENT_TYPE_TO_STATUS = {
    "complete": TaskStatus.COMPLETED,
    "error": TaskStatus.ERROR,
}


def _rebuild_task_from_events(agent_session_id: str, events: list) -> Task:
    """JSONL 이벤트 목록으로부터 Task 객체를 재구성한다.

    Args:
        agent_session_id: 세션 식별자
        events: JSONL 이벤트 레코드 리스트 (각 항목: {"id": int, "event": dict})

    Returns:
        복구된 Task 객체
    """
    prompt = ""
    client_id = None
    claude_session_id = None
    result = None
    error = None
    status = TaskStatus.INTERRUPTED  # 기본: 터미널 이벤트 없으면 interrupted
    created_at = None
    completed_at = None

    # 첫 번째 이벤트의 timestamp → created_at
    first_event = events[0].get("event", {})
    ts = first_event.get("timestamp")
    if ts:
        try:
            created_at = str_to_datetime(ts)
        except (ValueError, TypeError):
            pass

    # 세션 ID에서 타임스탬프 추출 시도 (sess-YYYYMMDDHHMMSS-xxxx)
    if not created_at and agent_session_id.startswith("sess-"):
        parts = agent_session_id.split("-")
        if len(parts) >= 2:
            try:
                created_at = datetime.strptime(parts[1], "%Y%m%d%H%M%S").replace(
                    tzinfo=timezone.utc
                )
            except (ValueError, IndexError):
                pass

    if not created_at:
        created_at = utc_now()

    # 이벤트 순회: 첫 user_message → prompt/client_id, 마지막 터미널 → status/result
    for record in events:
        event = record.get("event", {})
        event_type = event.get("type")

        if event_type == "user_message" and not prompt:
            prompt = event.get("content", "")
            client_id = event.get("client_id")

        # claude_session_id 추출 (system 이벤트 또는 이벤트 공통 필드)
        sid = event.get("claude_session_id") or event.get("session_id")
        if sid:
            claude_session_id = sid

    # 역순으로 터미널 이벤트 탐색
    for record in reversed(events):
        event = record.get("event", {})
        event_type = event.get("type")

        if event_type == "result":
            if event.get("success"):
                status = TaskStatus.COMPLETED
                result = event.get("result", "")
            else:
                status = TaskStatus.ERROR
                error = event.get("error", "JSONL 기반 복구 — 에러 발생")
            ts = event.get("timestamp")
            if ts:
                try:
                    completed_at = str_to_datetime(ts)
                except (ValueError, TypeError):
                    pass
            break

        if event_type == "complete":
            status = TaskStatus.COMPLETED
            result = event.get("result", "")
            ts = event.get("timestamp")
            if ts:
                try:
                    completed_at = str_to_datetime(ts)
                except (ValueError, TypeError):
                    pass
            break

        if event_type == "error":
            status = TaskStatus.ERROR
            error = event.get("error", "JSONL 기반 복구 — 에러 발생")
            ts = event.get("timestamp")
            if ts:
                try:
                    completed_at = str_to_datetime(ts)
                except (ValueError, TypeError):
                    pass
            break

    if not completed_at:
        completed_at = created_at

    return Task(
        agent_session_id=agent_session_id,
        prompt=prompt or "(복구됨 — 원본 프롬프트 없음)",
        status=status,
        client_id=client_id,
        claude_session_id=claude_session_id,
        result=result,
        error=error,
        created_at=created_at,
        completed_at=completed_at,
    )


class TaskStorage:
    """
    태스크 영속화 관리자

    JSON 파일을 통해 태스크 상태를 영속화합니다.
    - debounce 저장으로 I/O 최적화
    - atomic write로 데이터 무결성 보장
    """

    def __init__(self, storage_path: Optional[Path] = None):
        """
        Args:
            storage_path: 태스크 저장 파일 경로 (None이면 영속화 안 함)
        """
        self._storage_path = storage_path
        self._save_scheduled = False
        self._pending_save_task: Optional[asyncio.Task] = None

    async def load(
        self,
        tasks: Dict[str, Task],
        event_store: Optional["EventStore"] = None,
    ) -> int:
        """
        파일에서 태스크 로드

        서비스 시작 시 호출.
        running 상태의 태스크는 JSONL 이벤트를 확인하여 실제 상태를 보정한 뒤,
        이벤트에도 완료 기록이 없으면 interrupted로 마킹합니다.

        Args:
            tasks: 로드된 태스크를 저장할 딕셔너리
            event_store: JSONL 이벤트 저장소 (상태 보정에 사용)

        Returns:
            로드된 태스크 수
        """
        if not self._storage_path or not self._storage_path.exists():
            logger.info("No existing tasks file to load")
            return 0

        try:
            try:
                raw = self._storage_path.read_text(encoding='utf-8')
            except UnicodeDecodeError:
                logger.warning("tasks.json is not UTF-8, trying cp949 (legacy)")
                raw = self._storage_path.read_text(encoding='cp949')
            data = json.loads(raw)
            tasks_data = data.get("tasks", {})

            loaded = 0
            reconciled = 0
            for key, task_data in tasks_data.items():
                try:
                    task = Task.from_dict(task_data)

                    # running 상태의 태스크: JSONL 이벤트로 실제 상태 보정
                    if task.status == TaskStatus.RUNNING:
                        reconciled_status = self._reconcile_status_from_events(
                            task.agent_session_id, event_store
                        )
                        if reconciled_status:
                            task.status = reconciled_status
                            task.completed_at = utc_now()
                            if reconciled_status == TaskStatus.ERROR:
                                task.error = "서비스 재시작 전 에러 발생 (JSONL 기반 보정)"
                            logger.info(
                                f"Reconciled task status from JSONL: "
                                f"{task.key} → {reconciled_status.value}"
                            )
                            reconciled += 1
                        else:
                            task.status = TaskStatus.INTERRUPTED
                            task.error = "서비스 재시작으로 중단됨"
                            task.completed_at = utc_now()
                            logger.warning(f"Marked interrupted task: {task.key}")

                    # key는 agent_session_id (마이그레이션: 기존 client_id:request_id 키 무시)
                    tasks[task.key] = task
                    loaded += 1
                except Exception as e:
                    logger.error(f"Failed to load task {key}: {e}")

            logger.info(
                f"Loaded {loaded} tasks from storage"
                + (f" ({reconciled} reconciled from JSONL)" if reconciled else "")
            )

            # 고아 세션 복구: JSONL에는 있지만 tasks.json에 없는 세션 복구
            orphans_recovered = 0
            if event_store:
                orphans_recovered = self._recover_orphan_sessions(tasks, event_store)

            # 상태 변경사항 저장
            await self._save(tasks)

            return loaded + orphans_recovered

        except Exception as e:
            logger.error(f"Failed to load tasks file: {e}")
            return 0

    @staticmethod
    def _reconcile_status_from_events(
        agent_session_id: str,
        event_store: Optional["EventStore"],
    ) -> Optional[TaskStatus]:
        """JSONL 이벤트의 마지막 터미널 이벤트로 실제 상태를 판별한다.

        JSONL을 역순으로 탐색하여 complete/result/error 중 가장 마지막 것을 찾는다.
        터미널 이벤트가 없으면 None을 반환한다 (호출자가 interrupted로 처리).

        Args:
            agent_session_id: 세션 식별자
            event_store: JSONL 이벤트 저장소

        Returns:
            보정된 TaskStatus 또는 None
        """
        if not event_store:
            return None

        try:
            events = event_store.read_all(agent_session_id)
        except Exception as e:
            logger.warning(
                f"Failed to read JSONL for reconciliation ({agent_session_id}): {e}"
            )
            return None

        if not events:
            return None

        # 역순으로 터미널 이벤트 탐색
        for record in reversed(events):
            event = record.get("event", {})
            event_type = event.get("type")

            # result 이벤트는 success 필드에 따라 분기
            if event_type == "result":
                return TaskStatus.COMPLETED if event.get("success") else TaskStatus.ERROR

            status = _EVENT_TYPE_TO_STATUS.get(event_type)
            if status:
                return status

        return None

    @staticmethod
    def _recover_orphan_sessions(
        tasks: Dict[str, Task],
        event_store: "EventStore",
    ) -> int:
        """JSONL에는 존재하지만 tasks.json에 없는 고아 세션을 복구한다.

        인코딩 오류 등으로 tasks.json 저장이 실패한 경우,
        JSONL 이벤트 로그로부터 Task 객체를 재구성하여 복구한다.

        Args:
            tasks: 현재 로드된 태스크 딕셔너리 (복구된 태스크가 추가됨)
            event_store: JSONL 이벤트 저장소

        Returns:
            복구된 세션 수
        """
        try:
            jsonl_sessions = event_store.list_sessions()
        except Exception as e:
            logger.warning(f"Failed to list JSONL sessions for orphan recovery: {e}")
            return 0

        known_ids = set(tasks.keys())
        recovered = 0

        for session_info in jsonl_sessions:
            agent_session_id = session_info["agent_session_id"]
            if agent_session_id in known_ids:
                continue

            try:
                events = event_store.read_all(agent_session_id)
                if not events:
                    continue

                task = _rebuild_task_from_events(agent_session_id, events)
                tasks[task.key] = task
                recovered += 1
                logger.info(
                    f"Recovered orphan session from JSONL: "
                    f"{agent_session_id} → {task.status.value}"
                )
            except Exception as e:
                logger.warning(
                    f"Failed to recover orphan session {agent_session_id}: {e}"
                )

        if recovered:
            logger.info(f"Recovered {recovered} orphan session(s) from JSONL")

        return recovered

    async def _save(self, tasks: Dict[str, Task]) -> None:
        """태스크를 파일에 저장 (내부용)"""
        if not self._storage_path:
            return

        try:
            data = {
                "tasks": {key: task.to_dict() for key, task in tasks.items()},
                "last_saved": datetime_to_str(utc_now()),
            }

            # 디렉토리 생성
            self._storage_path.parent.mkdir(parents=True, exist_ok=True)

            # 임시 파일에 먼저 쓰고 replace (atomic write)
            # Path.rename()은 Windows에서 대상 파일이 이미 존재하면 WinError 183을 발생시킴.
            # Path.replace()는 Windows/Unix 모두에서 원자적으로 덮어쓰기 가능.
            temp_path = self._storage_path.with_suffix(".tmp")
            temp_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
            temp_path.replace(self._storage_path)

            logger.debug(f"Saved {len(tasks)} tasks to storage")

        except Exception as e:
            logger.error(f"Failed to save tasks: {e}")

    async def save(self, tasks: Dict[str, Task]) -> None:
        """태스크 상태 저장 (public interface)"""
        await self._save(tasks)

    async def schedule_save(self, tasks: Dict[str, Task]) -> None:
        """저장 예약 (debounce)"""
        if self._save_scheduled:
            return

        self._save_scheduled = True

        async def do_save():
            await asyncio.sleep(0.5)  # 500ms debounce
            self._save_scheduled = False
            self._pending_save_task = None
            await self._save(tasks)

        self._pending_save_task = asyncio.create_task(do_save())

    async def flush_pending_save(self) -> None:
        """대기 중인 저장 완료 대기 (셧다운 시 호출)"""
        if self._pending_save_task is not None:
            await self._pending_save_task
