"""push_tokens 테이블에 대한 asyncpg 기반 CRUD.

DB pool은 PostgresSessionDB.pool public property를 의존성 주입으로 받아 공유한다
(design-principles §3: 정본은 하나).
"""

import asyncpg


class PushRepository:
    """user_email + device_id 조합으로 push 토큰을 보관·조회·정리한다."""

    def __init__(self, pool: asyncpg.Pool):
        self._pool = pool

    async def upsert_token(
        self, user_email: str, device_id: str, expo_token: str
    ) -> None:
        """등록·갱신 멱등 호출. PK 충돌 시 expo_token + updated_at만 갱신."""
        async with self._pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO push_tokens (user_email, device_id, expo_token, updated_at)
                VALUES ($1, $2, $3, NOW())
                ON CONFLICT (user_email, device_id)
                DO UPDATE SET expo_token = EXCLUDED.expo_token, updated_at = NOW()
                """,
                user_email,
                device_id,
                expo_token,
            )

    async def list_tokens(self, user_email: str) -> list[tuple[str, str]]:
        """[(device_id, expo_token), ...] 반환."""
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT device_id, expo_token FROM push_tokens WHERE user_email = $1",
                user_email,
            )
            return [(r["device_id"], r["expo_token"]) for r in rows]

    async def delete_token(self, user_email: str, device_id: str) -> None:
        """register/deregister API 또는 DeviceNotRegistered cleanup 시 호출."""
        async with self._pool.acquire() as conn:
            await conn.execute(
                "DELETE FROM push_tokens WHERE user_email = $1 AND device_id = $2",
                user_email,
                device_id,
            )
