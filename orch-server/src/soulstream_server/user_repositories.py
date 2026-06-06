"""Dashboard user repository implementations."""

from __future__ import annotations

from datetime import datetime, timezone

from soulstream_server.dashboard_access import normalize_email
from soulstream_server.users import (
    USER_SCHEMA_SQL,
    DashboardUser,
    _UNSET,
    normalize_folder_ids,
    validate_user_email,
)


class InMemoryDashboardUserRepository:
    def __init__(self, users=()) -> None:
        self._users = {user.email: user for user in users}

    async def ensure_schema(self) -> None:
        return None

    async def list_users(self) -> list[DashboardUser]:
        return sorted(self._users.values(), key=lambda user: user.email)

    async def get_user(self, email: str) -> DashboardUser | None:
        return self._users.get(validate_user_email(email))

    async def count_users(self) -> int:
        return len(self._users)

    async def count_admins(self, *, excluding_email: str | None = None) -> int:
        excluded = normalize_email(excluding_email)
        return sum(
            1 for user in self._users.values()
            if user.is_admin and user.email != excluded
        )

    async def create_user(
        self,
        *,
        email: str,
        display_name: str | None,
        is_admin: bool,
        allowed_folder_ids: tuple[str, ...],
        created_by: str | None,
    ) -> DashboardUser:
        email = validate_user_email(email)
        if email in self._users:
            raise ValueError("User already exists")
        user = DashboardUser(
            email=email,
            display_name=display_name,
            is_admin=is_admin,
            allowed_folder_ids=allowed_folder_ids,
            created_at=datetime.now(timezone.utc),
            created_by=created_by,
        )
        self._users[email] = user
        return user

    async def upsert_user(
        self,
        *,
        email: str,
        display_name: str | None,
        is_admin: bool,
        allowed_folder_ids: tuple[str, ...],
        created_by: str | None,
    ) -> DashboardUser:
        email = validate_user_email(email)
        existing = self._users.get(email)
        user = DashboardUser(
            email=email,
            display_name=display_name,
            is_admin=is_admin,
            allowed_folder_ids=allowed_folder_ids,
            created_at=existing.created_at if existing else datetime.now(timezone.utc),
            created_by=existing.created_by if existing else created_by,
        )
        self._users[email] = user
        return user

    async def update_user(
        self,
        email: str,
        *,
        display_name: object = _UNSET,
        is_admin: object = _UNSET,
        allowed_folder_ids: object = _UNSET,
    ) -> DashboardUser:
        email = validate_user_email(email)
        existing = self._users.get(email)
        if existing is None:
            raise KeyError(email)
        user = DashboardUser(
            email=email,
            display_name=existing.display_name if display_name is _UNSET else display_name,  # type: ignore[arg-type]
            is_admin=existing.is_admin if is_admin is _UNSET else bool(is_admin),
            allowed_folder_ids=existing.allowed_folder_ids if allowed_folder_ids is _UNSET else allowed_folder_ids,  # type: ignore[arg-type]
            created_at=existing.created_at,
            created_by=existing.created_by,
        )
        self._users[email] = user
        return user

    async def delete_user(self, email: str) -> None:
        email = validate_user_email(email)
        if email not in self._users:
            raise KeyError(email)
        del self._users[email]


