"""Dashboard user domain and access cache."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Iterable

from soulstream_server.config import Settings
from soulstream_server.dashboard_access import DashboardAccess, normalize_email


_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_UNSET = object()

USER_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,
    display_name TEXT,
    is_admin BOOLEAN NOT NULL DEFAULT FALSE,
    allowed_folder_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_is_admin ON users (is_admin);
"""


def validate_user_email(value: str) -> str:
    email = normalize_email(value)
    if not email or not _EMAIL_RE.match(email):
        raise ValueError("Invalid email")
    return email


def normalize_folder_ids(values: Iterable[Any] | None) -> tuple[str, ...]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values or ():
        folder_id = str(value).strip()
        if not folder_id or folder_id in seen:
            continue
        seen.add(folder_id)
        result.append(folder_id)
    return tuple(result)


@dataclass(frozen=True)
class DashboardUser:
    email: str
    display_name: str | None
    is_admin: bool
    allowed_folder_ids: tuple[str, ...]
    created_at: datetime
    created_by: str | None

    @classmethod
    def from_row(cls, row: Any) -> "DashboardUser":
        get = row.get if hasattr(row, "get") else row.__getitem__
        return cls(
            email=validate_user_email(get("email")),
            display_name=get("display_name"),
            is_admin=bool(get("is_admin")),
            allowed_folder_ids=normalize_folder_ids(get("allowed_folder_ids") or ()),
            created_at=get("created_at") or datetime.now(timezone.utc),
            created_by=get("created_by"),
        )

    def to_api(self) -> dict[str, Any]:
        return {
            "email": self.email,
            "displayName": self.display_name,
            "isAdmin": self.is_admin,
            "allowedFolderIds": list(self.allowed_folder_ids),
            "createdAt": self.created_at.isoformat(),
            "createdBy": self.created_by,
        }


class DashboardUserCache:
    """Synchronous user/access snapshot used by request-time policy checks."""

    def __init__(self, users: Iterable[DashboardUser] = ()) -> None:
        self.replace(users)

    def replace(self, users: Iterable[DashboardUser]) -> None:
        self._users = {user.email: user for user in users}

    def list_users(self) -> list[DashboardUser]:
        return sorted(self._users.values(), key=lambda user: user.email)

    def has_users(self) -> bool:
        return bool(self._users)

    def get(self, email: str | None) -> DashboardUser | None:
        return self._users.get(normalize_email(email))

    def admin_count(self, *, excluding_email: str | None = None) -> int:
        excluded = normalize_email(excluding_email)
        return sum(
            1
            for user in self._users.values()
            if user.is_admin and user.email != excluded
        )

    def is_admin_email(self, email: str | None) -> bool:
        user = self.get(email)
        return bool(user and user.is_admin)

    def access_for_email(self, email: str | None) -> DashboardAccess:
        user = self.get(email)
        if user is None:
            return DashboardAccess(restricted=True)
        if user.is_admin or not user.allowed_folder_ids:
            return DashboardAccess(restricted=False)
        return DashboardAccess(
            restricted=True,
            allowed_folder_ids=user.allowed_folder_ids,
        )

    def user_payload_extra(self, email: str | None) -> dict[str, Any]:
        user = self.get(email)
        access = self.access_for_email(email)
        return {
            "isAdmin": bool(user and user.is_admin),
            "dashboardAccess": access.to_payload(),
        }

    def oauth_error_for_email(self, email: str | None) -> str | None:
        if not self.has_users():
            return "no_admin_initialized"
        user = self.get(email)
        if user is None:
            return "no_user"
        return None


def users_from_legacy_settings(settings: Settings) -> list[DashboardUser]:
    """Build seed users from deprecated env settings.

    Used by the explicit init command and test-mode in-memory service only.
    Production request-time policy with a real repository ignores these values
    after the users table exists.
    """

    now = datetime.now(timezone.utc)
    users: dict[str, DashboardUser] = {}
    if settings.allowed_email:
        email = validate_user_email(settings.allowed_email)
        users[email] = DashboardUser(
            email=email,
            display_name=None,
            is_admin=True,
            allowed_folder_ids=(),
            created_at=now,
            created_by="init_admin",
        )

    for raw_email, rule in settings.dashboard_user_folder_access.items():
        email = validate_user_email(raw_email)
        existing = users.get(email)
        users[email] = DashboardUser(
            email=email,
            display_name=existing.display_name if existing else None,
            is_admin=bool(existing and existing.is_admin),
            allowed_folder_ids=normalize_folder_ids(rule.get("allowedFolderIds") or ()),
            created_at=existing.created_at if existing else now,
            created_by=existing.created_by if existing else "init_admin",
        )

    return sorted(users.values(), key=lambda user: user.email)


