"""DB 프로시저 통합 테스트

실제 PostgreSQL에 연결하여 schema.sql의 모든 프로시저를 검증한다.
TEST_DATABASE_URL 환경변수가 없으면 전체 skip.
"""

import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest


pytestmark = pytest.mark.asyncio


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _decode_jsonb(value):
    return json.loads(value) if isinstance(value, str) else value


# === Helper ===

async def _create_folder(db, folder_id="test-folder", name="Test Folder", sort_order=0):
    await db.execute(
        "SELECT folder_create($1, $2, $3)", folder_id, name, sort_order
    )


async def _create_session(db, session_id="test-session", **overrides):
    now = _utc_now()
    columns = ["status", "node_id"]
    values = ["idle", "test-node"]
    for k, v in overrides.items():
        columns.append(k)
        values.append(str(v) if not isinstance(v, str) else v)
    await db.execute(
        "SELECT session_upsert($1, $2, $3, $4, $5)",
        session_id, columns, values, now, now,
    )


# === 세션 CRUD ===

async def test_session_upsert_and_get(test_db):
    now = _utc_now()
    await test_db.execute(
        "SELECT session_upsert($1, $2, $3, $4, $5)",
        "s1", ["status", "node_id", "session_type"], ["running", "node-a", "claude"], now, now,
    )

    row = await test_db.fetchrow("SELECT * FROM session_get($1)", "s1")
    assert row is not None
    assert row["session_id"] == "s1"
    assert row["status"] == "running"
    assert row["node_id"] == "node-a"
    assert row["session_type"] == "claude"


async def test_session_upsert_updates_existing(test_db):
    now = _utc_now()
    await test_db.execute(
        "SELECT session_upsert($1, $2, $3, $4, $5)",
        "s-up", ["status"], ["idle"], now, now,
    )
    await test_db.execute(
        "SELECT session_upsert($1, $2, $3, $4, $5)",
        "s-up", ["status"], ["running"], now, now,
    )
    row = await test_db.fetchrow("SELECT * FROM session_get($1)", "s-up")
    assert row["status"] == "running"


async def test_session_upsert_invalid_column(test_db):
    now = _utc_now()
    with pytest.raises(Exception, match="Invalid session column"):
        await test_db.execute(
            "SELECT session_upsert($1, $2, $3, $4, $5)",
            "s-bad", ["bogus_col"], ["val"], now, now,
        )


async def test_session_upsert_jsonb_columns(test_db):
    now = _utc_now()
    meta = json.dumps([{"type": "test", "value": "hello"}])
    msg = json.dumps({"text": "hi"})
    await test_db.execute(
        "SELECT session_upsert($1, $2, $3, $4, $5)",
        "s-json", ["metadata", "last_message", "status"], [meta, msg, "idle"], now, now,
    )
    row = await test_db.fetchrow("SELECT * FROM session_get($1)", "s-json")
    assert _decode_jsonb(row["metadata"]) == [{"type": "test", "value": "hello"}]
    assert _decode_jsonb(row["last_message"]) == {"text": "hi"}


async def test_session_get_all_and_count(test_db):
    now = _utc_now()
    for i in range(3):
        await test_db.execute(
            "SELECT session_upsert($1, $2, $3, $4, $5)",
            f"sa-{i}", ["session_type", "status"], ["claude", "idle"], now, now,
        )
    await test_db.execute(
        "SELECT session_upsert($1, $2, $3, $4, $5)",
        "sa-other", ["session_type", "status"], ["llm", "idle"], now, now,
    )

    # 전체 조회
    rows = await test_db.fetch("SELECT * FROM session_get_all(NULL)")
    assert len(rows) >= 4

    # 필터 조회
    filters = json.dumps({"session_type": "claude"})
    rows = await test_db.fetch("SELECT * FROM session_get_all($1::jsonb)", filters)
    claude_ids = [r["session_id"] for r in rows]
    assert all(sid.startswith("sa-") and sid != "sa-other" for sid in claude_ids if sid.startswith("sa-"))

    # count
    count = await test_db.fetchval("SELECT session_count($1::jsonb)", filters)
    assert count >= 3

    # limit/offset
    rows = await test_db.fetch("SELECT * FROM session_get_all(NULL, 2, 0)")
    assert len(rows) == 2


async def test_session_delete(test_db):
    await _create_session(test_db, "s-del")
    await test_db.execute("SELECT session_delete($1)", "s-del")
    row = await test_db.fetchrow("SELECT * FROM session_get($1)", "s-del")
    assert row is None


async def test_claude_transcript_append_load_preserves_content_shapes(test_db):
    now = _utc_now()
    entries = [
        {
            "type": "user",
            "uuid": "u-scalar-content",
            "message": {"role": "user", "content": "plain text"},
        },
        {
            "type": "assistant",
            "uuid": "a-array-content",
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "hello"}],
            },
        },
        {
            "type": "system",
            "uuid": "s-object-content",
            "content": {"level": "info"},
        },
        {"type": "summary", "uuid": "missing-content"},
    ]

    written = await test_db.fetchval(
        "SELECT claude_transcript_append($1, $2, $3, $4::jsonb, $5)",
        "project-a",
        "claude-shapes",
        None,
        json.dumps(entries),
        now,
    )

    rows = await test_db.fetch(
        "SELECT entry FROM claude_transcript_load($1, $2, $3)",
        "project-a",
        "claude-shapes",
        None,
    )
    assert written == len(entries)
    assert [_decode_jsonb(row["entry"]) for row in rows] == entries


