"""
CatalogService - 폴더/세션 카탈로그 관리 서비스 계층

REST API와 MCP 도구가 공용으로 사용하는 비즈니스 로직 계층.
DB 호출 + 브로드캐스트를 캡슐화하여 구현 중복을 제거한다.
"""

import uuid
from typing import Any, Optional, Protocol, runtime_checkable

from soul_common.db.session_db import PostgresSessionDB

_UNSET = object()
BOARD_GRID_SIZE = 20
BOARD_TILE_WIDTH = 160
BOARD_TILE_HEIGHT = 120
BOARD_DEFAULT_COLUMNS = 4


@runtime_checkable
class SessionBroadcasterProtocol(Protocol):
    """세션 목록 변경 브로드캐스터 인터페이스.

    CatalogService가 의존하는 최소 인터페이스.
    soul-server의 SessionBroadcaster, soulstream-server의 SoulstreamBroadcaster 등
    각 서비스가 자체 구현을 제공한다.
    """

    async def broadcast(self, event: dict) -> int: ...

    async def emit_session_deleted(self, agent_session_id: str) -> int: ...


class CatalogService:
    """폴더/세션 카탈로그 관리 서비스"""

    def __init__(
        self,
        session_db: PostgresSessionDB,
        broadcaster: SessionBroadcasterProtocol,
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

    def _snap_position(self, value: float) -> float:
        return float(round(value / BOARD_GRID_SIZE) * BOARD_GRID_SIZE)

    async def _next_board_position(self, folder_id: str) -> tuple[float, float]:
        await self._db.ensure_board_items()
        items = [
            item for item in await self._db.get_board_items()
            if item.get("folderId") == folder_id
        ]
        occupied = {
            (int(item.get("x", 0)), int(item.get("y", 0)))
            for item in items
        }
        index = 0
        while True:
            x = (index % BOARD_DEFAULT_COLUMNS) * BOARD_TILE_WIDTH
            y = (index // BOARD_DEFAULT_COLUMNS) * BOARD_TILE_HEIGHT
            if (x, y) not in occupied:
                return float(x), float(y)
            index += 1

    # --- 폴더 CRUD ---

    async def list_folders(self) -> list[dict]:
        """전체 폴더 목록을 반환한다."""
        folders = await self._db.get_all_folders()
        return [
            {
                "id": f["id"],
                "name": f["name"],
                "sortOrder": f["sort_order"],
                "parentFolderId": f.get("parent_folder_id"),
                "settings": f.get("settings") or {},
                "createdAt": f.get("created_at"),
            }
            for f in folders
        ]

    async def create_folder(
        self,
        name: str,
        sort_order: int = 0,
        parent_folder_id: Optional[str] = None,
    ) -> dict:
        """폴더를 생성하고 결과를 반환한다."""
        folder_id = str(uuid.uuid4())
        await self._validate_parent_folder(folder_id, parent_folder_id)
        await self._db.create_folder(
            folder_id,
            name,
            sort_order,
            parent_folder_id=parent_folder_id,
        )
        await self._broadcast_catalog()
        return {
            "id": folder_id,
            "name": name,
            "sortOrder": sort_order,
            "parentFolderId": parent_folder_id,
            "settings": {},
        }

    async def rename_folder(self, folder_id: str, name: str) -> None:
        """폴더 이름을 변경한다."""
        await self._db.update_folder(folder_id, name=name)
        await self._broadcast_catalog()

    async def update_folder(
        self,
        folder_id: str,
        name: Optional[str] = None,
        sort_order: Optional[int] = None,
        settings: Optional[dict] = None,
        parent_folder_id: Any = _UNSET,
    ) -> None:
        """폴더의 이름, 정렬 순서, 설정을 변경한다."""
        fields: dict = {}
        if name is not None:
            fields["name"] = name
        if sort_order is not None:
            fields["sort_order"] = sort_order
        if settings is not None:
            fields["settings"] = settings
        if parent_folder_id is not _UNSET:
            await self._validate_parent_folder(folder_id, parent_folder_id)
            fields["parent_folder_id"] = parent_folder_id
        if not fields:
            return
        await self._db.update_folder(folder_id, **fields)
        await self._broadcast_catalog()

    async def list_child_folders(self, folder_id: Optional[str]) -> list[dict]:
        folders = await self.list_folders()
        return [f for f in folders if f.get("parentFolderId") == folder_id]

    async def delete_folder(self, folder_id: str) -> None:
        """폴더를 삭제한다."""
        await self._db.delete_folder(folder_id)
        await self._broadcast_catalog()

    async def reorder_folders(self, items: list[dict]) -> None:
        """여러 폴더의 sort_order와 parent_folder_id를 한 번에 업데이트한다.

        Args:
            items: [{"id": str, "sortOrder": int, "parentFolderId"?: str | None}, ...] 형태의 목록
        """
        await self._validate_folder_parent_updates({
            item["id"]: item["parentFolderId"]
            for item in items
            if "parentFolderId" in item
        })
        for item in items:
            fields: dict[str, Any] = {"sort_order": item["sortOrder"]}
            if "parentFolderId" in item:
                fields["parent_folder_id"] = item["parentFolderId"]
            await self._db.update_folder(item["id"], **fields)
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
        await self._db.ensure_board_items()
        await self._broadcast_catalog()

    async def broadcast_catalog(self) -> None:
        """카탈로그 상태를 브로드캐스트한다. DB 변경 없이 broadcast만 수행."""
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

    async def update_board_item_position(
        self,
        board_item_id: str,
        x: float,
        y: float,
    ) -> None:
        """보드 항목 좌표를 20px 격자에 스냅하여 저장한다."""
        await self._db.ensure_board_items()
        await self._db.update_board_item_position(
            board_item_id,
            self._snap_position(x),
            self._snap_position(y),
        )
        await self._broadcast_catalog()

    async def create_markdown_document(
        self,
        folder_id: str,
        title: str,
        body: str = "",
        x: Optional[float] = None,
        y: Optional[float] = None,
    ) -> dict:
        """마크다운 문서를 만들고 같은 폴더의 board item으로 배치한다."""
        document_id = str(uuid.uuid4())
        resolved_x, resolved_y = (
            (self._snap_position(x), self._snap_position(y))
            if x is not None and y is not None
            else await self._next_board_position(folder_id)
        )
        result = await self._db.create_markdown_document(
            document_id,
            folder_id,
            title,
            body,
            resolved_x,
            resolved_y,
        )
        await self._broadcast_catalog()
        return result

    async def get_markdown_document(self, document_id: str) -> Optional[dict]:
        return await self._db.get_markdown_document(document_id)

    async def update_markdown_document(
        self,
        document_id: str,
        title: Optional[str] = None,
        body: Optional[str] = None,
    ) -> Optional[dict]:
        document = await self._db.update_markdown_document(
            document_id,
            title=title,
            body=body,
        )
        await self._broadcast_catalog()
        return document

    async def delete_markdown_document(self, document_id: str) -> None:
        await self._db.delete_markdown_document(document_id)
        await self._broadcast_catalog()

    async def _validate_parent_folder(
        self,
        folder_id: str,
        parent_folder_id: Optional[str],
    ) -> None:
        if parent_folder_id is None:
            return
        if folder_id == parent_folder_id:
            raise ValueError("folder parent cycle")
        folders = await self._db.get_all_folders()
        parent_by_id = {f["id"]: f.get("parent_folder_id") for f in folders}
        current = parent_folder_id
        seen: set[str] = set()
        while current is not None:
            if current == folder_id:
                raise ValueError("folder parent cycle")
            if current in seen:
                raise ValueError("folder parent cycle")
            seen.add(current)
            current = parent_by_id.get(current)

    async def _validate_folder_parent_updates(
        self,
        parent_updates: dict[str, Optional[str]],
    ) -> None:
        if not parent_updates:
            return
        folders = await self._db.get_all_folders()
        parent_by_id = {f["id"]: f.get("parent_folder_id") for f in folders}
        parent_by_id.update(parent_updates)

        for folder_id, parent_folder_id in parent_updates.items():
            if parent_folder_id is None:
                continue
            if folder_id == parent_folder_id:
                raise ValueError("folder parent cycle")
            current = parent_folder_id
            seen: set[str] = set()
            while current is not None:
                if current == folder_id:
                    raise ValueError("folder parent cycle")
                if current in seen:
                    raise ValueError("folder parent cycle")
                seen.add(current)
                current = parent_by_id.get(current)

    # --- 폴더 시스템 프롬프트 ---

    async def get_folder_system_prompt(self, folder_id: str) -> Optional[str]:
        """폴더의 시스템 프롬프트(folderPrompt)를 반환한다.

        Args:
            folder_id: 폴더 ID.

        Returns:
            folderPrompt 문자열, 설정되지 않았으면 None.

        Raises:
            ValueError: 폴더가 존재하지 않으면.
        """
        folder = await self._db.get_folder(folder_id)
        if folder is None:
            raise ValueError(f"Folder not found: {folder_id}")
        return (folder.get("settings") or {}).get("folderPrompt")

    async def set_folder_system_prompt(
        self, folder_id: str, prompt: Optional[str]
    ) -> None:
        """폴더의 시스템 프롬프트(folderPrompt)를 설정하거나 삭제한다.

        빈 문자열 또는 None을 전달하면 folderPrompt 키를 삭제한다.
        다른 settings 키는 보존된다.

        Args:
            folder_id: 폴더 ID.
            prompt: 설정할 프롬프트. 빈 문자열 또는 None이면 삭제.

        Raises:
            ValueError: 폴더가 존재하지 않으면.
        """
        folder = await self._db.get_folder(folder_id)
        if folder is None:
            raise ValueError(f"Folder not found: {folder_id}")
        settings = dict(folder.get("settings") or {})
        if prompt:
            settings["folderPrompt"] = prompt
        else:
            settings.pop("folderPrompt", None)
        await self.update_folder(folder_id, settings=settings)
