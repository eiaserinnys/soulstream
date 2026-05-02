"""orch-server `/api/sessions/{id}/events/viewport`, `/{id}/messages` DB 직접 조회 테스트.

orch-server와 soul-server가 같은 PostgreSQL을 공유하므로
messages/viewport는 노드 통신 없이 DB 직접 SELECT.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

pytestmark = pytest.mark.asyncio


class TestViewportDirectDB:
    """`GET /api/sessions/{id}/events/viewport` — DB 직접 조회."""

    async def test_returns_db_result(self, client, mock_db):
        """db.read_viewport 결과를 그대로 반환."""
        viewport_data = [
            {"id": 1, "parent_event_id": None, "event_type": "user_message",
             "depth": 0, "y_start": 1, "y_end": 5, "payload": {}},
        ]
        mock_db.read_viewport = AsyncMock(return_value=viewport_data)

        resp = await client.get("/api/sessions/sess-1/events/viewport?y_min=1&y_max=50")

        assert resp.status_code == 200
        assert resp.json() == viewport_data
        mock_db.read_viewport.assert_called_once_with("sess-1", 1, 50)

    async def test_empty_result(self, client, mock_db):
        """세션에 이벤트가 없으면 빈 배열."""
        mock_db.read_viewport = AsyncMock(return_value=[])

        resp = await client.get("/api/sessions/sess-1/events/viewport?y_min=1&y_max=100")

        assert resp.status_code == 200
        assert resp.json() == []


class TestMessagesDirectDB:
    """`GET /api/sessions/{id}/messages` — DB 직접 조회."""

    async def test_returns_db_result(self, client, mock_db):
        """db.read_messages 결과를 messages/next_cursor로 반환."""
        messages = [
            {"id": 10, "parent_event_id": 5, "event_type": "tool_start",
             "payload": {}, "created_at": "2026-05-02T12:00:00+00:00"},
        ]
        mock_db.read_messages = AsyncMock(return_value=(messages, "2026-05-02T11:00:00+00:00"))

        resp = await client.get("/api/sessions/sess-1/messages?limit=50")

        assert resp.status_code == 200
        data = resp.json()
        assert data["messages"] == messages
        assert data["next_cursor"] == "2026-05-02T11:00:00+00:00"
        mock_db.read_messages.assert_called_once_with("sess-1", before=None, limit=50)

    async def test_passes_before_cursor(self, client, mock_db):
        """before 파라미터가 db.read_messages에 전달."""
        mock_db.read_messages = AsyncMock(return_value=([], None))

        await client.get("/api/sessions/sess-1/messages?limit=25&before=2026-05-02T10:00:00Z")

        mock_db.read_messages.assert_called_once_with(
            "sess-1", before="2026-05-02T10:00:00Z", limit=25,
        )

    async def test_empty_session(self, client, mock_db):
        """이벤트가 없는 세션 → 빈 messages, null cursor."""
        mock_db.read_messages = AsyncMock(return_value=([], None))

        resp = await client.get("/api/sessions/sess-1/messages?limit=50")

        assert resp.status_code == 200
        assert resp.json() == {"messages": [], "next_cursor": None}

    async def test_default_limit(self, client, mock_db):
        """limit 미지정 시 기본값 50."""
        mock_db.read_messages = AsyncMock(return_value=([], None))

        await client.get("/api/sessions/sess-1/messages")

        mock_db.read_messages.assert_called_once_with("sess-1", before=None, limit=50)