async def test_claude_transcript_append_normalizes_single_object_and_scalar_batches(test_db):
    now = _utc_now()
    entry = {
        "type": "user",
        "uuid": "u-single-object",
        "message": {"role": "user", "content": "scalar content"},
    }

    object_written = await test_db.fetchval(
        "SELECT claude_transcript_append($1, $2, $3, $4::jsonb, $5)",
        "project-a",
        "claude-single",
        None,
        json.dumps(entry),
        now,
    )
    scalar_written = await test_db.fetchval(
        "SELECT claude_transcript_append($1, $2, $3, $4::jsonb, $5)",
        "project-a",
        "claude-scalar",
        None,
        json.dumps("stray scalar"),
        now,
    )

    rows = await test_db.fetch(
        "SELECT entry FROM claude_transcript_load($1, $2, $3)",
        "project-a",
        "claude-single",
        None,
    )
    assert object_written == 1
    assert [_decode_jsonb(row["entry"]) for row in rows] == [entry]
    assert scalar_written == 0


# === 세션 메타데이터 & 메시지 ===

async def test_session_append_metadata(test_db):
    await _create_session(test_db, "s-meta")
    now = _utc_now()

    meta_json = json.dumps([{"type": "test", "value": "v1"}])
    event_payload = json.dumps({"type": "metadata", "metadata_type": "test"})

    event_id = await test_db.fetchval(
        "SELECT session_append_metadata($1, $2, $3, $4, $5, $6)",
        "s-meta", meta_json, "metadata", event_payload, "test: v1", now,
    )
    assert event_id == 1

    # metadata가 append됐는지
    row = await test_db.fetchrow("SELECT * FROM session_get($1)", "s-meta")
    assert row["metadata"] is not None
    assert len(_decode_jsonb(row["metadata"])) == 1

    # last_event_id 갱신됐는지
    assert row["last_event_id"] == 1


async def test_session_append_metadata_not_found(test_db):
    now = _utc_now()
    with pytest.raises(Exception, match="Session not found"):
        await test_db.fetchval(
            "SELECT session_append_metadata($1, $2, $3, $4, $5, $6)",
            "nonexistent", "[]", "metadata", "{}", "", now,
        )


async def test_session_update_last_message(test_db):
    await _create_session(test_db, "s-msg")
    now = _utc_now()
    msg = json.dumps({"text": "hello"})
    await test_db.execute(
        "SELECT session_update_last_message($1, $2, $3)", "s-msg", msg, now
    )
    row = await test_db.fetchrow("SELECT * FROM session_get($1)", "s-msg")
    assert _decode_jsonb(row["last_message"]) == {"text": "hello"}


# === 읽음 상태 ===

async def test_session_read_position(test_db):
    await _create_session(test_db, "s-read")

    result = await test_db.fetchval(
        "SELECT session_update_read_position($1, $2)", "s-read", 5
    )
    assert result == "UPDATE 1"

    row = await test_db.fetchrow(
        "SELECT * FROM session_get_read_position($1)", "s-read"
    )
    assert row["last_read_event_id"] == 5


async def test_session_update_read_position_not_found(test_db):
    result = await test_db.fetchval(
        "SELECT session_update_read_position($1, $2)", "nonexistent", 5
    )
    assert result == "UPDATE 0"


# === 세션 이름 & 폴더 ===

async def test_session_rename(test_db):
    await _create_session(test_db, "s-rename")
    await test_db.execute("SELECT session_rename($1, $2)", "s-rename", "New Name")
    row = await test_db.fetchrow("SELECT * FROM session_get($1)", "s-rename")
    assert row["display_name"] == "New Name"


async def test_session_assign_folder(test_db):
    await _create_folder(test_db, "f-assign", "Assign Folder")
    await _create_session(test_db, "s-assign")
    await test_db.execute("SELECT session_assign_folder($1, $2)", "s-assign", "f-assign")
    row = await test_db.fetchrow("SELECT * FROM session_get($1)", "s-assign")
    assert row["folder_id"] == "f-assign"


# === Graceful Shutdown ===

async def test_shutdown_mark_running_all(test_db):
    now = _utc_now()
    await test_db.execute(
        "SELECT session_upsert($1, $2, $3, $4, $5)",
        "sh-1", ["status"], ["running"], now, now,
    )
    await test_db.execute(
        "SELECT session_upsert($1, $2, $3, $4, $5)",
        "sh-2", ["status"], ["idle"], now, now,
    )

    await test_db.execute("SELECT shutdown_mark_running(NULL)")

    rows = await test_db.fetch("SELECT * FROM shutdown_get_sessions()")
    session_ids = [r["session_id"] for r in rows]
    assert "sh-1" in session_ids
    assert "sh-2" not in session_ids


