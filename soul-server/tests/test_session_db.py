"""SessionDB 단위 테스트"""

import json
import sqlite3
from pathlib import Path

import pytest

from soul_server.service.session_db import SessionDB


@pytest.fixture
def db(tmp_path):
    """인메모리 대신 tmp_path에 DB 생성 (FTS5 트리거 테스트용)"""
    db_path = tmp_path / "test.db"
    sdb = SessionDB(db_path)
    yield sdb
    sdb.close()


# ============================================================
# 세션 CRUD
# ============================================================


class TestSessionCRUD:
    def test_upsert_and_get(self, db):
        db.upsert_session("s1", status="running", session_type="claude", prompt="hello")
        s = db.get_session("s1")
        assert s is not None
        assert s["session_id"] == "s1"
        assert s["status"] == "running"
        assert s["prompt"] == "hello"

    def test_upsert_update_existing(self, db):
        db.upsert_session("s1", status="running", session_type="claude")
        db.upsert_session("s1", status="completed")
        s = db.get_session("s1")
        assert s["status"] == "completed"

    def test_get_nonexistent(self, db):
        assert db.get_session("nope") is None

    def test_get_all_sessions(self, db):
        db.upsert_session("s1", status="running", session_type="claude")
        db.upsert_session("s2", status="completed", session_type="llm")
        sessions, total = db.get_all_sessions()
        assert total == 2
        assert len(sessions) == 2

    def test_get_all_sessions_filter_type(self, db):
        db.upsert_session("s1", session_type="claude")
        db.upsert_session("s2", session_type="llm")
        sessions, total = db.get_all_sessions(session_type="llm")
        assert total == 1
        assert sessions[0]["session_id"] == "s2"

    def test_get_all_sessions_pagination(self, db):
        for i in range(5):
            db.upsert_session(f"s{i}", session_type="claude",
                              updated_at=f"2026-01-01T00:00:0{i}Z")
        sessions, total = db.get_all_sessions(offset=1, limit=2)
        assert total == 5
        assert len(sessions) == 2

    def test_delete_session(self, db):
        db.upsert_session("s1", session_type="claude")
        db.delete_session("s1")
        assert db.get_session("s1") is None

    def test_delete_cascades_events(self, db):
        db.upsert_session("s1", session_type="claude")
        db.append_event("s1", 1, "text_delta", '{"text":"hi"}', "hi", "2026-01-01T00:00:00Z")
        db.delete_session("s1")
        assert db.count_events("s1") == 0

    def test_update_last_message(self, db):
        db.upsert_session("s1", session_type="claude")
        msg = {"type": "user_message", "preview": "hello", "timestamp": "2026-01-01T00:00:00Z"}
        db.update_last_message("s1", msg)
        s = db.get_session("s1")
        assert s["last_message"]["preview"] == "hello"

    def test_mark_running_at_shutdown(self, db):
        db.upsert_session("s1", status="running", session_type="claude")
        db.upsert_session("s2", status="completed", session_type="claude")
        db.mark_running_at_shutdown()
        assert len(db.get_shutdown_sessions()) == 1
        assert db.get_shutdown_sessions()[0]["session_id"] == "s1"

    def test_clear_shutdown_flags(self, db):
        db.upsert_session("s1", status="running", session_type="claude")
        db.mark_running_at_shutdown()
        db.clear_shutdown_flags()
        assert len(db.get_shutdown_sessions()) == 0


# ============================================================
# 이벤트 CRUD
# ============================================================


