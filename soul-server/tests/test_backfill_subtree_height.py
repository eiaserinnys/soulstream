"""backfill_subtree_height 스크립트 통합 테스트

실제 PostgreSQL(TEST_DATABASE_URL)에 이벤트를 삽입하고
`compute_heights_iterative` / `migrate_parent_column` / `backfill_session` /
`run` 진입점을 검증한다. TEST_DATABASE_URL이 없으면 test_db fixture가 skip한다.

검증 대상 요구사항:
- 🔴 핵심 #1: subtree_height 재계산이 기존 세션 전부에 적용된다.
- 🟡 파생 #6: parent_event_id 컬럼(INTEGER)으로의 이관이 payload 스트링 값을 int로 변환한다.
- 🔵 에지 #9: 단계 2(NULLIF 변환) → 단계 3(DFS)의 순서가 반드시 지켜진다.
- ⚪ 비기능: 2000-depth linear chain에서 iterative DFS가 재귀 한도 초과 없이 동작한다.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

# scripts/ 디렉토리를 sys.path에 추가하여 backfill 모듈을 import 가능하게 함
SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import backfill_subtree_height as backfill  # type: ignore[import-not-found]


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


# === Helpers ===

async def _create_session(db, session_id: str) -> None:
    now = _utc_now()
    await db.execute(
        "SELECT session_upsert($1, $2, $3, $4, $5)",
        session_id,
        ["status", "node_id"],
        ["idle", "test-node"],
        now,
        now,
    )


async def _insert_event(
    db,
    session_id: str,
    event_id: int,
    event_type: str,
    payload: dict | None = None,
    parent_event_id: int | None = None,
) -> None:
    """raw INSERT로 이벤트를 삽입한다.

    event_append 프로시저를 사용하면 id가 자동 증가하므로,
    부모-자식 관계를 명시적으로 테스트하기 위해 직접 INSERT한다.
    parent_event_id 컬럼에 직접 값을 설정하지 않고, payload에만 넣어서
    단계 2(migrate_parent_column)가 이관하는지 검증한다.
    """
    payload_obj: dict = dict(payload or {})
    if parent_event_id is not None:
        payload_obj["parent_event_id"] = parent_event_id
    payload_json = json.dumps(payload_obj)
    await db.execute(
        "INSERT INTO events (session_id, id, event_type, payload, created_at) "
        "VALUES ($1, $2, $3, $4::jsonb, $5)",
        session_id,
        event_id,
        event_type,
        payload_json,
        _utc_now(),
    )


# === compute_heights_iterative (pure function) ===

def test_compute_heights_linear_chain():
    """3-노드 linear 트리 (1 → 2 → 3): heights = [3, 2, 1]"""
    rows = [
        {"id": 1, "parent_event_id": None},
        {"id": 2, "parent_event_id": 1},
        {"id": 3, "parent_event_id": 2},
    ]
    heights = backfill.compute_heights_iterative(rows)
    assert heights == {1: 3, 2: 2, 3: 1}


def test_compute_heights_branching():
    """분기 트리 (1 → {2, 3, 4}): heights = [4, 1, 1, 1]"""
    rows = [
        {"id": 1, "parent_event_id": None},
        {"id": 2, "parent_event_id": 1},
        {"id": 3, "parent_event_id": 1},
        {"id": 4, "parent_event_id": 1},
    ]
    heights = backfill.compute_heights_iterative(rows)
    assert heights == {1: 4, 2: 1, 3: 1, 4: 1}


def test_compute_heights_mixed_tree():
    """복잡 트리: root → (a → (c, d)), b.  heights: root=5, a=3, b=1, c=1, d=1."""
    rows = [
        {"id": 1, "parent_event_id": None},   # root
        {"id": 2, "parent_event_id": 1},      # a
        {"id": 3, "parent_event_id": 1},      # b
        {"id": 4, "parent_event_id": 2},      # c
        {"id": 5, "parent_event_id": 2},      # d
    ]
    heights = backfill.compute_heights_iterative(rows)
    assert heights == {1: 5, 2: 3, 3: 1, 4: 1, 5: 1}


def test_compute_heights_ignores_orphans_without_root():
    """루트(parent_event_id IS NULL)가 없으면 어떤 노드에도 도달하지 않는다."""
    rows = [
        # 모든 노드가 다른 노드를 parent로 가짐. 루트가 없음 — 일반적으로 FK로 불가능하지만 edge case.
        {"id": 2, "parent_event_id": 1},
        {"id": 3, "parent_event_id": 2},
    ]
    heights = backfill.compute_heights_iterative(rows)
    assert heights == {}


def test_compute_heights_empty():
    heights = backfill.compute_heights_iterative([])
    assert heights == {}


def test_compute_heights_2000_depth_linear_chain():
    """2000-깊이 linear chain: iterative DFS가 Python 재귀 한도(기본 1000) 초과 없이 동작한다.

    재귀 구현이었다면 RecursionError가 발생할 깊이다.
    heights[i]는 (N - i + 1) 이 되어야 한다 — 체인의 leaf까지의 거리 + 1.
    """
    N = 2000
    rows = [{"id": 1, "parent_event_id": None}]
    for i in range(2, N + 1):
        rows.append({"id": i, "parent_event_id": i - 1})

    heights = backfill.compute_heights_iterative(rows)
    assert len(heights) == N
    assert heights[1] == N          # 루트의 subtree_height = 전체 노드 수
    assert heights[N] == 1          # 리프
    # 중간 지점 샘플링
    assert heights[1000] == N - 999
    assert heights[N // 2] == N - (N // 2) + 1


# === migrate_parent_column (단계 2) ===

async def test_migrate_parent_column_moves_payload_to_column(test_db):
    """payload.parent_event_id의 문자열 값이 INTEGER 컬럼으로 이관된다."""
    sid = "migrate-simple"
    await _create_session(test_db, sid)
    await _insert_event(test_db, sid, 1, "user_message", parent_event_id=None)
    # payload에 "1" 문자열로 저장 (기존 레거시 포맷 모사)
    await test_db.execute(
        "INSERT INTO events (session_id, id, event_type, payload, created_at) "
        "VALUES ($1, $2, $3, $4::jsonb, $5)",
        sid, 2, "assistant", json.dumps({"parent_event_id": "1"}), _utc_now(),
    )

    # 삽입 직후에는 parent_event_id 컬럼이 NULL이다 (payload에만 존재)
    col_val = await test_db.fetchval(
        "SELECT parent_event_id FROM events WHERE session_id = $1 AND id = 2",
        sid,
    )
    assert col_val is None

    # 단계 2 실행
    async with test_db.acquire() as conn:
        migrated = await backfill.migrate_parent_column(conn)
    assert migrated >= 1

    col_val = await test_db.fetchval(
        "SELECT parent_event_id FROM events WHERE session_id = $1 AND id = 2",
        sid,
    )
    assert col_val == 1  # str "1" → int 1


async def test_migrate_parent_column_handles_empty_string(test_db):
    """빈 문자열 parent_event_id는 NULL로 변환된다 (NULLIF 효과)."""
    sid = "migrate-empty"
    await _create_session(test_db, sid)
    await _insert_event(test_db, sid, 1, "user_message")
    await test_db.execute(
        "INSERT INTO events (session_id, id, event_type, payload, created_at) "
        "VALUES ($1, $2, $3, $4::jsonb, $5)",
        sid, 2, "assistant", json.dumps({"parent_event_id": ""}), _utc_now(),
    )

    async with test_db.acquire() as conn:
        await backfill.migrate_parent_column(conn)

    col_val = await test_db.fetchval(
        "SELECT parent_event_id FROM events WHERE session_id = $1 AND id = 2",
        sid,
    )
    assert col_val is None


async def test_migrate_parent_column_ignores_already_set(test_db):
    """parent_event_id 컬럼에 이미 값이 있으면 덮어쓰지 않는다."""
    sid = "migrate-prefilled"
    await _create_session(test_db, sid)
    await _insert_event(test_db, sid, 1, "user_message")
    # 컬럼에 직접 값 설정 + payload에 다른 값
    await test_db.execute(
        "INSERT INTO events (session_id, id, event_type, payload, parent_event_id, created_at) "
        "VALUES ($1, $2, $3, $4::jsonb, $5, $6)",
        sid, 2, "assistant", json.dumps({"parent_event_id": "99"}), 1, _utc_now(),
    )

    async with test_db.acquire() as conn:
        await backfill.migrate_parent_column(conn)

    col_val = await test_db.fetchval(
        "SELECT parent_event_id FROM events WHERE session_id = $1 AND id = 2",
        sid,
    )
    # 컬럼에 이미 1이 있었으므로 99로 덮어쓰지 않는다
    assert col_val == 1


# === backfill_session + run (단계 3) ===

async def test_backfill_session_updates_subtree_height(test_db):
    """단일 세션에 대해 subtree_height가 트리 구조에 맞게 재계산된다."""
    sid = "session-tree"
    await _create_session(test_db, sid)
    # root(1) → (2, 3); 3 → 4
    await _insert_event(test_db, sid, 1, "user_message")
    await test_db.execute(
        "UPDATE events SET parent_event_id = NULL WHERE session_id = $1 AND id = 1",
        sid,
    )
    await test_db.execute(
        "INSERT INTO events (session_id, id, event_type, payload, parent_event_id, created_at) "
        "VALUES ($1, 2, 'assistant', '{}'::jsonb, 1, $2), "
        "       ($1, 3, 'assistant', '{}'::jsonb, 1, $2), "
        "       ($1, 4, 'tool_result', '{}'::jsonb, 3, $2)",
        sid, _utc_now(),
    )

    async with test_db.acquire() as conn:
        updated = await backfill.backfill_session(conn, sid)
    assert updated == 4

    rows = await test_db.fetch(
        "SELECT id, subtree_height FROM events WHERE session_id = $1 ORDER BY id",
        sid,
    )
    heights = {r["id"]: r["subtree_height"] for r in rows}
    assert heights == {1: 4, 2: 1, 3: 2, 4: 1}


async def test_backfill_session_leaves_orphan_events_untouched(test_db):
    """parent_event_id가 없는 단독 이벤트는 subtree_height DEFAULT 1 유지."""
    sid = "session-solo"
    await _create_session(test_db, sid)
    await _insert_event(test_db, sid, 1, "user_message")

    async with test_db.acquire() as conn:
        updated = await backfill.backfill_session(conn, sid)

    assert updated == 1
    h = await test_db.fetchval(
        "SELECT subtree_height FROM events WHERE session_id = $1 AND id = 1",
        sid,
    )
    assert h == 1


# === 단계 2 → 단계 3 순서 통합 (🔵 에지 #9) ===

async def test_run_executes_step2_before_step3(test_db, monkeypatch):
    """run()이 migrate_parent_column(단계 2)을 backfill_session(단계 3)보다 먼저 호출한다.

    부모-자식 관계가 payload에만 있는 경우 단계 2가 선행되어야 단계 3의 DFS가
    의미 있는 subtree_height를 산출한다.
    """
    sid = "step-order"
    await _create_session(test_db, sid)
    # root(1)과 child(2). 부모 정보는 오직 payload에만 존재.
    await _insert_event(test_db, sid, 1, "user_message")
    await test_db.execute(
        "INSERT INTO events (session_id, id, event_type, payload, created_at) "
        "VALUES ($1, 2, 'assistant', $2::jsonb, $3)",
        sid, json.dumps({"parent_event_id": "1"}), _utc_now(),
    )

    # 호출 순서 추적
    call_order: list[str] = []

    real_migrate = backfill.migrate_parent_column
    real_backfill = backfill.backfill_session

    async def tracked_migrate(conn):
        call_order.append("step2")
        return await real_migrate(conn)

    async def tracked_backfill(conn, session_id):
        call_order.append(f"step3:{session_id}")
        return await real_backfill(conn, session_id)

    monkeypatch.setattr(backfill, "migrate_parent_column", tracked_migrate)
    monkeypatch.setattr(backfill, "backfill_session", tracked_backfill)

    # DSN을 직접 넘길 수 없으므로 run의 시그니처를 활용: pool 생성 DSN은 TEST_DATABASE_URL
    import os
    dsn = os.environ["TEST_DATABASE_URL"]
    await backfill.run(dsn, dry_run=False)

    # step2가 모든 step3 호출보다 먼저 나와야 한다
    assert call_order, "migrate 또는 backfill이 호출되지 않음"
    assert call_order[0] == "step2", f"첫 호출이 step2가 아님: {call_order[0]}"
    step3_calls = [c for c in call_order if c.startswith("step3:")]
    assert step3_calls, "backfill_session이 호출되지 않음"

    # 단계 2가 선행된 후 단계 3 결과 확인
    heights = await test_db.fetch(
        "SELECT id, subtree_height FROM events WHERE session_id = $1 ORDER BY id",
        sid,
    )
    h_map = {r["id"]: r["subtree_height"] for r in heights}
    assert h_map == {1: 2, 2: 1}, f"단계 2→3 통합 실패: {h_map}"


async def test_run_dry_run_does_not_modify_data(test_db):
    """--dry-run 모드는 migrate/backfill을 실행하지 않고 카운트만 로깅한다."""
    sid = "dry-run"
    await _create_session(test_db, sid)
    await test_db.execute(
        "INSERT INTO events (session_id, id, event_type, payload, created_at) "
        "VALUES ($1, 1, 'user_message', '{}'::jsonb, $2), "
        "       ($1, 2, 'assistant', $3::jsonb, $2)",
        sid, _utc_now(), json.dumps({"parent_event_id": "1"}),
    )

    import os
    dsn = os.environ["TEST_DATABASE_URL"]
    await backfill.run(dsn, dry_run=True)

    # dry-run 후에도 parent_event_id 컬럼은 NULL 유지
    col = await test_db.fetchval(
        "SELECT parent_event_id FROM events WHERE session_id = $1 AND id = 2",
        sid,
    )
    assert col is None
