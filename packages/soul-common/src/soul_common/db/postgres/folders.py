"""PostgresFolderMixin — 폴더 CRUD + 카탈로그 (PostgreSQL)"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    import asyncpg

from soul_common.db.session_db_base import (
    FOLDER_COLUMNS as _FOLDER_COLUMNS,
    FOLDER_JSONB_COLUMNS as _FOLDER_JSONB_COLUMNS,
    DEFAULT_FOLDERS,
)

logger = logging.getLogger(__name__)


class PostgresFolderMixin:
    """폴더 CRUD + 카탈로그 (PostgreSQL 구현)

    Mixin이므로 self._pool은 PostgresSessionDB.__init__에서 설정된다.
    """

    _pool: asyncpg.Pool

    async def create_folder(self, folder_id: str, name: str, sort_order: int = 0) -> None:
        await self._pool.execute(
            "SELECT folder_create($1, $2, $3)",
            folder_id, name, sort_order,
        )

    async def update_folder(self, folder_id: str, **fields) -> None:
        if not fields:
            return
        invalid = set(fields) - _FOLDER_COLUMNS
        if invalid:
            raise ValueError(f"Invalid folder columns: {invalid}")

        columns = list(fields.keys())
        values = [
            json.dumps(v, ensure_ascii=False) if k in _FOLDER_JSONB_COLUMNS else str(v)
            for k, v in fields.items()
        ]

        await self._pool.execute(
            "SELECT folder_update($1, $2, $3)",
            folder_id, columns, values,
        )

    async def get_folder(self, folder_id: str) -> Optional[dict]:
        row = await self._pool.fetchrow(
            "SELECT * FROM folder_get($1)", folder_id
        )
        if row is None:
            return None
        d = dict(row)
        # asyncpg가 JSONB 코덱 미등록 시 settings를 문자열로 반환하는 경우 역직렬화
        if isinstance(d.get("settings"), str):
            try:
                d["settings"] = json.loads(d["settings"])
            except (json.JSONDecodeError, ValueError):
                d["settings"] = {}
        return d

    async def delete_folder(self, folder_id: str) -> None:
        await self._pool.execute(
            "SELECT folder_delete($1)", folder_id
        )

    async def get_all_folders(self) -> list[dict]:
        rows = await self._pool.fetch(
            "SELECT * FROM folder_get_all()"
        )
        result = []
        for r in rows:
            d = dict(r)
            # asyncpg는 TIMESTAMPTZ를 Python datetime 객체로 반환 — JSON 직렬화를 위해 변환
            if d.get("created_at") is not None:
                d["created_at"] = d["created_at"].isoformat()
            # asyncpg가 JSONB 컬럼을 문자열로 반환하는 경우 역직렬화
            if isinstance(d.get("settings"), str):
                try:
                    d["settings"] = json.loads(d["settings"])
                except (json.JSONDecodeError, ValueError):
                    d["settings"] = {}
            result.append(d)
        return result

    async def get_default_folder(self, name: str) -> Optional[dict]:
        row = await self._pool.fetchrow(
            "SELECT * FROM folder_get_default($1)", name
        )
        return dict(row) if row else None

    async def ensure_default_folders(self) -> None:
        folders_json = json.dumps([
            {"id": fid, "name": fname, "sort_order": 0}
            for fid, fname in DEFAULT_FOLDERS.items()
        ])
        await self._pool.execute(
            "SELECT folder_ensure_defaults($1::jsonb)", folders_json,
        )

    async def ensure_indexes(self) -> None:
        """No-op. 인덱스는 schema.sql에서 DDL로 관리한다."""
        pass

    # --- 카탈로그 ---

    async def assign_session_to_folder(
        self, session_id: str, folder_id: Optional[str]
    ) -> None:
        await self._pool.execute(
            "SELECT session_assign_folder($1, $2)",
            session_id, folder_id,
        )

    async def rename_session(self, session_id: str, display_name: Optional[str]) -> None:
        await self._pool.execute(
            "SELECT session_rename($1, $2)",
            session_id, display_name,
        )

    async def get_catalog(self) -> dict:
        folders = await self.get_all_folders()
        folder_list = [
            {
                "id": f["id"],
                "name": f["name"],
                "sortOrder": f["sort_order"],
                "settings": f.get("settings") or {},
            }
            for f in folders
        ]

        rows = await self._pool.fetch(
            "SELECT * FROM catalog_get_sessions()"
        )
        sessions = {}
        for r in rows:
            sessions[r["session_id"]] = {
                "folderId": r["folder_id"],
                "displayName": r["display_name"],
            }

        return {"folders": folder_list, "sessions": sessions}