class TestEventCRUD:
    def test_append_and_read(self, db):
        db.upsert_session("s1", session_type="claude")
        db.append_event("s1", 1, "text_delta", '{"text":"a"}', "a", "2026-01-01T00:00:00Z")
        db.append_event("s1", 2, "text_delta", '{"text":"b"}', "b", "2026-01-01T00:00:01Z")
        events = db.read_events("s1")
        assert len(events) == 2
        assert events[0]["id"] == 1
        assert events[1]["id"] == 2

    def test_read_events_after_id(self, db):
        db.upsert_session("s1", session_type="claude")
        for i in range(1, 6):
            db.append_event("s1", i, "text_delta", f'{{"text":"{i}"}}', str(i), "2026-01-01T00:00:00Z")
        events = db.read_events("s1", after_id=3)
        assert len(events) == 2
        assert events[0]["id"] == 4

    def test_read_one_event(self, db):
        db.upsert_session("s1", session_type="claude")
        db.append_event("s1", 1, "text_delta", '{"text":"x"}', "x", "2026-01-01T00:00:00Z")
        e = db.read_one_event("s1", 1)
        assert e is not None
        assert e["id"] == 1

    def test_read_one_event_not_found(self, db):
        db.upsert_session("s1", session_type="claude")
        assert db.read_one_event("s1", 999) is None

    def test_get_next_event_id(self, db):
        db.upsert_session("s1", session_type="claude")
        assert db.get_next_event_id("s1") == 1
        db.append_event("s1", 1, "text_delta", '{}', "", "2026-01-01T00:00:00Z")
        assert db.get_next_event_id("s1") == 2

    def test_get_next_event_id_cross_session(self, db):
        """다른 세션의 이벤트가 있을 때 새 세션의 ID가 충돌하지 않아야 한다."""
        db.upsert_session("s1", session_type="claude")
        db.upsert_session("s2", session_type="claude")
        # s1에 이벤트 3개 추가 (id 1, 2, 3)
        db.append_event("s1", 1, "text_delta", '{}', "", "2026-01-01T00:00:00Z")
        db.append_event("s1", 2, "text_delta", '{}', "", "2026-01-01T00:00:01Z")
        db.append_event("s1", 3, "text_delta", '{}', "", "2026-01-01T00:00:02Z")
        # s2의 다음 ID는 4여야 한다 (1이 아니라)
        next_id = db.get_next_event_id("s2")
        assert next_id == 4, f"Expected 4, got {next_id} — would collide with s1's events"
        # 실제로 저장이 성공해야 한다
        db.append_event("s2", next_id, "text_delta", '{}', "", "2026-01-01T00:00:03Z")
        assert db.count_events("s2") == 1

    def test_count_events(self, db):
        db.upsert_session("s1", session_type="claude")
        assert db.count_events("s1") == 0
        db.append_event("s1", 1, "text_delta", '{}', "", "2026-01-01T00:00:00Z")
        assert db.count_events("s1") == 1


# ============================================================
# 폴더 CRUD
# ============================================================


class TestFolderCRUD:
    def test_create_and_get(self, db):
        db.create_folder("f1", "테스트 폴더", sort_order=1)
        folders = db.get_all_folders()
        assert len(folders) == 1
        assert folders[0]["name"] == "테스트 폴더"

    def test_update_folder(self, db):
        db.create_folder("f1", "old name")
        db.update_folder("f1", name="new name")
        folders = db.get_all_folders()
        assert folders[0]["name"] == "new name"

    def test_delete_folder_nullifies_sessions(self, db):
        db.create_folder("f1", "test")
        db.upsert_session("s1", session_type="claude", folder_id="f1")
        db.delete_folder("f1")
        s = db.get_session("s1")
        assert s["folder_id"] is None

    def test_get_default_folder(self, db):
        db.create_folder("f1", "클로드 코드 세션")
        f = db.get_default_folder("클로드 코드 세션")
        assert f is not None
        assert f["id"] == "f1"

    def test_get_default_folder_not_found(self, db):
        assert db.get_default_folder("nonexistent") is None

    def test_ensure_default_folders(self, db):
        db.ensure_default_folders()
        folders = db.get_all_folders()
        names = {f["name"] for f in folders}
        assert "클로드 코드 세션" in names
        assert "LLM 세션" in names

    def test_ensure_default_folders_idempotent(self, db):
        db.ensure_default_folders()
        db.ensure_default_folders()
        folders = db.get_all_folders()
        assert len(folders) == 2


# ============================================================
# 카탈로그
# ============================================================


class TestCatalog:
    def test_assign_session_to_folder(self, db):
        db.create_folder("f1", "test")
        db.upsert_session("s1", session_type="claude")
        db.assign_session_to_folder("s1", "f1")
        s = db.get_session("s1")
        assert s["folder_id"] == "f1"

    def test_rename_session(self, db):
        db.upsert_session("s1", session_type="claude")
        db.rename_session("s1", "My Session")
        s = db.get_session("s1")
        assert s["display_name"] == "My Session"

    def test_get_catalog_camelcase(self, db):
        db.create_folder("f1", "test", sort_order=2)
        db.upsert_session("s1", session_type="claude", folder_id="f1", display_name="Session 1")
        catalog = db.get_catalog()
        assert "folders" in catalog
        assert "sessions" in catalog
        assert catalog["folders"][0]["sortOrder"] == 2
        assert catalog["sessions"]["s1"]["folderId"] == "f1"
        assert catalog["sessions"]["s1"]["displayName"] == "Session 1"