async def test_shutdown_mark_running_by_ids(test_db):
    now = _utc_now()
    await test_db.execute(
        "SELECT session_upsert($1, $2, $3, $4, $5)",
        "sh-3", ["status"], ["idle"], now, now,
    )
    await test_db.execute("SELECT shutdown_mark_running($1)", ["sh-3"])
    rows = await test_db.fetch("SELECT * FROM shutdown_get_sessions()")
    assert any(r["session_id"] == "sh-3" for r in rows)


async def test_shutdown_mark_running_empty_array(test_db):
    # 빈 배열은 no-op
    await test_db.execute("SELECT shutdown_mark_running($1::text[])", [])


async def test_shutdown_clear_flags(test_db):
    now = _utc_now()
    await test_db.execute(
        "SELECT session_upsert($1, $2, $3, $4, $5)",
        "sh-clear", ["status", "was_running_at_shutdown"], ["running", "true"], now, now,
    )
    await test_db.execute("SELECT shutdown_clear_flags()")
    row = await test_db.fetchrow("SELECT * FROM session_get($1)", "sh-clear")
    assert row["was_running_at_shutdown"] is False


async def test_shutdown_repair_read_positions(test_db):
    now = _utc_now()
    await test_db.execute(
        "SELECT session_upsert($1, $2, $3, $4, $5)",
        "sh-repair",
        ["status", "last_event_id", "last_read_event_id"],
        ["idle", "10", "5"],
        now, now,
    )
    count = await test_db.fetchval("SELECT shutdown_repair_read_positions()")
    assert count >= 1

    row = await test_db.fetchrow("SELECT * FROM session_get($1)", "sh-repair")
    assert row["last_read_event_id"] == row["last_event_id"]


# === 이벤트 CRUD ===

async def test_event_append_and_read(test_db):
    await _create_session(test_db, "ev-1")
    now = _utc_now()

    eid = await test_db.fetchval(
        "SELECT event_append($1, $2, $3, $4, $5)",
        "ev-1", "text_delta", '{"text":"hello"}', "hello", now,
    )
    assert eid == 1

    eid2 = await test_db.fetchval(
        "SELECT event_append($1, $2, $3, $4, $5)",
        "ev-1", "text_delta", '{"text":"world"}', "world", now,
    )
    assert eid2 == 2

    # read all
    rows = await test_db.fetch("SELECT * FROM event_read($1)", "ev-1")
    assert len(rows) == 2

    # read after id 1
    rows = await test_db.fetch("SELECT * FROM event_read($1, $2)", "ev-1", 1)
    assert len(rows) == 1
    assert rows[0]["id"] == 2


async def test_event_read_one(test_db):
    await _create_session(test_db, "ev-one")
    now = _utc_now()
    eid = await test_db.fetchval(
        "SELECT event_append($1, $2, $3, $4, $5)",
        "ev-one", "test", '{"n":1}', "test 1", now,
    )
    row = await test_db.fetchrow("SELECT * FROM event_read_one($1, $2)", "ev-one", eid)
    assert row is not None
    assert row["event_type"] == "test"


async def test_event_stream_raw(test_db):
    await _create_session(test_db, "ev-raw")
    now = _utc_now()
    await test_db.fetchval(
        "SELECT event_append($1, $2, $3, $4, $5)",
        "ev-raw", "test", '{"k":"v"}', "test", now,
    )
    rows = await test_db.fetch("SELECT * FROM event_stream_raw($1)", "ev-raw")
    assert len(rows) == 1
    # payload_text는 JSON 문자열
    assert '"k"' in rows[0]["payload_text"]


async def test_event_count(test_db):
    await _create_session(test_db, "ev-cnt")
    now = _utc_now()
    for i in range(3):
        await test_db.fetchval(
            "SELECT event_append($1, $2, $3, $4, $5)",
            "ev-cnt", "test", f'{{"n":{i}}}', f"test {i}", now,
        )
    count = await test_db.fetchval("SELECT event_count($1)", "ev-cnt")
    assert count == 3


