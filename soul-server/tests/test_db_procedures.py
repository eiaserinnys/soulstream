"""DB 프로시저 통합 테스트

실제 PostgreSQL에 연결하여 schema.sql의 모든 프로시저를 검증한다.
TEST_DATABASE_URL 환경변수가 없으면 전체 skip.
"""

import asyncio
import json
from datetime import datetime, timezone

import pytest


pytestmark = pytest.mark.asyncio


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


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
    assert row["metadata"] == [{"type": "test", "value": "hello"}]
    assert row["last_message"] == {"text": "hi"}


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
    assert len(row["metadata"]) == 1

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
    assert row["last_message"] == {"text": "hello"}


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