class DashboardUserService:
    def __init__(self, repository) -> None:
        self._repository = repository
        self.cache = DashboardUserCache()

    @classmethod
    def memory_from_settings(cls, settings: Settings) -> "DashboardUserService":
        repository = InMemoryDashboardUserRepository(users_from_legacy_settings(settings))
        service = cls(repository)
        service.cache.replace(repository._users.values())
        return service

    @classmethod
    def postgres(cls, pool) -> "DashboardUserService":
        return cls(PostgresDashboardUserRepository(pool))

    async def initialize(self) -> None:
        await self._repository.ensure_schema()
        await self.refresh()

    async def refresh(self) -> None:
        self.cache.replace(await self._repository.list_users())

    def access_for_email(self, email: str | None) -> DashboardAccess:
        return self.cache.access_for_email(email)

    def is_admin_email(self, email: str | None) -> bool:
        return self.cache.is_admin_email(email)

    def user_payload_extra(self, email: str | None) -> dict[str, Any]:
        return self.cache.user_payload_extra(email)

    def oauth_error_for_email(self, email: str | None) -> str | None:
        return self.cache.oauth_error_for_email(email)

    async def list_users(self) -> list[DashboardUser]:
        await self.refresh()
        return self.cache.list_users()

    async def get_user(self, email: str) -> DashboardUser | None:
        return await self._repository.get_user(email)

    async def create_user(
        self,
        *,
        email: str,
        display_name: str | None,
        is_admin: bool,
        allowed_folder_ids: Iterable[Any] | None,
        created_by: str | None,
    ) -> DashboardUser:
        user = await self._repository.create_user(
            email=validate_user_email(email),
            display_name=_clean_display_name(display_name),
            is_admin=is_admin,
            allowed_folder_ids=normalize_folder_ids(allowed_folder_ids),
            created_by=created_by,
        )
        await self.refresh()
        return user

    async def upsert_user(
        self,
        *,
        email: str,
        display_name: str | None,
        is_admin: bool,
        allowed_folder_ids: Iterable[Any] | None,
        created_by: str | None,
    ) -> DashboardUser:
        user = await self._repository.upsert_user(
            email=validate_user_email(email),
            display_name=_clean_display_name(display_name),
            is_admin=is_admin,
            allowed_folder_ids=normalize_folder_ids(allowed_folder_ids),
            created_by=created_by,
        )
        await self.refresh()
        return user

    async def update_user(
        self,
        email: str,
        *,
        display_name: object = _UNSET,
        is_admin: object = _UNSET,
        allowed_folder_ids: object = _UNSET,
    ) -> DashboardUser:
        if display_name is not _UNSET:
            display_name = _clean_display_name(display_name)  # type: ignore[arg-type]
        if allowed_folder_ids is not _UNSET:
            allowed_folder_ids = normalize_folder_ids(allowed_folder_ids)  # type: ignore[arg-type]
        user = await self._repository.update_user(
            validate_user_email(email),
            display_name=display_name,
            is_admin=is_admin,
            allowed_folder_ids=allowed_folder_ids,
        )
        await self.refresh()
        return user

    async def delete_user(self, email: str) -> None:
        await self._repository.delete_user(validate_user_email(email))
        await self.refresh()

    async def can_remove_admin(self, email: str) -> bool:
        return await self._repository.count_admins(excluding_email=email) >= 1


async def seed_users_from_settings(
    service: DashboardUserService,
    settings: Settings,
) -> list[DashboardUser]:
    seeded: list[DashboardUser] = []
    for user in users_from_legacy_settings(settings):
        seeded.append(await service.upsert_user(
            email=user.email,
            display_name=user.display_name,
            is_admin=user.is_admin,
            allowed_folder_ids=user.allowed_folder_ids,
            created_by=user.created_by,
        ))
    return seeded


def _clean_display_name(value: str | None) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


from soulstream_server.user_repositories import (  # noqa: E402
    InMemoryDashboardUserRepository,
    PostgresDashboardUserRepository,
)


__all__ = [
    "DashboardUser",
    "DashboardUserCache",
    "DashboardUserService",
    "InMemoryDashboardUserRepository",
    "PostgresDashboardUserRepository",
    "USER_SCHEMA_SQL",
    "normalize_folder_ids",
    "seed_users_from_settings",
    "users_from_legacy_settings",
    "validate_user_email",
]