# ============================================================
# FTS5 검색
# ============================================================


class TestFTS5Search:
    def test_basic_search(self, db):
        db.upsert_session("s1", session_type="claude")
        db.append_event("s1", 1, "text_delta", '{"text":"hello world"}', "hello world", "2026-01-01T00:00:00Z")
        db.append_event("s1", 2, "text_delta", '{"text":"goodbye"}', "goodbye", "2026-01-01T00:00:01Z")
        results = db.search_events("hello")
        assert len(results) == 1
        assert results[0]["id"] == 1

    def test_search_korean(self, db):
        db.upsert_session("s1", session_type="claude")
        db.append_event("s1", 1, "text_delta", '{}', "안녕하세요 세계", "2026-01-01T00:00:00Z")
        results = db.search_events("안녕하세요")
        assert len(results) == 1

    def test_search_with_session_filter(self, db):
        db.upsert_session("s1", session_type="claude")
        db.upsert_session("s2", session_type="claude")
        db.append_event("s1", 1, "text_delta", '{}', "shared keyword", "2026-01-01T00:00:00Z")
        db.append_event("s2", 2, "text_delta", '{}', "shared keyword", "2026-01-01T00:00:00Z")
        results = db.search_events("shared", session_ids=["s1"])
        assert len(results) == 1
        assert results[0]["session_id"] == "s1"

    def test_search_empty_query(self, db):
        assert db.search_events("") == []
        assert db.search_events("  ") == []

    def test_fts_trigger_on_delete(self, db):
        db.upsert_session("s1", session_type="claude")
        db.append_event("s1", 1, "text_delta", '{}', "findable text", "2026-01-01T00:00:00Z")
        assert len(db.search_events("findable")) == 1
        db.delete_session("s1")
        assert len(db.search_events("findable")) == 0

    def test_search_limit(self, db):
        db.upsert_session("s1", session_type="claude")
        for i in range(10):
            db.append_event("s1", i + 1, "text_delta", '{}', f"repeated word {i}", "2026-01-01T00:00:00Z")
        results = db.search_events("repeated", limit=3)
        assert len(results) == 3


# ============================================================
# searchable_text 추출
# ============================================================


class TestExtractSearchableText:
    def test_text_delta(self):
        assert SessionDB.extract_searchable_text({"type": "text_delta", "text": "hello"}) == "hello"

    def test_thinking(self):
        assert SessionDB.extract_searchable_text({"type": "thinking", "thinking": "hmm"}) == "hmm"

    def test_tool_use_str(self):
        assert SessionDB.extract_searchable_text({"type": "tool_use", "input": "cmd"}) == "cmd"

    def test_tool_use_dict(self):
        result = SessionDB.extract_searchable_text({"type": "tool_use", "input": {"key": "val"}})
        assert "key" in result
        assert "val" in result

    def test_tool_start_dict(self):
        result = SessionDB.extract_searchable_text({
            "type": "tool_start", "tool_input": {"command": "git status"}
        })
        assert "git status" in result

    def test_tool_start_str(self):
        assert SessionDB.extract_searchable_text({
            "type": "tool_start", "tool_input": "ls -la"
        }) == "ls -la"

    def test_tool_result_result_key(self):
        """현재 형식: result 키"""
        assert SessionDB.extract_searchable_text({
            "type": "tool_result", "result": "command output"
        }) == "command output"

    def test_tool_result_content_key(self):
        """레거시 형식: content 키"""
        assert SessionDB.extract_searchable_text({"type": "tool_result", "content": "output"}) == "output"

    def test_tool_result_list(self):
        result = SessionDB.extract_searchable_text({
            "type": "tool_result",
            "content": [{"text": "a"}, {"text": "b"}]
        })
        assert "a" in result
        assert "b" in result

    def test_user_str(self):
        assert SessionDB.extract_searchable_text({"type": "user", "content": "question"}) == "question"

    def test_user_message_text_key(self):
        """현재 형식: user_message 타입, text 키"""
        assert SessionDB.extract_searchable_text({
            "type": "user_message", "text": "안녕하세요"
        }) == "안녕하세요"

    def test_unknown_type(self):
        assert SessionDB.extract_searchable_text({"type": "unknown"}) == ""


# ============================================================
# 마이그레이션
# ============================================================


