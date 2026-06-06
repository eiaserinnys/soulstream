"""Dashboard folder access policy.

The policy is resolved per request from the authenticated dashboard user's
Gmail address. Unmapped users keep the existing unrestricted dashboard.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException, Request

from soul_common.auth.caller_info import decode_dashboard_jwt_user
from soulstream_server.config import Settings, get_settings


@dataclass(frozen=True)
class DashboardAccess:
    restricted: bool
    allowed_folder_ids: tuple[str, ...] = ()

    def to_payload(self) -> dict[str, Any]:
        return {
            "restricted": self.restricted,
            "allowedFolderIds": list(self.allowed_folder_ids),
        }


def normalize_email(value: str | None) -> str:
    return (value or "").strip().lower()


def extra_login_allowed_emails(settings: Settings) -> set[str]:
    return {
        email
        for email, rule in settings.dashboard_user_folder_access.items()
        if rule.get("restricted", True)
    }


def access_for_email(email: str | None, settings: Settings | None = None) -> DashboardAccess:
    settings = settings or get_settings()
    rule = settings.dashboard_user_folder_access.get(normalize_email(email))
    if not rule or not rule.get("restricted", True):
        return DashboardAccess(restricted=False)
    return DashboardAccess(
        restricted=True,
        allowed_folder_ids=tuple(rule.get("allowedFolderIds") or ()),
    )


def access_for_request(request: Request, settings: Settings | None = None) -> DashboardAccess:
    settings = settings or get_settings()
    auth_user = getattr(request.state, "auth_user", None)
    if not isinstance(auth_user, dict):
        auth_user = decode_dashboard_jwt_user(request, settings.jwt_secret or "")
    email = auth_user.get("email") if isinstance(auth_user, dict) else None
    return access_for_email(email, settings)


def visible_folder_ids(access: DashboardAccess, folders: list[dict]) -> set[str] | None:
    if not access.restricted:
        return None

    by_parent: dict[str | None, list[str]] = {}
    known_ids: set[str] = set()
    for folder in folders:
        folder_id = folder.get("id")
        if not isinstance(folder_id, str):
            continue
        known_ids.add(folder_id)
        parent_id = folder.get("parentFolderId")
        if parent_id is not None and not isinstance(parent_id, str):
            parent_id = None
        by_parent.setdefault(parent_id, []).append(folder_id)

    visible: set[str] = set()
    stack = [folder_id for folder_id in access.allowed_folder_ids if folder_id in known_ids]
    while stack:
        folder_id = stack.pop()
        if folder_id in visible:
            continue
        visible.add(folder_id)
        stack.extend(by_parent.get(folder_id, []))
    return visible


def filter_folders(access: DashboardAccess, folders: list[dict]) -> list[dict]:
    ids = visible_folder_ids(access, folders)
    if ids is None:
        return folders
    return [folder for folder in folders if folder.get("id") in ids]


def filter_session_assignments(
    access: DashboardAccess,
    folders: list[dict],
    assignments: dict[str, dict],
) -> dict[str, dict]:
    ids = visible_folder_ids(access, folders)
    if ids is None:
        return assignments
    return {
        session_id: assignment
        for session_id, assignment in assignments.items()
        if assignment.get("folderId") in ids
    }


def is_folder_allowed(
    access: DashboardAccess,
    folders: list[dict],
    folder_id: str | None,
) -> bool:
    if not access.restricted:
        return True
    if folder_id is None:
        return False
    ids = visible_folder_ids(access, folders) or set()
    return folder_id in ids


def first_allowed_folder_id(access: DashboardAccess, folders: list[dict]) -> str | None:
    if not access.restricted:
        return None
    ids = visible_folder_ids(access, folders) or set()
    for folder_id in access.allowed_folder_ids:
        if folder_id in ids:
            return folder_id
    for folder in folders:
        folder_id = folder.get("id")
        if isinstance(folder_id, str) and folder_id in ids:
            return folder_id
    return None


def require_folder_allowed(
    access: DashboardAccess,
    folders: list[dict],
    folder_id: str | None,
) -> None:
    if not is_folder_allowed(access, folders, folder_id):
        raise HTTPException(status_code=403, detail="Folder access denied")


async def require_session_allowed(request: Request, db, session_id: str) -> None:
    access = access_for_request(request)
    if not access.restricted:
        return
    session = await db.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    folder_id = session.get("folder_id") or session.get("folderId")
    folders = await _folders_from_db(db)
    require_folder_allowed(access, folders, folder_id)


async def _folders_from_db(db) -> list[dict]:
    rows = await db.get_all_folders()
    folders: list[dict] = []
    for row in rows:
        folders.append({
            "id": row.get("id"),
            "name": row.get("name"),
            "sortOrder": row.get("sort_order", row.get("sortOrder", 0)),
            "parentFolderId": row.get("parent_folder_id", row.get("parentFolderId")),
            "settings": row.get("settings") or {},
        })
    return folders
