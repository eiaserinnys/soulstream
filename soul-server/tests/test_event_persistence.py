"""EventPersistence 단위 테스트

검증 항목:
1. persist_event: DB가 있을 때 이벤트 영속화 + event_id 반환
2. persist_event: DB가 없을 때 None 반환
3. persist_with_subtree: subtree_update dict 반환
4. persist_with_subtree: DB 없을 때 None 반환
5. handle_side_effects: metadata extraction 호출
6. handle_side_effects: away_summary DB 업데이트
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from soul_server.service.event_persistence import EventPersistence
from soul_server.service.task_models import Task, TaskStatus


def _make_task(session_id="test-session", status=TaskStatus.RUNNING):
    task = MagicMock(spec=Task)
    task.agent_session_id = session_id
    task.status = status
    task.last_event_id = 0
    task.last_read_event_id = 0
    return task


def _make_mock_db():
    db = MagicMock()
    db.append_event = AsyncMock(return_value=42)
    db.update_last_message = AsyncMock()
    db.update_subtree_heights = AsyncMock(return_value=({1: 1}, 1))
    db.update_away_summary = AsyncMock()
    return db


class TestPersistEvent:
    """persist_event() 단위 테스트"""

    async def test_persist_event_returns_event_id_when_db_present(self):
        """DB가 있으면 append_event를 호출하고 event_id를 반환한다"""
        db = _make_mock_db()
        persistence = EventPersistence(session_db=db)

        event = {"type": "text_delta", "text": "hello", "timestamp": "2024-01-01T00:00:00Z"}
        result = await persistence.persist_event("sess-1", event)

        assert result == 42
        db.append_event.assert_called_once()
        call_args = db.append_event.call_args
        assert call_args[0][0] == "sess-1"
        assert call_args[0][1] == "text_delta"

    async def test_persist_event_returns_none_when_db_absent(self):
        """DB가 없으면 None을 반환한다"""
        persistence = EventPersistence(session_db=None)

        event = {"type": "text_delta", "text": "hello"}
        result = await persistence.persist_event("sess-1", event)

        assert result is None

    async def test_persist_event_handles_numeric_timestamp(self):
        """숫자 타임스탬프를 ISO 형식으로 변환한다"""
        db = _make_mock_db()
        persistence = EventPersistence(session_db=db)

        event = {"type": "text_delta", "text": "hello", "timestamp": 1704067200.0}
        await persistence.persist_event("sess-1", event)

        call_args = db.append_event.call_args[0]
        # created_at (5th positional arg) should be ISO format
        assert "2024-01-01" in call_args[4]

    async def test_persist_event_handles_missing_timestamp(self):
        """타임스탬프가 없으면 현재 시각을 사용한다"""
        db = _make_mock_db()
        persistence = EventPersistence(session_db=db)

        event = {"type": "text_delta", "text": "hello"}
        await persistence.persist_event("sess-1", event)

        call_args = db.append_event.call_args[0]
        # created_at should be an ISO formatted string
        assert "T" in call_args[4]


class TestPersistWithSubtree:
    """persist_with_subtree() 단위 테스트"""

    async def test_returns_subtree_update_dict(self):
        """parent_event_id가 있는 이벤트에 대해 subtree_update dict를 반환한다"""
        db = _make_mock_db()
        db.update_subtree_heights = AsyncMock(return_value=({1: 2, 2: 1}, 3))
        persistence = EventPersistence(session_db=db)
        task = _make_task()

        event = {"type": "text_delta", "text": "hi", "parent_event_id": 5}
        result = await persistence.persist_with_subtree("sess-1", event, task)

        assert result is not None
        assert result["type"] == "subtree_update"
        assert result["affected_event_ids"] == [1, 2]
        assert result["new_total_subtree_height"] == 3
        assert result["trigger_event_id"] == 42
        # 영속화 2회: 원본 + subtree_update
        assert db.append_event.call_count == 2

    async def test_returns_none_when_no_parent_event_id(self):
        """parent_event_id가 없으면 subtree 계산을 건너뛴다"""
        db = _make_mock_db()
        persistence = EventPersistence(session_db=db)
        task = _make_task()

        event = {"type": "text_delta", "text": "hi"}
        result = await persistence.persist_with_subtree("sess-1", event, task)

        assert result is None
        db.update_subtree_heights.assert_not_called()

    async def test_returns_none_when_db_absent(self):
        """DB가 없으면 None을 반환한다"""
        persistence = EventPersistence(session_db=None)
        task = _make_task()

        event = {"type": "text_delta", "text": "hi", "parent_event_id": 5}
        result = await persistence.persist_with_subtree("sess-1", event, task)

        assert result is None

    async def test_updates_task_last_event_id(self):
        """영속화 후 task.last_event_id를 갱신한다"""
        db = _make_mock_db()
        persistence = EventPersistence(session_db=db)
        task = _make_task()

        event = {"type": "text_delta", "text": "hi"}
        await persistence.persist_with_subtree("sess-1", event, task)

        assert task.last_event_id == 42

    async def test_subtree_update_failure_returns_none(self):
        """subtree 계산 실패 시 None을 반환하지만 이벤트 영속화는 성공"""
        db = _make_mock_db()
        db.update_subtree_heights = AsyncMock(side_effect=Exception("DB error"))
        persistence = EventPersistence(session_db=db)
        task = _make_task()

        event = {"type": "text_delta", "text": "hi", "parent_event_id": 5}
        result = await persistence.persist_with_subtree("sess-1", event, task)

        assert result is None
        # 원본 이벤트 영속화는 성공
        assert task.last_event_id == 42


class TestHandleSideEffects:
    """handle_side_effects() 단위 테스트"""

    async def test_metadata_extraction_called_for_tool_result(self):
        """tool_result 이벤트에 대해 metadata_extractor.extract()를 호출한다"""
        db = _make_mock_db()
        extractor = MagicMock()
        extractor.extract.return_value = {"key": "value"}
        append_meta = AsyncMock()
        mock_broadcaster = MagicMock()
        mock_broadcaster.emit_session_message_updated = AsyncMock()

        persistence = EventPersistence(
            session_db=db,
            metadata_extractor=extractor,
            append_metadata_func=append_meta,
            get_broadcaster=lambda: mock_broadcaster,
        )
        task = _make_task()

        event = {
            "type": "tool_result",
            "tool_name": "Read",
            "result": "file content",
            "is_error": False,
        }
        await persistence.handle_side_effects("sess-1", "tool_result", event, task)

        extractor.extract.assert_called_once_with(
            tool_name="Read",
            result="file content",
            is_error=False,
        )
        append_meta.assert_called_once_with("sess-1", {"key": "value"})

    async def test_metadata_not_called_for_non_tool_result(self):
        """tool_result 이외 이벤트에서는 metadata_extractor를 호출하지 않는다"""
        extractor = MagicMock()
        append_meta = AsyncMock()
        mock_broadcaster = MagicMock()
        mock_broadcaster.emit_session_message_updated = AsyncMock()

        persistence = EventPersistence(
            session_db=_make_mock_db(),
            metadata_extractor=extractor,
            append_metadata_func=append_meta,
            get_broadcaster=lambda: mock_broadcaster,
        )
        task = _make_task()

        event = {"type": "text_delta", "text": "hello"}
        await persistence.handle_side_effects("sess-1", "text_delta", event, task)

        extractor.extract.assert_not_called()

    async def test_away_summary_updates_db(self):
        """away_summary 이벤트에 대해 DB.update_away_summary()를 호출한다"""
        db = _make_mock_db()
        mock_broadcaster = MagicMock()
        mock_broadcaster.emit_session_message_updated = AsyncMock()

        persistence = EventPersistence(
            session_db=db,
            get_broadcaster=lambda: mock_broadcaster,
        )
        task = _make_task()

        event = {"type": "away_summary", "content": "session summary text"}
        await persistence.handle_side_effects("sess-1", "away_summary", event, task)

        db.update_away_summary.assert_called_once_with("sess-1", "session summary text")

    async def test_away_summary_not_called_without_db(self):
        """DB가 없으면 away_summary를 저장하지 않는다"""
        persistence = EventPersistence(session_db=None)
        task = _make_task()

        event = {"type": "away_summary", "content": "summary"}
        # Should not raise
        await persistence.handle_side_effects("sess-1", "away_summary", event, task)

    async def test_metadata_extraction_failure_does_not_crash(self):
        """metadata extraction 실패 시 예외가 전파되지 않는다"""
        db = _make_mock_db()
        extractor = MagicMock()
        extractor.extract.side_effect = Exception("parse error")
        append_meta = AsyncMock()
        mock_broadcaster = MagicMock()
        mock_broadcaster.emit_session_message_updated = AsyncMock()

        persistence = EventPersistence(
            session_db=db,
            metadata_extractor=extractor,
            append_metadata_func=append_meta,
            get_broadcaster=lambda: mock_broadcaster,
        )
        task = _make_task()

        event = {"type": "tool_result", "tool_name": "Read", "result": "x", "is_error": False}
        # Should not raise
        await persistence.handle_side_effects("sess-1", "tool_result", event, task)
        append_meta.assert_not_called()

    async def test_away_summary_db_failure_does_not_crash(self):
        """away_summary DB 저장 실패 시 예외가 전파되지 않는다"""
        db = _make_mock_db()
        db.update_away_summary = AsyncMock(side_effect=Exception("DB error"))
        mock_broadcaster = MagicMock()
        mock_broadcaster.emit_session_message_updated = AsyncMock()

        persistence = EventPersistence(
            session_db=db,
            get_broadcaster=lambda: mock_broadcaster,
        )
        task = _make_task()

        event = {"type": "away_summary", "content": "summary"}
        # Should not raise
        await persistence.handle_side_effects("sess-1", "away_summary", event, task)


class TestUpdateLastMessage:
    """update_last_message() 단독 단위 테스트

    이벤트 타입별 preview 추출 + DB 저장 + 브로드캐스트 흐름을 검증한다.
    """

    def _make_persistence(self, db=None, broadcaster=None):
        """EventPersistence를 생성하되, broadcaster를 주입 가능하게 한다."""
        if db is None:
            db = _make_mock_db()
        mock_broadcaster = broadcaster or MagicMock()
        if not hasattr(mock_broadcaster, "emit_session_message_updated"):
            mock_broadcaster.emit_session_message_updated = AsyncMock()
        return EventPersistence(
            session_db=db,
            get_broadcaster=lambda: mock_broadcaster,
        ), db, mock_broadcaster

    async def test_text_delta_saves_and_broadcasts(self):
        """text_delta 이벤트: text 필드에서 preview를 추출하여 DB 저장 + 브로드캐스트"""
        persistence, db, broadcaster = self._make_persistence()
        task = _make_task()

        event = {"type": "text_delta", "text": "hello world", "timestamp": "2024-01-01T00:00:00Z"}
        await persistence.update_last_message("sess-1", event, task)

        db.update_last_message.assert_called_once_with(
            "sess-1", {
                "type": "text_delta",
                "preview": "hello world",
                "timestamp": "2024-01-01T00:00:00Z",
            }
        )
        broadcaster.emit_session_message_updated.assert_called_once()
        call_kwargs = broadcaster.emit_session_message_updated.call_args.kwargs
        assert call_kwargs["agent_session_id"] == "sess-1"
        assert call_kwargs["last_message"]["type"] == "text_delta"
        assert call_kwargs["last_message"]["preview"] == "hello world"

    async def test_tool_use_is_ignored(self):
        """tool_use: PREVIEW_FIELD_MAP에 없는 타입이므로 DB 호출 없이 즉시 반환"""
        persistence, db, broadcaster = self._make_persistence()
        task = _make_task()

        event = {"type": "tool_use", "name": "Read", "input": {}}
        await persistence.update_last_message("sess-1", event, task)

        db.update_last_message.assert_not_called()
        broadcaster.emit_session_message_updated.assert_not_called()

    async def test_session_type_is_ignored(self):
        """session: PREVIEW_FIELD_MAP에 없는 타입이므로 DB 호출 없이 즉시 반환"""
        persistence, db, broadcaster = self._make_persistence()
        task = _make_task()

        event = {"type": "session", "session_id": "xxx"}
        await persistence.update_last_message("sess-1", event, task)

        db.update_last_message.assert_not_called()
        broadcaster.emit_session_message_updated.assert_not_called()

    async def test_user_message_extracts_text(self):
        """user_message: text 필드에서 preview를 추출한다"""
        persistence, db, broadcaster = self._make_persistence()
        task = _make_task()

        event = {"type": "user_message", "text": "my prompt"}
        await persistence.update_last_message("sess-1", event, task)

        db.update_last_message.assert_called_once()
        call_args = db.update_last_message.call_args[0]
        assert call_args[1]["type"] == "user_message"
        assert call_args[1]["preview"] == "my prompt"

    async def test_user_message_falls_back_to_messages_array(self):
        """user_message: text가 비어 있으면 messages 배열에서 추출한다"""
        persistence, db, broadcaster = self._make_persistence()
        task = _make_task()

        event = {
            "type": "user_message",
            "text": "",
            "messages": [
                {"role": "user", "content": "fallback text"},
            ],
        }
        await persistence.update_last_message("sess-1", event, task)

        db.update_last_message.assert_called_once()
        call_args = db.update_last_message.call_args[0]
        assert call_args[1]["preview"] == "fallback text"

    async def test_db_none_returns_immediately(self):
        """session_db=None이면 에러 없이 즉시 반환한다"""
        persistence = EventPersistence(session_db=None)
        task = _make_task()

        event = {"type": "text_delta", "text": "hello"}
        # Should not raise
        await persistence.update_last_message("sess-1", event, task)

    async def test_broadcaster_exception_does_not_crash(self):
        """broadcaster가 예외를 던져도 DB는 정상 업데이트된다"""
        db = _make_mock_db()
        broken_broadcaster = MagicMock()
        broken_broadcaster.emit_session_message_updated = AsyncMock(
            side_effect=Exception("broadcaster not ready")
        )
        persistence, _, _ = self._make_persistence(db=db, broadcaster=broken_broadcaster)
        task = _make_task()

        event = {"type": "text_delta", "text": "hello", "timestamp": "2024-01-01T00:00:00Z"}
        await persistence.update_last_message("sess-1", event, task)

        db.update_last_message.assert_called_once()

    async def test_preview_truncated_to_200_chars(self):
        """200자 초과 텍스트는 200자로 절삭된다"""
        persistence, db, broadcaster = self._make_persistence()
        task = _make_task()

        long_text = "a" * 300
        event = {"type": "text_delta", "text": long_text, "timestamp": "2024-01-01T00:00:00Z"}
        await persistence.update_last_message("sess-1", event, task)

        db.update_last_message.assert_called_once()
        call_args = db.update_last_message.call_args[0]
        assert len(call_args[1]["preview"]) == 200
        assert call_args[1]["preview"] == "a" * 200
