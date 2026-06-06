"""Seed dashboard users from deprecated env settings.

Usage:
    python -m soulstream_server.init_admin
"""

from __future__ import annotations

import asyncio
import logging

import asyncpg

from soulstream_server.config import get_settings
from soulstream_server.users import DashboardUserService, seed_users_from_settings

logger = logging.getLogger(__name__)


async def run() -> int:
    settings = get_settings()
    pool = await asyncpg.create_pool(settings.database_url, min_size=1, max_size=2)
    try:
        service = DashboardUserService.postgres(pool)
        await service.initialize()
        seeded = await seed_users_from_settings(service, settings)
        if settings.allowed_email:
            logger.warning("ALLOWED_EMAIL is deprecated; users table is now the dashboard auth source")
        if settings.dashboard_user_folder_access:
            logger.warning("DASHBOARD_USER_FOLDER_ACCESS is deprecated; users table is now the folder access source")
        for user in seeded:
            logger.info(
                "seeded dashboard user email=%s admin=%s allowedFolderIds=%d",
                user.email,
                user.is_admin,
                len(user.allowed_folder_ids),
            )
        return len(seeded)
    finally:
        await pool.close()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s:%(name)s:%(message)s")
    count = asyncio.run(run())
    print(f"Seeded {count} dashboard user(s)")


if __name__ == "__main__":
    main()
