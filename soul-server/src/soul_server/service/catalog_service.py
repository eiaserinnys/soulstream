"""
CatalogService - 폴더/세션 카탈로그 관리 서비스 계층

REST API와 MCP 도구가 공용으로 사용하는 비즈니스 로직 계층.
DB 호출 + 브로드캐스트를 캡슐화하여 구현 중복을 제거한다.
"""

import uuid
from typing import Optional

from soul_server.service.postgres_session_db import PostgresSessionDB
from soul_server.service.session_broadcaster import SessionBroadcaster


class CatalogService:
    """폴더/세션 카탈로그 관리 서비스"""

    def __init__(
        self,
        session_db: PostgresSessionDB,
        broadcaster: SessionBroadcaster,
    ):
        self._db = session_db
        self._broadcaster = broadcaster

    async def _broadcast_catalog(self) -> None:
        """카탈로그 변경을 모든 리스너에게 브로드캐스트한다."""
        catalog = await self._db.get_catalog()
        await self._broadcaster.broadcast({
            "type": "catalog_updated",
            "catalog": catalog,
        })

    # --- 폴더 CRUD ---

    async def list_folders(self) -> list[dict]:
        """전체 폴더 목록을 반환한다."""
        folders = await self._db.get_all_folders()
        return [
            {"id": f["id"], "name": f["name"], "sortOrder": f["sort_order"]}
            for f in folders
        ]

    async def create_folder(self, name: str, sort_order: int = 0) -> dict:
        """폴더를 생성하고 결과를 반환한다."""
        folder_id = str(uuid.uuid4())
        await self._db.create_folder(folder_id, name, sort_order)
        await self._broadcast_catalog()
        return {"id": folder_id, "name": name, "sortOrder": sort_order}

    async def rename_folder(self, folder_id: str, name: str) -> None:
        """폴더 이름을 변경한다."""
        await self._db.update_folder(folder_id, name=name)
        await self._broadcast_catalog()

    async def update_folder(
        self,
        folder_id: str,
        name: Optional[str] = None,
        sort_order: Optional[int] = None,
    ) -> None:
        """폴더의 이름 및/또는 정렬 순서를 변경한다."""
        fields: dict = {}
        if name is not None:
            fields["name"] = name
        if sort_order is not None:
            fields["sort_order"] = sort_order
        if not fields:
            return
        await self._db.update_folder(folder_id, **fields)
        await self._broadcast_catalog()

    async def delete_folder(self, folder_id: str) -> None:
        """폴더를 삭제한다."""
        await self._db.delete_folder(folder_id)
        await self._broadcast_catalog()

    # --- 세션 관리 ---

    async def move_sessions_to_folder(
        self,
        session_ids: list[str],
        folder_id: Optional[str],
    ) -> None:
        """세션들을 지정한 폴더로 이동한다. folder_id가 None이면 미배정."""
        for sid in session_ids:
            await self._db.assign_session_to_folder(sid, folder_id)
        await self._broadcast_catalog()

    async def rename_session(
        self,
        session_id: str,
        display_name: Optional[str],
    ) -> None:
        """세션의 표시 이름을 변경한다."""
        await self._db.rename_session(session_id, display_name)
        await self._broadcast_catalog()

    async def delete_session(self, session_id: str) -> None:
        """세션을 삭제한다."""
        await self._db.delete_session(session_id)
        # catalog_updated로 대시보드 폴더 뷰 갱신
        await self._broadcast_catalog()
        # session_deleted로 세션 목록 뷰 갱신
        await self._broadcaster.emit_session_deleted(session_id)

    async def get_catalog(self) -> dict:
        """전체 카탈로그(폴더 + 세션 배정)를 반환한다."""
        return await self._db.get_catalog()


# ---------------------------------------------------------------------------
# 글로벌 접근자 — get_session_db() 패턴과 동일
# ---------------------------------------------------------------------------

_catalog_service: Optional[CatalogService] = None


def init_catalog_service(
    session_db: PostgresSessionDB,
    broadcaster: SessionBroadcaster,
) -> CatalogService:
    """CatalogService 싱글톤을 초기화한다. main.py lifespan에서 호출."""
    global _catalog_service
    _catalog_service = CatalogService(session_db, broadcaster)
    return _catalog_service


def get_catalog_service() -> CatalogService:
    """초기화된 CatalogService 싱글톤을 반환한다."""
    if _catalog_service is None:
        raise RuntimeError(
            "CatalogService not initialized. Call init_catalog_service() first."
        )
    return _catalog_service