class TestMigration:
    def _make_catalog(self, tmp_path, entries: dict):
        catalog = {"entries": entries, "last_saved": "2026-01-01T00:00:00Z"}
        (tmp_path / "session_catalog.json").write_text(
            json.dumps(catalog, ensure_ascii=False), encoding="utf-8"
        )

    def _make_jsonl(self, tmp_path, session_id: str, events: list[dict]):
        events_dir = tmp_path / "events"
        events_dir.mkdir(exist_ok=True)
        lines = []
        for e in events:
            lines.append(json.dumps(e, ensure_ascii=False))
        (events_dir / f"{session_id}.jsonl").write_text(
            "\n".join(lines) + "\n", encoding="utf-8"
        )

    def test_no_legacy_files(self, tmp_path):
        db_path = tmp_path / "test.db"
        assert SessionDB.migrate_from_legacy(db_path, tmp_path) is False

    def test_normal_migration(self, tmp_path):
        self._make_catalog(tmp_path, {
            "s1": {
                "status": "completed",
                "session_type": "claude",
                "created_at": "2026-01-01T00:00:00Z",
                "prompt": "test",
            }
        })
        self._make_jsonl(tmp_path, "s1", [
            {"id": 1, "event": {"type": "text_delta", "text": "hello"}},
            {"id": 2, "event": {"type": "text_delta", "text": "world"}},
        ])

        db_path = tmp_path / "test.db"
        assert SessionDB.migrate_from_legacy(db_path, tmp_path) is True

        # 원본 삭제 확인
        assert not (tmp_path / "session_catalog.json").exists()
        assert not (tmp_path / "events").exists()

        # DB 확인
        sdb = SessionDB(db_path)
        s = sdb.get_session("s1")
        assert s is not None
        assert s["status"] == "completed"
        assert sdb.count_events("s1") == 2

        # FTS 검색 확인
        results = sdb.search_events("hello")
        assert len(results) == 1

        # 기본 폴더 확인
        folders = sdb.get_all_folders()
        assert len(folders) == 2

        # 폴더 자동 배치 확인
        assert s["folder_id"] is not None
        sdb.close()

    def test_orphan_jsonl_migration(self, tmp_path):
        """카탈로그에 없지만 JSONL은 있는 고아 세션"""
        self._make_catalog(tmp_path, {})
        self._make_jsonl(tmp_path, "orphan1", [
            {"id": 1, "event": {"type": "text_delta", "text": "orphan"}},
        ])

        db_path = tmp_path / "test.db"
        SessionDB.migrate_from_legacy(db_path, tmp_path)

        sdb = SessionDB(db_path)
        s = sdb.get_session("orphan1")
        assert s is not None
        assert s["status"] == "interrupted"
        assert sdb.count_events("orphan1") == 1
        sdb.close()

    def test_catalog_only_migration(self, tmp_path):
        """카탈로그에는 있지만 JSONL이 없는 세션"""
        self._make_catalog(tmp_path, {
            "s1": {
                "status": "completed",
                "session_type": "claude",
                "created_at": "2026-01-01T00:00:00Z",
            }
        })

        db_path = tmp_path / "test.db"
        SessionDB.migrate_from_legacy(db_path, tmp_path)

        sdb = SessionDB(db_path)
        s = sdb.get_session("s1")
        assert s is not None
        assert sdb.count_events("s1") == 0
        sdb.close()

    def test_llm_session_type_detection(self, tmp_path):
        """llm- 프리픽스로 세션 타입 자동 판별"""
        self._make_catalog(tmp_path, {})
        self._make_jsonl(tmp_path, "llm-test123", [
            {"id": 1, "event": {"type": "text_delta", "text": "llm"}},
        ])

        db_path = tmp_path / "test.db"
        SessionDB.migrate_from_legacy(db_path, tmp_path)

        sdb = SessionDB(db_path)
        s = sdb.get_session("llm-test123")
        assert s["session_type"] == "llm"
        sdb.close()

    def test_pre_shutdown_flag(self, tmp_path):
        """pre_shutdown_sessions.json의 세션에 플래그 설정"""
        self._make_catalog(tmp_path, {
            "s1": {"status": "running", "session_type": "claude", "created_at": "2026-01-01T00:00:00Z"},
            "s2": {"status": "running", "session_type": "claude", "created_at": "2026-01-01T00:00:00Z"},
        })
        (tmp_path / "pre_shutdown_sessions.json").write_text(
            json.dumps(["s1"]), encoding="utf-8"
        )

        db_path = tmp_path / "test.db"
        SessionDB.migrate_from_legacy(db_path, tmp_path)

        sdb = SessionDB(db_path)
        shutdown = sdb.get_shutdown_sessions()
        sids = {s["session_id"] for s in shutdown}
        assert "s1" in sids
        sdb.close()

    def test_migration_failure_preserves_originals(self, tmp_path, monkeypatch):
        """마이그레이션 실패 시 원본 유지 + DB 정리"""
        self._make_catalog(tmp_path, {
            "s1": {"status": "running", "session_type": "claude", "created_at": "2026-01-01T00:00:00Z"},
        })
        self._make_jsonl(tmp_path, "s1", [
            {"id": 1, "event": {"type": "text_delta", "text": "hi"}},
        ])

        db_path = tmp_path / "test.db"

        # extract_searchable_text를 패치하여 이벤트 처리 중 예외 유발
        def exploding_extract(event):
            raise RuntimeError("forced migration failure")
        monkeypatch.setattr(SessionDB, "extract_searchable_text", staticmethod(exploding_extract))

        result = SessionDB.migrate_from_legacy(db_path, tmp_path)
        assert result is False
        assert (tmp_path / "session_catalog.json").exists()
        assert (tmp_path / "events").exists()

    def test_corrupted_jsonl_skipped(self, tmp_path):
        """깨진 JSONL 줄은 건너뛰고 마이그레이션 성공"""
        self._make_catalog(tmp_path, {
            "s1": {"status": "running", "session_type": "claude", "created_at": "2026-01-01T00:00:00Z"},
        })
        events_dir = tmp_path / "events"
        events_dir.mkdir()
        (events_dir / "s1.jsonl").write_text(
            'not json\n{"id": 1, "event": {"type": "text_delta", "text": "ok"}}\n',
            encoding="utf-8",
        )

        db_path = tmp_path / "test.db"
        assert SessionDB.migrate_from_legacy(db_path, tmp_path) is True
        sdb = SessionDB(db_path)
        assert sdb.count_events("s1") == 1
        sdb.close()