async def test_supervisor_event_append_idempotent_and_contiguous_cursor(test_db):
    now = _utc_now()

    first = await test_db.fetchrow(
        "SELECT * FROM supervisor_event_append($1, $2, $3, $4, $5, $6)",
        "node-a", "sess-a", 1, "text_delta", '{"text":"one"}', now,
    )
    assert first["offset"] > 0
    assert first["inserted"] is True
    assert first["contiguous_upto"] == 1
    assert first["highest_seen_event_id"] == 1
    assert first["gap_start"] is None
    assert first["gap_end"] is None

    third = await test_db.fetchrow(
        "SELECT * FROM supervisor_event_append($1, $2, $3, $4, $5, $6)",
        "node-a", "sess-a", 3, "tool_result", '{"text":"three"}', now,
    )
    assert third["offset"] > first["offset"]
    assert third["inserted"] is True
    assert third["contiguous_upto"] == 1
    assert third["highest_seen_event_id"] == 3
    assert third["gap_start"] == 2
    assert third["gap_end"] == 2

    duplicate = await test_db.fetchrow(
        "SELECT * FROM supervisor_event_append($1, $2, $3, $4, $5, $6)",
        "node-a", "sess-a", 3, "tool_result", '{"text":"duplicate"}', now,
    )
    assert duplicate["offset"] == third["offset"]
    assert duplicate["inserted"] is False
    assert await test_db.fetchval("SELECT COUNT(*) FROM supervisor_events") == 2

    second = await test_db.fetchrow(
        "SELECT * FROM supervisor_event_append($1, $2, $3, $4, $5, $6)",
        "node-a", "sess-a", 2, "text_delta", '{"text":"two"}', now,
    )
    assert second["offset"] > third["offset"]
    assert second["inserted"] is True
    assert second["contiguous_upto"] == 3
    assert second["highest_seen_event_id"] == 3
    assert second["gap_start"] is None
    assert second["gap_end"] is None

    cursor = await test_db.fetchrow(
        "SELECT * FROM supervisor_source_cursor_get($1, $2)",
        "node-a", "sess-a",
    )
    assert cursor["contiguous_upto"] == 3
    assert cursor["highest_seen_event_id"] == 3
    assert cursor["gap_start"] is None
    assert cursor["gap_end"] is None

    rows = await test_db.fetch("SELECT * FROM supervisor_event_read_after($1, $2)", 0, 10)
    assert [row["offset"] for row in rows] == [
        first["offset"],
        third["offset"],
        second["offset"],
    ]
    assert [row["source_event_id"] for row in rows] == [1, 3, 2]


async def test_supervisor_consumer_cursor_registry_and_schema_reapply(test_db):
    now = _utc_now()

    await test_db.fetchrow(
        "SELECT * FROM supervisor_event_append($1, $2, $3, $4, $5, $6)",
        "node-restart", "sess-restart", 1, "session_created", '{"ok":true}', now,
    )
    await test_db.execute(
        "SELECT supervisor_consumer_cursor_set($1, $2)",
        "cluster-supervisor", 1,
    )
    assert await test_db.fetchval(
        "SELECT supervisor_consumer_cursor_get($1)",
        "cluster-supervisor",
    ) == 1

    registry = await test_db.fetchrow(
        "SELECT * FROM supervisor_registry_upsert($1, $2, $3, $4, $5, $6, $7, $8)",
        "cluster",
        "sess-supervisor",
        7,
        1,
        "idle_pending",
        1200,
        1,
        now,
    )
    assert registry["role"] == "cluster"
    assert registry["active_session_id"] == "sess-supervisor"
    assert registry["epoch"] == 7
    assert registry["cursor_offset"] == 1
    assert registry["handover_state"] == "idle_pending"
    assert registry["cumulative_tokens"] == 1200
    assert registry["compaction_count"] == 1
    assert registry["last_seen_at"] == now

    usage = await test_db.fetchrow(
        "SELECT * FROM supervisor_registry_record_usage_delta($1, $2, $3, $4)",
        "cluster",
        300,
        2,
        now,
    )
    assert usage["cumulative_tokens"] == 1500
    assert usage["compaction_count"] == 3

    touched = await test_db.fetchrow(
        "SELECT * FROM supervisor_registry_touch($1, $2)",
        "cluster",
        now,
    )
    assert touched["role"] == "cluster"
    assert touched["last_seen_at"] == now

    schema_path = (
        Path(__file__).resolve().parents[1]
        / "sql"
        / "schema.sql"
    )
    await test_db.execute(schema_path.read_text(encoding="utf-8"))

    recovered = await test_db.fetch("SELECT * FROM supervisor_event_read_after($1, $2)", 0, 10)
    assert len(recovered) == 1
    assert recovered[0]["source_node"] == "node-restart"
    assert await test_db.fetchval(
        "SELECT supervisor_consumer_cursor_get($1)",
        "cluster-supervisor",
    ) == 1
    assert await test_db.fetchrow("SELECT * FROM supervisor_registry_get($1)", "cluster")

    assert await test_db.fetchval("SELECT supervisor_registry_delete($1)", "cluster") is True
    assert await test_db.fetchrow("SELECT * FROM supervisor_registry_get($1)", "cluster") is None


async def test_event_append_parent_event_id_integer(test_db):
    """payload.parent_event_id가 정수 문자열이면 컬럼에 INTEGER로 저장된다."""
    await _create_session(test_db, "ev-pe-int")
    now = _utc_now()

    eid1 = await test_db.fetchval(
        "SELECT event_append($1, $2, $3, $4, $5)",
        "ev-pe-int", "text_delta", '{"text":"first"}', "first", now,
    )
    eid2 = await test_db.fetchval(
        "SELECT event_append($1, $2, $3, $4, $5)",
        "ev-pe-int", "text_delta",
        json.dumps({"text": "second", "parent_event_id": str(eid1)}),
        "second", now,
    )

    row = await test_db.fetchrow("SELECT * FROM event_read_one($1, $2)", "ev-pe-int", eid2)
    assert row["parent_event_id"] == eid1


