"""SqliteFolderMixin — 폴더 CRUD + 카탈로그 (SQLite)"""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    import aiosqlite

from soul_common.db.session_db_base import (
    FOLDER_COLUMNS as _FOLDER_COLUMNS,
    FOLDER_JSONB_COLUMNS as _FOLDER_JSONB_COLUMNS,
    DEFAULT_FOLDERS,
)
from soul_common.db.sqlite._helpers import _utc_now

logger = logging.getLogger(__name__)


class SqliteFolderMixin:
    """폴더 CRUD + 카탈로그 (SQLite 구현)

    Mixin이므로 self._conn은 SqliteSessionDB.__init__에서 설정된다.
    """

    _conn: aiosqlite.Connection

    async def create_folder(
        self,
        folder_id: str,
        name: str,
        sort_order: int = 0,
        parent_folder_id: Optional[str] = None,
    ) -> None:
        await self._validate_parent_folder(folder_id, parent_folder_id)
        await self._conn.execute(
            "INSERT OR IGNORE INTO folders (id, name, sort_order, parent_folder_id) VALUES (?, ?, ?, ?)",
            (folder_id, name, sort_order, parent_folder_id),
        )
        await self._conn.commit()

    async def update_folder(self, folder_id: str, **fields) -> None:
        if not fields:
            return
        invalid = set(fields) - _FOLDER_COLUMNS
        if invalid:
            raise ValueError(f"Invalid folder columns: {invalid}")
        if "parent_folder_id" in fields:
            await self._validate_parent_folder(folder_id, fields["parent_folder_id"])
        set_clauses = ", ".join(f"{c} = ?" for c in fields)
        vals = [
            json.dumps(v, ensure_ascii=False) if k in _FOLDER_JSONB_COLUMNS else v
            for k, v in fields.items()
        ] + [folder_id]
        await self._conn.execute(
            f"UPDATE folders SET {set_clauses} WHERE id = ?", vals
        )
        await self._conn.commit()

    async def get_folder(self, folder_id: str) -> Optional[dict]:
        cursor = await self._conn.execute(
            "SELECT * FROM folders WHERE id = ?", (folder_id,)
        )
        row = await cursor.fetchone()
        if row is None:
            return None
        d = dict(row)
        # SQLite는 settings를 TEXT로 저장하므로 항상 문자열 역직렬화 필요
        if "settings" in d and isinstance(d["settings"], str):
            try:
                d["settings"] = json.loads(d["settings"])
            except (json.JSONDecodeError, ValueError):
                d["settings"] = {}
        return d

    async def delete_folder(self, folder_id: str) -> None:
        await self._conn.execute(
            "DELETE FROM folders WHERE id = ?", (folder_id,)
        )
        await self._conn.commit()

    async def get_all_folders(self) -> list[dict]:
        cursor = await self._conn.execute(
            "SELECT * FROM folders ORDER BY sort_order ASC"
        )
        rows = await cursor.fetchall()
        result = []
        for r in rows:
            d = dict(r)
            if "settings" in d and isinstance(d["settings"], str):
                try:
                    d["settings"] = json.loads(d["settings"])
                except Exception:
                    d["settings"] = {}
            result.append(d)
        return result

    async def get_default_folder(self, name: str) -> Optional[dict]:
        """DEFAULT_FOLDERS에 정의된 기본 폴더를 name으로 조회한다."""
        # name으로 역참조
        for fid, fname in DEFAULT_FOLDERS.items():
            if fname == name:
                return await self.get_folder(fid)
        return None

    async def ensure_default_folders(self) -> None:
        for fid, fname in DEFAULT_FOLDERS.items():
            await self._conn.execute(
                "INSERT OR IGNORE INTO folders (id, name, sort_order) VALUES (?, ?, ?)",
                (fid, fname, 0),
            )
        await self._conn.commit()

    async def ensure_indexes(self) -> None:
        """No-op. 인덱스는 schema.sql에서 DDL로 관리한다."""
        pass

    # --- 카탈로그 ---

    async def assign_session_to_folder(
        self, session_id: str, folder_id: Optional[str]
    ) -> None:
        await self._conn.execute(
            "UPDATE sessions SET folder_id = ?, updated_at = ? WHERE session_id = ?",
            (folder_id, _utc_now(), session_id),
        )
        await self._conn.commit()

    async def rename_session(self, session_id: str, display_name: Optional[str]) -> None:
        await self._conn.execute(
            "UPDATE sessions SET display_name = ?, updated_at = ? WHERE session_id = ?",
            (display_name, _utc_now(), session_id),
        )
        await self._conn.commit()

    async def get_catalog(self) -> dict:
        folders = await self.get_all_folders()
        folder_list = [
            {
                "id": f["id"],
                "name": f["name"],
                "sortOrder": f["sort_order"],
                "parentFolderId": f.get("parent_folder_id"),
                "settings": f.get("settings") or {},
            }
            for f in folders
        ]

        cursor = await self._conn.execute(
            "SELECT session_id, folder_id, display_name FROM sessions"
        )
        rows = await cursor.fetchall()
        sessions = {
            r["session_id"]: {
                "folderId": r["folder_id"],
                "displayName": r["display_name"],
            }
            for r in rows
        }
        return {"folders": folder_list, "sessions": sessions}

    async def _validate_parent_folder(
        self,
        folder_id: str,
        parent_folder_id: Optional[str],
    ) -> None:
        if parent_folder_id is None:
            return
        if folder_id == parent_folder_id:
            raise ValueError("folder parent cycle")

        cursor = await self._conn.execute(
            "SELECT id, parent_folder_id FROM folders"
        )
        rows = await cursor.fetchall()
        parent_by_id = {r["id"]: r["parent_folder_id"] for r in rows}
        current = parent_folder_id
        seen: set[str] = set()
        while current is not None:
            if current == folder_id:
                raise ValueError("folder parent cycle")
            if current in seen:
                raise ValueError("folder parent cycle")
            seen.add(current)
            current = parent_by_id.get(current)