# ============================================================
# WAL 모드
# ============================================================


# ============================================================
# 화이트리스트 검증
# ============================================================


class TestColumnWhitelist:
    def test_invalid_session_column_rejected(self, db):
        with pytest.raises(ValueError, match="Invalid session columns"):
            db.upsert_session("s1", **{"status = 'hacked' --": "x"})

    def test_invalid_folder_column_rejected(self, db):
        db.create_folder("f1", "test")
        with pytest.raises(ValueError, match="Invalid folder columns"):
            db.update_folder("f1", **{"name = 'hacked' --": "x"})

    def test_valid_session_columns_accepted(self, db):
        db.upsert_session("s1", status="running", session_type="claude", prompt="ok")
        assert db.get_session("s1")["status"] == "running"


# ============================================================
# metadata JSON 직렬화
# ============================================================


class TestMetadataSerialization:
    def test_metadata_round_trip(self, db):
        db.upsert_session("s1", session_type="claude",
                          metadata=json.dumps({"key": "value"}))
        s = db.get_session("s1")
        assert s["metadata"] == {"key": "value"}

    def test_metadata_in_get_all(self, db):
        db.upsert_session("s1", session_type="claude",
                          metadata=json.dumps({"a": 1}))
        sessions, _ = db.get_all_sessions()
        assert sessions[0]["metadata"] == {"a": 1}


# ============================================================
# offset-only 페이지네이션
# ============================================================


class TestOffsetOnly:
    def test_offset_without_limit(self, db):
        for i in range(5):
            db.upsert_session(f"s{i}", session_type="claude",
                              updated_at=f"2026-01-01T00:00:0{i}Z")
        sessions, total = db.get_all_sessions(offset=2)
        assert total == 5
        assert len(sessions) == 3


# ============================================================
# FTS5 특수문자
# ============================================================


class TestFTS5SpecialChars:
    def test_query_with_quotes(self, db):
        db.upsert_session("s1", session_type="claude")
        db.append_event("s1", 1, "text_delta", '{}', "hello world", "2026-01-01T00:00:00Z")
        results = db.search_events('"hello"')
        assert len(results) == 1

    def test_query_only_quotes(self, db):
        results = db.search_events('"""')
        assert results == []


class TestWALMode:
    def test_wal_enabled(self, db):
        mode = db._conn.execute("PRAGMA journal_mode").fetchone()[0]
        assert mode == "wal"
