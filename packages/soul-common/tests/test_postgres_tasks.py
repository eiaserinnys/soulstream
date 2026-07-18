from __future__ import annotations

import pytest

from soul_common.db.postgres.tasks import PostgresTaskMixin


class _FakePool:
    def __init__(self) -> None:
        self.queries: list[str] = []

    async def fetch(self, query: str, *args):
        self.queries.append(query)
        if len(self.queries) == 1:
            return []
        if len(self.queries) == 2:
            return [
                {
                    "task_id": "rb-1",
                    "task_title": "Launch",
                    "task_version": "7",
                    "task_status": "completed",
                    "board_item_id": "task:rb-1",
                    "folder_id": "folder-1",
                    "completed_count": "3",
                    "total_count": "5",
                },
            ]
        return []


class _TaskProjection(PostgresTaskMixin):
    def __init__(self) -> None:
        self._pool = _FakePool()


@pytest.mark.asyncio
async def test_task_overview_groups_include_task_version_for_cas():
    projection = _TaskProjection()

    overview = await projection.get_task_overview(user_id=None, limit=100)

    assert "i.status = 'review'" in projection._pool.queries[0]
    assert "i.status = 'review'" in projection._pool.queries[1]
    assert "r.version AS task_version" in projection._pool.queries[1]
    assert overview["tasks"] == [
        {
            "task_id": "rb-1",
            "task_title": "Launch",
            "task_version": 7,
            "task_status": "completed",
            "board_item_id": "task:rb-1",
            "folder_id": "folder-1",
            "completed_count": 3,
            "total_count": 5,
            "items": [],
        },
    ]