async def test_event_append_parent_event_id_uuid_does_not_crash(test_db):
    """payload.parent_event_id가 UUID여도 INSERT가 성공하고 컬럼은 NULL로 남는다.

    레거시 이벤트(tool_use_id, subagent UUID)가 같은 키에 들어 있는 사례가 5,252건 존재.
    의미가 다른 키이므로 컬럼은 NULL로 두되, INSERT 자체가 실패해서는 안 된다.
    """
    await _create_session(test_db, "ev-pe-uuid")
    now = _utc_now()

    eid = await test_db.fetchval(
        "SELECT event_append($1, $2, $3, $4, $5)",
        "ev-pe-uuid", "subagent_start",
        json.dumps({"parent_event_id": "f5848770-5933-4f4c-8f08-107d790bfe4b"}),
        "sub", now,
    )
    row = await test_db.fetchrow("SELECT * FROM event_read_one($1, $2)", "ev-pe-uuid", eid)
    assert row["parent_event_id"] is None


async def test_event_append_parent_event_id_tool_use_id_does_not_crash(test_db):
    """payload.parent_event_id가 'toolu_...' tool_use_id여도 NULL로 떨어진다."""
    await _create_session(test_db, "ev-pe-tool")
    now = _utc_now()

    eid = await test_db.fetchval(
        "SELECT event_append($1, $2, $3, $4, $5)",
        "ev-pe-tool", "tool_start",
        json.dumps({"parent_event_id": "toolu_01Y3nys4t9Dqk6tznWFuFTam"}),
        "tool", now,
    )
    row = await test_db.fetchrow("SELECT * FROM event_read_one($1, $2)", "ev-pe-tool", eid)
    assert row["parent_event_id"] is None


async def test_event_append_parent_event_id_absent(test_db):
    """payload에 parent_event_id가 없으면 컬럼 NULL."""
    await _create_session(test_db, "ev-pe-none")
    now = _utc_now()

    eid = await test_db.fetchval(
        "SELECT event_append($1, $2, $3, $4, $5)",
        "ev-pe-none", "text_delta", '{"text":"x"}', "x", now,
    )
    row = await test_db.fetchrow("SELECT * FROM event_read_one($1, $2)", "ev-pe-none", eid)
    assert row["parent_event_id"] is None


async def test_event_append_parent_event_id_int_overflow(test_db):
    """payload.parent_event_id가 INT 범위 초과 정수여도 NULL로 떨어진다.

    프로덕션에서 발견된 input_request_responded 이벤트의 12자리 값(407885725189) 케이스.
    timestamp 같은 잘못된 값이 들어왔을 때 NumericValueOutOfRangeError로 INSERT가 실패하면
    안 된다.
    """
    await _create_session(test_db, "ev-pe-overflow")
    now = _utc_now()

    eid = await test_db.fetchval(
        "SELECT event_append($1, $2, $3, $4, $5)",
        "ev-pe-overflow", "input_request_responded",
        json.dumps({"parent_event_id": "407885725189"}),
        "x", now,
    )
    row = await test_db.fetchrow("SELECT * FROM event_read_one($1, $2)", "ev-pe-overflow", eid)
    assert row["parent_event_id"] is None


async def test_event_append_parent_event_id_int_max_boundary(test_db):
    """INT MAX라도 부모 행이 없으면 NULL, MAX+1(2147483648)도 NULL."""
    await _create_session(test_db, "ev-pe-boundary")
    now = _utc_now()

    eid_max = await test_db.fetchval(
        "SELECT event_append($1, $2, $3, $4, $5)",
        "ev-pe-boundary", "test",
        json.dumps({"parent_event_id": "2147483647"}),
        "x", now,
    )
    row = await test_db.fetchrow(
        "SELECT * FROM event_read_one($1, $2)", "ev-pe-boundary", eid_max
    )
    assert row["parent_event_id"] is None

    eid_over = await test_db.fetchval(
        "SELECT event_append($1, $2, $3, $4, $5)",
        "ev-pe-boundary", "test",
        json.dumps({"parent_event_id": "2147483648"}),
        "x", now,
    )
    row = await test_db.fetchrow(
        "SELECT * FROM event_read_one($1, $2)", "ev-pe-boundary", eid_over
    )
    assert row["parent_event_id"] is None


async def test_event_append_parent_event_id_empty_string(test_db):
    """payload.parent_event_id가 빈 문자열이어도 NULL로 떨어진다.

    과거 backfill 스크립트가 NULLIF(..., '') 패턴을 썼던 흔적으로, 빈 문자열 형태가
    잠재적으로 들어올 수 있어 회귀 표면.
    """
    await _create_session(test_db, "ev-pe-empty")
    now = _utc_now()

    eid = await test_db.fetchval(
        "SELECT event_append($1, $2, $3, $4, $5)",
        "ev-pe-empty", "text_delta",
        json.dumps({"parent_event_id": ""}),
        "x", now,
    )
    row = await test_db.fetchrow("SELECT * FROM event_read_one($1, $2)", "ev-pe-empty", eid)
    assert row["parent_event_id"] is None


