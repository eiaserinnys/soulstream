"""PostgreSQL fixtures for canonical schema procedure tests."""

from __future__ import annotations

import asyncio
import os
import random
import string
import subprocess
import time
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from urllib.parse import urlparse

import pytest
import pytest_asyncio


TEST_DB_NAME = "soulstream_schema_test"
TEST_USER = "soulstream_schema_test"
TEST_PASSWORD = "soulstream_schema_secret"
FORBIDDEN_DATABASE_TOKENS = (
    "atom_db",
    "reverie",
    "soulstream_db",
    "soul_dashboard_db",
    "serendipity",
)


def ensure_test_db_url(url: str) -> None:
    """Reject URLs that may point at production data."""

    parsed = urlparse(url)
    database_name = parsed.path.lstrip("/").lower()
    full_target = f"{parsed.hostname or ''}/{database_name}".lower()

    if "test" not in database_name:
        raise RuntimeError(
            "TEST_DATABASE_URL must point to a test database "
            f"(name containing 'test'). Got: {url}"
        )

    for token in FORBIDDEN_DATABASE_TOKENS:
        if token in full_target:
            raise RuntimeError(
                f"TEST_DATABASE_URL must not reference protected database '{token}'. "
                f"Got: {url}"
            )


async def ensure_external_database_empty(url: str) -> None:
    """Refuse to run against a non-empty externally supplied test database."""

    import asyncpg

    conn = await asyncpg.connect(url)
    try:
        row_count = await conn.fetchval(
            """
            SELECT COALESCE(SUM(n_live_tup), 0)::bigint
            FROM pg_stat_user_tables
            """
        )
        table_count = await conn.fetchval(
            """
            SELECT COUNT(*)::int
            FROM information_schema.tables
            WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
            """
        )
    finally:
        await conn.close()

    if table_count and row_count:
        raise RuntimeError("TEST_DATABASE_URL must point at an empty test database")


@pytest.fixture(scope="session")
def test_database_url() -> Iterator[str]:
    """Use TEST_DATABASE_URL or start an isolated Docker PostgreSQL instance."""

    external_url = os.environ.get("TEST_DATABASE_URL", "").strip()
    if external_url:
        ensure_test_db_url(external_url)
        asyncio.run(ensure_external_database_empty(external_url))
        yield external_url
        return

    container_id = subprocess.check_output(
        [
            "docker",
            "run",
            "--rm",
            "-d",
            "-e",
            f"POSTGRES_USER={TEST_USER}",
            "-e",
            f"POSTGRES_PASSWORD={TEST_PASSWORD}",
            "-e",
            f"POSTGRES_DB={TEST_DB_NAME}",
            "-p",
            "127.0.0.1::5432",
            "postgres:16-alpine",
        ],
        text=True,
    ).strip()

    try:
        port = _docker_mapped_port(container_id)
        yield f"postgresql://{TEST_USER}:{TEST_PASSWORD}@127.0.0.1:{port}/{TEST_DB_NAME}"
    finally:
        subprocess.run(
            ["docker", "stop", container_id],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )


@pytest_asyncio.fixture
async def test_db(test_database_url: str) -> AsyncIterator[object]:
    """Apply schema.sql in an isolated schema and return an asyncpg pool."""

    import asyncpg

    schema_name = _random_schema_name()
    conn = await _connect_with_retry(test_database_url)
    try:
        await conn.execute(f'CREATE SCHEMA "{schema_name}"')
    finally:
        await conn.close()

    pool = await asyncpg.create_pool(
        test_database_url,
        min_size=1,
        max_size=1,
        server_settings={"search_path": schema_name},
    )
    schema_path = Path(__file__).resolve().parents[1] / "sql" / "schema.sql"

    try:
        await pool.execute(schema_path.read_text(encoding="utf-8"))
        yield pool
    finally:
        await pool.execute(f'DROP SCHEMA IF EXISTS "{schema_name}" CASCADE')
        await pool.close()


def _random_schema_name() -> str:
    suffix = "".join(random.choices(string.ascii_lowercase + string.digits, k=10))
    return f"test_schema_{int(time.time() * 1000)}_{suffix}"


def _docker_mapped_port(container_id: str) -> str:
    deadline = time.time() + 30
    while time.time() < deadline:
        output = subprocess.check_output(
            ["docker", "port", container_id, "5432/tcp"],
            text=True,
        ).strip()
        if ":" in output:
            return output.rsplit(":", 1)[1]
        time.sleep(0.2)
    raise RuntimeError("docker did not publish a PostgreSQL port")


async def _connect_with_retry(url: str):
    import asyncpg

    deadline = time.monotonic() + 30
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            return await asyncpg.connect(url)
        except Exception as exc:  # pragma: no cover - diagnostic path
            last_error = exc
            await asyncio.sleep(0.5)
    if last_error:
        raise last_error
    raise RuntimeError("PostgreSQL did not become ready")
