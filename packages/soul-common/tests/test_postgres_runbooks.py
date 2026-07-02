from __future__ import annotations

import pytest

from soul_common.db.postgres.runbooks import PostgresRunbookMixin


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
                    "runbook_id": "rb-1",
                    "runbook_title": "Launch",
                    "runbook_version": "7",
                    "runbook_status": "completed",
                    "board_item_id": "runbook:rb-1",
                    "folder_id": "folder-1",
                    "completed_count": "3",
                    "total_count": "5",
                },
            ]
        return []


class _RunbookProjection(PostgresRunbookMixin):
    def __init__(self) -> None:
        self._pool = _FakePool()


@pytest.mark.asyncio
async def test_runbook_overview_groups_include_runbook_version_for_cas():
    projection = _RunbookProjection()

    overview = await projection.get_runbook_overview(user_id=None, limit=100)

    assert "r.version AS runbook_version" in projection._pool.queries[1]
    assert overview["runbooks"] == [
        {
            "runbook_id": "rb-1",
            "runbook_title": "Launch",
            "runbook_version": 7,
            "runbook_status": "completed",
            "board_item_id": "runbook:rb-1",
            "folder_id": "folder-1",
            "completed_count": 3,
            "total_count": 5,
            "items": [],
        },
    ]
