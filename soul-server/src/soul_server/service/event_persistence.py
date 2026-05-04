"""
Event Persistence — 이벤트 영속화 + DB 부수효과 처리

TaskExecutor에서 DB 관련 관심사(이벤트 저장, subtree 전파, last_message 갱신,
메타데이터 추출, away_summary)를 분리한다.
"""

import json
import logging
import time
from datetime import datetime, timezone
from typing import Callable, Optional, TYPE_CHECKING

from soul_common.db.session_db_base import extract_searchable_text
from soul_server.service.task_models import Task, PREVIEW_FIELD_MAP, datetime_to_str, utc_now
from soul_server.service.session_broadcaster import get_session_broadcaster

if TYPE_CHECKING:
    from soul_server.service.postgres_session_db import PostgresSessionDB
    from soul_server.service.metadata_extractor import MetadataExtractor

logger = logging.getLogger(__name__)


class EventPersistence:
    """이벤트 영속화 및 DB 부수효과 처리 헬퍼.

    TaskExecutor의 DB 관련 로직을 캡슐화하여 _consume_event_stream의 복잡도를 줄인다.
    """

    def __init__(
        self,
        session_db: Optional["PostgresSessionDB"],
        metadata_extractor: Optional["MetadataExtractor"] = None,
        append_metadata_func: Optional[Callable] = None,
        get_broadcaster: Optional[Callable] = None,
    ):
        self._db = session_db
        self._metadata_extractor = metadata_extractor
        self._append_metadata = append_metadata_func
        self._get_broadcaster = get_broadcaster or get_session_broadcaster

    async def persist_event(self, session_id: str, event_dict: dict) -> Optional[int]:
        """이벤트를 SessionDB에 영속화하고 event_id를 반환한다."""
        if self._db is None:
            return None
        event_type = event_dict.get("type", "")
        payload = json.dumps(event_dict, ensure_ascii=False)
        searchable = extract_searchable_text(event_dict)
        ts = event_dict.get("timestamp")
        if isinstance(ts, (int, float)):
            created_at = datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
        elif isinstance(ts, str):
            created_at = ts
        else:
            created_at = utc_now().isoformat()
        event_id = await self._db.append_event(session_id, event_type, payload, searchable, created_at)
        return event_id

    async def persist_with_subtree(
        self, session_id: str, event_dict: dict, task: Task
    ) -> Optional[dict]:
        """이벤트 영속화 + subtree_update 계산.

        Returns:
            subtree_update dict (브로드캐스트용) 또는 None.
        """
        if self._db is None:
            return None

        subtree_update_dict: Optional[dict] = None
        try:
            event_id = await self.persist_event(session_id, event_dict)
            event_dict["_event_id"] = event_id
            if event_id is not None:
                task.last_event_id = event_id

            # 조상 이벤트들의 subtree_height 전파 + subtree_update SSE 이벤트 생성
            if event_id is not None and event_dict.get("parent_event_id") is not None:
                try:
                    deltas, new_total = await self._db.update_subtree_heights(
                        session_id, event_id, increment=1
                    )
                    subtree_update_dict = {
                        "type": "subtree_update",
                        "timestamp": time.time(),
                        "affected_event_ids": list(deltas.keys()),
                        "deltas": deltas,
                        "new_total_subtree_height": new_total,
                        "trigger_event_id": event_id,
                    }
                    # subtree_update도 영속화 (재연결 복구용)
                    subtree_event_id = await self.persist_event(
                        session_id, subtree_update_dict
                    )
                    subtree_update_dict["_event_id"] = subtree_event_id
                except Exception as e:
                    logger.warning(
                        f"Failed to compute subtree_update for {session_id}: {e}"
                    )
                    subtree_update_dict = None
        except Exception as e:
            logger.warning(f"Failed to persist event for {session_id}: {e}")
            subtree_update_dict = None

        return subtree_update_dict

    async def update_last_message(
        self, session_id: str, event_dict: dict, task: Task
    ) -> None:
        """readable event의 last_message를 카탈로그에 저장하고 세션 리스트 SSE로 브로드캐스트."""
        if self._db is None:
            return

        event_type = event_dict.get("type", "")

        # user_message 전용: text 또는 messages에서 preview 추출
        if event_type == "user_message":
            text = event_dict.get("text", "")
            if not text and "messages" in event_dict:
                for m in reversed(event_dict.get("messages", [])):
                    if m.get("role") == "user":
                        c = m.get("content", "")
                        if isinstance(c, str):
                            text = c
                        elif isinstance(c, list):
                            text = " ".join(
                                p.get("text", "") for p in c
                                if isinstance(p, dict) and p.get("type") == "text"
                            )
                        break
        elif event_type == "intervention_sent":
            text = event_dict.get("text", "")
        else:
            text_field = PREVIEW_FIELD_MAP.get(event_type)
            if not text_field:
                return
            text = event_dict.get(text_field, "")

        if not isinstance(text, str) or not text:
            return

        ts = event_dict.get("timestamp")
        if isinstance(ts, (int, float)):
            ts_str = datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
        elif isinstance(ts, str):
            ts_str = ts
        else:
            ts_str = datetime_to_str(utc_now())

        await self._db.update_last_message(session_id, {
            "type": event_type,
            "preview": text[:200],
            "timestamp": ts_str,
        })

        try:
            broadcaster = self._get_broadcaster()
            await broadcaster.emit_session_message_updated(
                agent_session_id=session_id,
                status=task.status.value,
                updated_at=ts_str,
                last_message={
                    "type": event_type,
                    "preview": text[:200],
                    "timestamp": ts_str,
                },
                last_event_id=task.last_event_id,
                last_read_event_id=task.last_read_event_id,
            )
        except Exception:
            logger.debug("session list broadcast skipped (broadcaster not ready)")

    async def handle_side_effects(
        self, session_id: str, event_type: str, event_dict: dict, task: Task
    ) -> None:
        """이벤트 후처리 부수효과: last_message 갱신, 메타데이터 추출, away_summary 저장."""
        # last_message 갱신
        try:
            await self.update_last_message(session_id, event_dict, task)
        except Exception:
            logger.debug("last_message update failed")

        # tool_result 메타데이터 자동 추출
        if (
            event_type == "tool_result"
            and self._metadata_extractor
            and self._append_metadata
        ):
            try:
                entry = self._metadata_extractor.extract(
                    tool_name=event_dict.get("tool_name", ""),
                    result=event_dict.get("result", ""),
                    is_error=event_dict.get("is_error", False),
                )
                if entry:
                    await self._append_metadata(session_id, entry)
            except Exception:
                logger.warning(
                    f"Metadata extraction failed for {session_id}",
                    exc_info=True,
                )

        # away_summary → sessions.away_summary에 저장
        if event_type == "away_summary" and self._db is not None:
            try:
                await self._db.update_away_summary(
                    session_id, event_dict.get("content", "")
                )
            except Exception:
                logger.debug("away_summary DB update failed")
