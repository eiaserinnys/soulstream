"""SQLite 공유 헬퍼 함수.

여러 mixin에서 공통으로 사용하는 직렬화/역직렬화 함수를 모아둔다.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    import aiosqlite

from soul_common.db.session_db_base import (
    JSONB_COLUMNS as _JSONB_COLUMNS,
    TIMESTAMP_COLUMNS as _TIMESTAMP_COLUMNS,
)


def _utc_now() -> str:
    """현재 UTC 시각을 ISO 8601 문자열로 반환한다."""
    return datetime.now(timezone.utc).isoformat()


def _to_iso(v) -> Optional[str]:
    """datetime 또는 ISO 문자열을 ISO 문자열로 정규화한다."""
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.isoformat()
    return str(v)


def _serialize_field(col: str, v) -> Optional[str]:
    """세션 컬럼 값을 SQLite 저장 형식(TEXT/INTEGER)으로 직렬화한다."""
    if v is None:
        return None
    if col in _JSONB_COLUMNS:
        if isinstance(v, (dict, list)):
            return json.dumps(v, ensure_ascii=False)
        return str(v)
    if col in _TIMESTAMP_COLUMNS:
        return _to_iso(v)
    if col == "was_running_at_shutdown":
        return 1 if v else 0
    return v


def _deserialize_session(row: aiosqlite.Row) -> dict:
    """SQLite Row를 Python dict으로 역직렬화한다."""
    d = dict(row)
    for field in _JSONB_COLUMNS:
        if isinstance(d.get(field), str):
            try:
                d[field] = json.loads(d[field])
            except (json.JSONDecodeError, TypeError):
                pass
    if "was_running_at_shutdown" in d:
        d["was_running_at_shutdown"] = bool(d["was_running_at_shutdown"])
    return d


def _event_to_dict(row: aiosqlite.Row) -> dict:
    """이벤트 Row를 dict으로 변환한다."""
    return dict(row)