async def test_parent_event_id_backfill_mixed_legacy(test_db):
    """schema.sql 끝의 백필 UPDATE가 혼합 레거시 데이터에서 깨지지 않고 정수만 채운다.

    이번 사고의 직접 원인이 백필 SQL이었으므로, 정수/UUID/tool_use_id/빈문자열/이미채워짐
    이 섞인 상태에서 백필을 재실행해도 에러 없이 정수 행만 컬럼이 채워지는 것을 검증한다.
    """
    await _create_session(test_db, "ev-bf-mix")
    now = _utc_now()

    # 직접 INSERT로 레거시 상태 재현 (event_append를 우회 — 컬럼 NULL인 행을 만들기 위해)
    # id=42, 43은 parent로 참조될 행. id=10이 42를 가리키도록 미리 만든다.
    await test_db.execute(
        """
        INSERT INTO events (id, session_id, event_type, payload, searchable_text,
                            created_at, parent_event_id)
        VALUES
            (42, 'ev-bf-mix', 'parent42', '{}'::jsonb, '', $1, NULL),
            (43, 'ev-bf-mix', 'parent43', '{}'::jsonb, '', $1, NULL),
            (10, 'ev-bf-mix', 'legacy_int', '{"parent_event_id":"42"}'::jsonb, '', $1, NULL),
            (11, 'ev-bf-mix', 'legacy_uuid',
                '{"parent_event_id":"f5848770-5933-4f4c-8f08-107d790bfe4b"}'::jsonb, '', $1, NULL),
            (12, 'ev-bf-mix', 'legacy_tool',
                '{"parent_event_id":"toolu_01Y3"}'::jsonb, '', $1, NULL),
            (13, 'ev-bf-mix', 'legacy_empty', '{"parent_event_id":""}'::jsonb, '', $1, NULL),
            (14, 'ev-bf-mix', 'already_filled', '{"parent_event_id":"43"}'::jsonb, '', $1, 43),
            (15, 'ev-bf-mix', 'legacy_overflow',
                '{"parent_event_id":"407885725189"}'::jsonb, '', $1, NULL),
            (16, 'ev-bf-mix', 'legacy_int_max',
                '{"parent_event_id":"2147483647"}'::jsonb, '', $1, NULL),
            (17, 'ev-bf-mix', 'legacy_dangling_int',
                '{"parent_event_id":"99999"}'::jsonb, '', $1, NULL)
        """,
        now,
    )

    # schema.sql 끝의 백필 UPDATE를 재실행 (멱등 + INT 범위 + FK 가드 검증)
    await test_db.execute(
        r"""
        UPDATE events e
        SET parent_event_id = (e.payload->>'parent_event_id')::INTEGER
        WHERE e.parent_event_id IS NULL
          AND e.payload->>'parent_event_id' ~ '^\d{1,10}$'
          AND (e.payload->>'parent_event_id')::BIGINT BETWEEN 1 AND 2147483647
          AND EXISTS (
            SELECT 1 FROM events p
            WHERE p.session_id = e.session_id
              AND p.id = (e.payload->>'parent_event_id')::INTEGER
          )
        """
    )

    rows = {
        r["id"]: r["parent_event_id"]
        for r in await test_db.fetch(
            "SELECT id, parent_event_id FROM events WHERE session_id = 'ev-bf-mix'"
        )
    }
    assert rows[10] == 42, "정수 문자열 + 부모 존재 → 백필되어야 함"
    assert rows[11] is None, "UUID는 컬럼 NULL 유지"
    assert rows[12] is None, "tool_use_id는 컬럼 NULL 유지"
    assert rows[13] is None, "빈 문자열은 컬럼 NULL 유지"
    assert rows[14] == 43, "이미 채워진 컬럼은 덮어쓰지 않음"
    assert rows[15] is None, "INT 범위 초과는 컬럼 NULL 유지 (overflow 차단)"
    assert rows[16] is None, "INT MAX 정수지만 부모 행 없음 → FK 가드로 NULL 유지"
    assert rows[17] is None, "정수지만 같은 세션에 부모 행 없음 (dangling) → FK 가드로 NULL 유지"


async def test_event_append_concurrency(test_db):
    """동시에 10개 이벤트를 append해도 ID 중복이 없어야 한다."""
    await _create_session(test_db, "ev-conc")
    now = _utc_now()

    async def append_one(n):
        return await test_db.fetchval(
            "SELECT event_append($1, $2, $3, $4, $5)",
            "ev-conc", "test", json.dumps({"n": n}), f"test {n}", now,
        )

    results = await asyncio.gather(*[append_one(i) for i in range(10)])
    ids = list(results)
    assert len(set(ids)) == 10, f"Duplicate IDs detected: {ids}"
    assert sorted(ids) == list(range(1, 11))


async def test_event_updates_last_event_id(test_db):
    """event_append가 sessions.last_event_id를 갱신하는지 검증."""
    await _create_session(test_db, "ev-lei")
    now = _utc_now()
    eid = await test_db.fetchval(
        "SELECT event_append($1, $2, $3, $4, $5)",
        "ev-lei", "test", '{"x":1}', "test", now,
    )
    row = await test_db.fetchrow("SELECT * FROM session_get($1)", "ev-lei")
    assert row["last_event_id"] == eid


# === 이벤트 검색 ===

