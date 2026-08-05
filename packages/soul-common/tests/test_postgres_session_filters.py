"""PostgreSQL session list filter serialization contracts."""

import json
from unittest.mock import AsyncMock

import pytest

from soul_common.db.postgres.session_crud import PostgresSessionCRUDMixin


@pytest.mark.asyncio
async def test_review_state_filter_is_forwarded_to_count_and_list_queries():
    db = PostgresSessionCRUDMixin()
    db._pool = AsyncMock()
    db._pool.fetchval.return_value = 0
    db._pool.fetch.return_value = []

    sessions, total = await db.get_all_sessions(
        review_state="needs_review",
        limit=0,
    )

    expected_filters = json.dumps({"review_state": "needs_review"})
    db._pool.fetchval.assert_awaited_once_with(
        "SELECT session_count($1::jsonb)",
        expected_filters,
    )
    db._pool.fetch.assert_awaited_once_with(
        "SELECT * FROM session_get_all($1::jsonb, $2, $3)",
        expected_filters,
        None,
        None,
    )
    assert sessions == []
    assert total == 0