class PostgresDashboardUserRepository:
    def __init__(self, pool) -> None:
        self._pool = pool

    async def ensure_schema(self) -> None:
        await self._pool.execute(USER_SCHEMA_SQL)

    async def list_users(self) -> list[DashboardUser]:
        rows = await self._pool.fetch(
            """
            SELECT email, display_name, is_admin, allowed_folder_ids, created_at, created_by
            FROM users
            ORDER BY email
            """
        )
        return [DashboardUser.from_row(row) for row in rows]

    async def get_user(self, email: str) -> DashboardUser | None:
        row = await self._pool.fetchrow(
            """
            SELECT email, display_name, is_admin, allowed_folder_ids, created_at, created_by
            FROM users
            WHERE email = $1
            """,
            validate_user_email(email),
        )
        return DashboardUser.from_row(row) if row else None

    async def count_users(self) -> int:
        return int(await self._pool.fetchval("SELECT COUNT(*) FROM users"))

    async def count_admins(self, *, excluding_email: str | None = None) -> int:
        excluded = normalize_email(excluding_email)
        if excluded:
            return int(await self._pool.fetchval(
                "SELECT COUNT(*) FROM users WHERE is_admin = TRUE AND email <> $1",
                excluded,
            ))
        return int(await self._pool.fetchval(
            "SELECT COUNT(*) FROM users WHERE is_admin = TRUE"
        ))

    async def create_user(
        self,
        *,
        email: str,
        display_name: str | None,
        is_admin: bool,
        allowed_folder_ids: tuple[str, ...],
        created_by: str | None,
    ) -> DashboardUser:
        try:
            row = await self._pool.fetchrow(
                """
                INSERT INTO users (email, display_name, is_admin, allowed_folder_ids, created_by)
                VALUES ($1, $2, $3, $4::TEXT[], $5)
                RETURNING email, display_name, is_admin, allowed_folder_ids, created_at, created_by
                """,
                validate_user_email(email),
                display_name,
                is_admin,
                list(allowed_folder_ids),
                normalize_email(created_by) or None,
            )
        except Exception as exc:
            if exc.__class__.__name__ == "UniqueViolationError":
                raise ValueError("User already exists") from exc
            raise
        return DashboardUser.from_row(row)

    async def upsert_user(
        self,
        *,
        email: str,
        display_name: str | None,
        is_admin: bool,
        allowed_folder_ids: tuple[str, ...],
        created_by: str | None,
    ) -> DashboardUser:
        row = await self._pool.fetchrow(
            """
            INSERT INTO users (email, display_name, is_admin, allowed_folder_ids, created_by)
            VALUES ($1, $2, $3, $4::TEXT[], $5)
            ON CONFLICT (email) DO UPDATE SET
                display_name = EXCLUDED.display_name,
                is_admin = EXCLUDED.is_admin,
                allowed_folder_ids = EXCLUDED.allowed_folder_ids
            RETURNING email, display_name, is_admin, allowed_folder_ids, created_at, created_by
            """,
            validate_user_email(email),
            display_name,
            is_admin,
            list(allowed_folder_ids),
            normalize_email(created_by) or None,
        )
        return DashboardUser.from_row(row)

    async def update_user(
        self,
        email: str,
        *,
        display_name: object = _UNSET,
        is_admin: object = _UNSET,
        allowed_folder_ids: object = _UNSET,
    ) -> DashboardUser:
        existing = await self.get_user(email)
        if existing is None:
            raise KeyError(email)
        next_display_name = existing.display_name if display_name is _UNSET else display_name
        next_is_admin = existing.is_admin if is_admin is _UNSET else bool(is_admin)
        next_allowed_folder_ids = (
            existing.allowed_folder_ids
            if allowed_folder_ids is _UNSET
            else normalize_folder_ids(allowed_folder_ids)  # type: ignore[arg-type]
        )
        row = await self._pool.fetchrow(
            """
            UPDATE users
            SET display_name = $2,
                is_admin = $3,
                allowed_folder_ids = $4::TEXT[]
            WHERE email = $1
            RETURNING email, display_name, is_admin, allowed_folder_ids, created_at, created_by
            """,
            existing.email,
            next_display_name,
            next_is_admin,
            list(next_allowed_folder_ids),
        )
        return DashboardUser.from_row(row)

    async def delete_user(self, email: str) -> None:
        result = await self._pool.execute(
            "DELETE FROM users WHERE email = $1",
            validate_user_email(email),
        )
        if result.endswith(" 0"):
            raise KeyError(email)