async def test_event_search(test_db):
    await _create_session(test_db, "ev-search")
    now = _utc_now()

    await test_db.fetchval(
        "SELECT event_append($1, $2, $3, $4, $5)",
        "ev-search", "text_delta", '{"text":"unique_keyword_xyz"}',
        "unique_keyword_xyz", now,
    )
    await test_db.fetchval(
        "SELECT event_append($1, $2, $3, $4, $5)",
        "ev-search", "text_delta", '{"text":"other content"}',
        "other content", now,
    )

    # 전체 검색
    rows = await test_db.fetch(
        "SELECT * FROM event_search($1)", "unique_keyword_xyz"
    )
    assert len(rows) >= 1
    assert any(r["session_id"] == "ev-search" for r in rows)

    # session_ids 필터
    rows = await test_db.fetch(
        "SELECT * FROM event_search($1, $2)", "unique_keyword_xyz", ["ev-search"]
    )
    assert len(rows) >= 1

    # 매칭 안 되는 검색
    rows = await test_db.fetch(
        "SELECT * FROM event_search($1, $2)", "unique_keyword_xyz", ["nonexistent"]
    )
    assert len(rows) == 0


async def test_event_search_uses_bm25_terms(test_db):
    await _create_session(test_db, "ev-bm25")
    now = _utc_now()

    await test_db.fetchval(
        "SELECT event_append($1, $2, $3, $4, $5)",
        "ev-bm25", "user_message", '{"text":"alpha alpha alpha beta"}',
        "alpha alpha alpha beta", now,
    )
    await test_db.fetchval(
        "SELECT event_append($1, $2, $3, $4, $5)",
        "ev-bm25", "user_message", '{"text":"alpha beta gamma delta epsilon"}',
        "alpha beta gamma delta epsilon", now,
    )

    terms = await test_db.fetch(
        """
        SELECT event_id, term, term_freq, doc_len
        FROM event_search_terms
        WHERE session_id = $1 AND term = $2
        ORDER BY event_id
        """,
        "ev-bm25", "alpha",
    )
    assert [r["term_freq"] for r in terms] == [3, 1]
    assert [r["doc_len"] for r in terms] == [4, 5]

    rows = await test_db.fetch(
        "SELECT * FROM event_search($1, $2, $3, $4)",
        "alpha", ["ev-bm25"], 10, ["user_message"],
    )
    assert [r["id"] for r in rows[:2]] == [1, 2]
    assert rows[0]["score"] > rows[1]["score"]


# === 폴더 CRUD ===

async def test_folder_create_and_get(test_db):
    await test_db.execute("SELECT folder_create($1, $2, $3)", "f1", "Folder 1", 10)
    row = await test_db.fetchrow("SELECT * FROM folder_get($1)", "f1")
    assert row is not None
    assert row["name"] == "Folder 1"
    assert row["sort_order"] == 10


async def test_folder_update(test_db):
    await _create_folder(test_db, "f-upd", "Before")
    await test_db.execute(
        "SELECT folder_update($1, $2, $3)",
        "f-upd", ["name", "sort_order"], ["After", "5"],
    )
    row = await test_db.fetchrow("SELECT * FROM folder_get($1)", "f-upd")
    assert row["name"] == "After"
    assert row["sort_order"] == 5


async def test_folder_update_invalid_column(test_db):
    await _create_folder(test_db, "f-bad", "Bad")
    with pytest.raises(Exception, match="Invalid folder column"):
        await test_db.execute(
            "SELECT folder_update($1, $2, $3)",
            "f-bad", ["hacked"], ["value"],
        )


async def test_folder_delete(test_db):
    await _create_folder(test_db, "f-del", "Delete Me")
    await test_db.execute("SELECT folder_delete($1)", "f-del")
    row = await test_db.fetchrow("SELECT * FROM folder_get($1)", "f-del")
    assert row is None


async def test_folder_get_all(test_db):
    await _create_folder(test_db, "fa-2", "Bravo", 2)
    await _create_folder(test_db, "fa-1", "Alpha", 1)
    rows = await test_db.fetch("SELECT * FROM folder_get_all()")
    names = [r["name"] for r in rows]
    # sort_order ASC → Alpha(1) before Bravo(2)
    alpha_idx = names.index("Alpha")
    bravo_idx = names.index("Bravo")
    assert alpha_idx < bravo_idx


async def test_folder_get_default(test_db):
    await _create_folder(test_db, "f-def", "Special Name")
    row = await test_db.fetchrow("SELECT * FROM folder_get_default($1)", "Special Name")
    assert row is not None
    assert row["id"] == "f-def"


async def test_folder_ensure_defaults(test_db):
    folders_json = json.dumps([
        {"id": "fe-1", "name": "Default 1", "sort_order": 0},
        {"id": "fe-2", "name": "Default 2", "sort_order": 1},
    ])
    await test_db.execute("SELECT folder_ensure_defaults($1::jsonb)", folders_json)

    row = await test_db.fetchrow("SELECT * FROM folder_get($1)", "fe-1")
    assert row is not None

    # 이미 존재하면 DO NOTHING
    await test_db.execute("SELECT folder_ensure_defaults($1::jsonb)", folders_json)
    row = await test_db.fetchrow("SELECT * FROM folder_get($1)", "fe-1")
    assert row is not None


