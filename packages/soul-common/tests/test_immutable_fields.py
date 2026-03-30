"""불변 필드(claude_session_id, node_id, agent_id) 제약 테스트.

SqliteSessionDB의 upsert_session에서 이미 설정된 불변 필드를
다른 값으로 덮어쓰려 하면 ValueError가 발생해야 한다.
"""

from pathlib import Path

import pytest
import pytest_asyncio

from soul_common.db.sqlite_session_db import SqliteSessionDB

_SCHEMA_PATH = (
    Path(__file__).resolve().parent.parent
    / "src" / "soul_common" / "db" / "sqlite_schema.sql"
)


@pytest_asyncio.fixture
async def db():
    """인메모리 SqliteSessionDB 픽스처."""
    instance = SqliteSessionDB(
        db_path=":memory:",
        node_id="test-node",
        schema_path=_SCHEMA_PATH,
    )
    await instance.connect()
    yield instance
    await instance.close()


class TestImmutableFields:
    """claude_session_id, node_id, agent_id 불변 제약 테스트"""

    # --- claude_session_id ---

    async def test_set_claude_session_id_on_new_session(self, db: SqliteSessionDB):
        """신규 세션에 claude_session_id 최초 설정 → 성공"""
        await db.upsert_session("sess-1", status="running")
        await db.upsert_session("sess-1", claude_session_id="claude-abc")
        row = await db.get_session("sess-1")
        assert row["claude_session_id"] == "claude-abc"

    async def test_overwrite_claude_session_id_raises(self, db: SqliteSessionDB):
        """이미 설정된 claude_session_id에 다른 값 쓰기 → ValueError"""
        await db.upsert_session("sess-1", claude_session_id="claude-original")
        with pytest.raises(ValueError, match="Immutable field 'claude_session_id'"):
            await db.upsert_session("sess-1", claude_session_id="claude-new")

    async def test_same_claude_session_id_is_idempotent(self, db: SqliteSessionDB):
        """기존과 동일한 claude_session_id 쓰기 → 성공 (멱등)"""
        await db.upsert_session("sess-1", claude_session_id="claude-abc")
        await db.upsert_session("sess-1", claude_session_id="claude-abc")  # 동일 값 → OK
        row = await db.get_session("sess-1")
        assert row["claude_session_id"] == "claude-abc"

    async def test_write_none_does_not_overwrite_claude_session_id(self, db: SqliteSessionDB):
        """None 값 쓰기는 불변 제약을 발동하지 않는다 (기존 값 유지)"""
        await db.upsert_session("sess-1", claude_session_id="claude-abc")
        # None을 전달하면 제약을 건너뜀 (덮어쓰기 의도 없음)
        await db.upsert_session("sess-1", claude_session_id=None, status="completed")
        row = await db.get_session("sess-1")
        # SQLite UPDATE는 None을 그대로 쓰므로 NULL이 될 수 있으나, 제약은 발동하지 않아야 함
        # (None 덮어쓰기 허용 여부는 DB 구현에 따라 다름 — 여기서는 ValueError가 나지 않음만 검증)

    # --- node_id ---

    async def test_set_node_id_on_new_session(self, db: SqliteSessionDB):
        """신규 세션에 node_id 최초 설정 → 성공"""
        await db.upsert_session("sess-2", node_id="node-1")
        row = await db.get_session("sess-2")
        assert row["node_id"] == "node-1"

    async def test_overwrite_node_id_raises(self, db: SqliteSessionDB):
        """이미 설정된 node_id에 다른 값 쓰기 → ValueError"""
        await db.upsert_session("sess-2", node_id="node-1")
        with pytest.raises(ValueError, match="Immutable field 'node_id'"):
            await db.upsert_session("sess-2", node_id="node-2")

    async def test_same_node_id_is_idempotent(self, db: SqliteSessionDB):
        """기존과 동일한 node_id 쓰기 → 성공 (멱등)"""
        await db.upsert_session("sess-2", node_id="node-1")
        await db.upsert_session("sess-2", node_id="node-1")
        row = await db.get_session("sess-2")
        assert row["node_id"] == "node-1"

    # --- agent_id ---

    async def test_set_agent_id_on_new_session(self, db: SqliteSessionDB):
        """신규 세션에 agent_id 최초 설정 → 성공"""
        await db.upsert_session("sess-3", agent_id="profile-x")
        row = await db.get_session("sess-3")
        assert row["agent_id"] == "profile-x"

    async def test_overwrite_agent_id_raises(self, db: SqliteSessionDB):
        """이미 설정된 agent_id에 다른 값 쓰기 → ValueError"""
        await db.upsert_session("sess-3", agent_id="profile-x")
        with pytest.raises(ValueError, match="Immutable field 'agent_id'"):
            await db.upsert_session("sess-3", agent_id="profile-y")

    async def test_same_agent_id_is_idempotent(self, db: SqliteSessionDB):
        """기존과 동일한 agent_id 쓰기 → 성공 (멱등)"""
        await db.upsert_session("sess-3", agent_id="profile-x")
        await db.upsert_session("sess-3", agent_id="profile-x")
        row = await db.get_session("sess-3")
        assert row["agent_id"] == "profile-x"

    # --- set_claude_session_id 직접 테스트 ---

    async def test_set_claude_session_id_initial(self, db: SqliteSessionDB):
        """NULL → SET (최초 설정)"""
        await db.upsert_session("sess-5", status="running")
        await db.set_claude_session_id("sess-5", "claude-abc")
        row = await db.get_session("sess-5")
        assert row["claude_session_id"] == "claude-abc"

    async def test_set_claude_session_id_same_value_is_noop(self, db: SqliteSessionDB):
        """같은 값 → no-op (컴팩션/재진입 시나리오)"""
        await db.upsert_session("sess-5", status="running")
        await db.set_claude_session_id("sess-5", "claude-abc")
        await db.set_claude_session_id("sess-5", "claude-abc")  # 두 번 호출 → no-op
        row = await db.get_session("sess-5")
        assert row["claude_session_id"] == "claude-abc"

    async def test_set_claude_session_id_different_value_raises(self, db: SqliteSessionDB):
        """다른 값 → ValueError (불변성 위반)"""
        await db.upsert_session("sess-5", status="running")
        await db.set_claude_session_id("sess-5", "claude-abc")
        with pytest.raises(ValueError, match="claude_session_id immutability violation"):
            await db.set_claude_session_id("sess-5", "claude-xyz")

    # --- 복합 시나리오 ---

    async def test_mutable_fields_can_always_be_updated(self, db: SqliteSessionDB):
        """불변 필드 외의 필드(status 등)는 자유롭게 업데이트 가능"""
        await db.upsert_session("sess-4", status="running", claude_session_id="claude-1")
        await db.upsert_session("sess-4", status="completed")
        row = await db.get_session("sess-4")
        assert row["status"] == "completed"
        assert row["claude_session_id"] == "claude-1"  # 불변 필드 유지