# === 카탈로그 ===

async def test_catalog_get_sessions(test_db):
    await _create_folder(test_db, "f-cat", "Catalog Folder")
    now = _utc_now()
    await test_db.execute(
        "SELECT session_upsert($1, $2, $3, $4, $5)",
        "cat-1", ["folder_id", "display_name", "status"],
        ["f-cat", "My Session", "idle"], now, now,
    )
    rows = await test_db.fetch("SELECT * FROM catalog_get_sessions()")
    match = [r for r in rows if r["session_id"] == "cat-1"]
    assert len(match) == 1
    assert match[0]["folder_id"] == "f-cat"
    assert match[0]["display_name"] == "My Session"


# === 마이그레이션 ===

async def test_migration_upsert_folder(test_db):
    await test_db.execute("SELECT migration_upsert_folder($1, $2, $3)", "mf-1", "Migrated", 0)
    row = await test_db.fetchrow("SELECT * FROM folder_get($1)", "mf-1")
    assert row is not None

    # 再度実行しても DO NOTHING
    await test_db.execute("SELECT migration_upsert_folder($1, $2, $3)", "mf-1", "Changed", 1)
    row = await test_db.fetchrow("SELECT * FROM folder_get($1)", "mf-1")
    assert row["name"] == "Migrated"  # 変更されない


async def test_migration_upsert_session(test_db):
    data = json.dumps({
        "status": "idle",
        "node_id": "test-node",
        "session_type": "claude",
    })
    await test_db.execute("SELECT migration_upsert_session($1, $2::jsonb)", "ms-1", data)
    row = await test_db.fetchrow("SELECT * FROM session_get($1)", "ms-1")
    assert row is not None
    assert row["status"] == "idle"

    # upsert: 상태 변경
    data2 = json.dumps({"status": "running", "node_id": "test-node"})
    await test_db.execute("SELECT migration_upsert_session($1, $2::jsonb)", "ms-1", data2)
    row = await test_db.fetchrow("SELECT * FROM session_get($1)", "ms-1")
    assert row["status"] == "running"


async def test_migration_insert_event(test_db):
    await _create_session(test_db, "me-1")
    now = _utc_now()
    payload = json.dumps({"text": "migrated"})
    await test_db.execute(
        "SELECT migration_insert_event($1, $2, $3, $4::jsonb, $5, $6)",
        "me-1", 100, "text_delta", payload, "migrated", now,
    )
    row = await test_db.fetchrow("SELECT * FROM event_read_one($1, $2)", "me-1", 100)
    assert row is not None

    # ON CONFLICT DO NOTHING
    await test_db.execute(
        "SELECT migration_insert_event($1, $2, $3, $4::jsonb, $5, $6)",
        "me-1", 100, "text_delta", payload, "migrated", now,
    )


async def test_migration_ensure_session(test_db):
    data = json.dumps({"status": "idle", "node_id": "test-node"})
    await test_db.execute("SELECT migration_ensure_session($1, $2::jsonb)", "mes-1", data)
    row = await test_db.fetchrow("SELECT * FROM session_get($1)", "mes-1")
    assert row is not None

    # 既存なら INSERT しない
    data2 = json.dumps({"status": "running", "node_id": "test-node"})
    await test_db.execute("SELECT migration_ensure_session($1, $2::jsonb)", "mes-1", data2)
    row = await test_db.fetchrow("SELECT * FROM session_get($1)", "mes-1")
    assert row["status"] == "idle"  # 変更されない


async def test_migration_update_last_event_id(test_db):
    await _create_session(test_db, "mlei-1")

    # 初回: NULL → 10
    await test_db.execute("SELECT migration_update_last_event_id($1, $2)", "mlei-1", 10)
    row = await test_db.fetchrow("SELECT * FROM session_get($1)", "mlei-1")
    assert row["last_event_id"] == 10

    # より大きい値 → 更新
    await test_db.execute("SELECT migration_update_last_event_id($1, $2)", "mlei-1", 20)
    row = await test_db.fetchrow("SELECT * FROM session_get($1)", "mlei-1")
    assert row["last_event_id"] == 20

    # より小さい値 → 更新しない
    await test_db.execute("SELECT migration_update_last_event_id($1, $2)", "mlei-1", 5)
    row = await test_db.fetchrow("SELECT * FROM session_get($1)", "mlei-1")
    assert row["last_event_id"] == 20


async def test_migration_verify(test_db):
    now = _utc_now()
    await test_db.execute(
        "SELECT session_upsert($1, $2, $3, $4, $5)",
        "mv-1", ["node_id", "status"], ["verify-node", "idle"], now, now,
    )
    await test_db.fetchval(
        "SELECT event_append($1, $2, $3, $4, $5)",
        "mv-1", "test", '{"x":1}', "test", now,
    )

    row = await test_db.fetchrow("SELECT * FROM migration_verify($1)", "verify-node")
    assert row["session_count"] >= 1
    assert row["event_count"] >= 1
    assert row["folder_count"] >= 0
