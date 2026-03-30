"""불변 필드(claude_session_id, node_id, agent_id) 제약 테스트.

SqliteSessionDB의 upsert_session에서 이미 설정된 불변 필드를
다른 값(None 포함)으로 덮어쓰려 하면 ValueError가 발생해야 한다.

register_session_initial: 순수 INSERT, 중복 호출 시 예외.
update_session: 불변 필드 전달 시 ValueError.
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

    async def test_write_none_overwrites_claude_session_id_raises(self, db: SqliteSessionDB):
        """None 값 쓰기도 불변 제약을 발동한다 — 이미 설정된 값을 None으로 지우는 시도를 차단"""
        await db.upsert_session("sess-1", claude_session_id="claude-abc")
        with pytest.raises(ValueError, match="Immutable field 'claude_session_id'"):
            await db.upsert_session("sess-1", claude_session_id=None, status="completed")

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

    # --- 복합 시나리오 ---

    async def test_mutable_fields_can_always_be_updated(self, db: SqliteSessionDB):
        """불변 필드 외의 필드(status 등)는 자유롭게 업데이트 가능"""
        await db.upsert_session("sess-4", status="running", claude_session_id="claude-1")
        await db.upsert_session("sess-4", status="completed")
        row = await db.get_session("sess-4")
        assert row["status"] == "completed"
        assert row["claude_session_id"] == "claude-1"  # 불변 필드 유지


class TestRegisterSessionInitial:
    """register_session_initial — 순수 INSERT, 중복 시 예외"""

    async def test_register_inserts_session(self, db: SqliteSessionDB):
        """정상 등록: 4개 ID가 저장된다"""
        await db.register_session_initial(
            "sess-reg-1",
            node_id="node-A",
            agent_id="agent-X",
            claude_session_id="claude-C",
            session_type="claude",
            prompt="hello",
            status="running",
        )
        row = await db.get_session("sess-reg-1")
        assert row is not None
        assert row["node_id"] == "node-A"
        assert row["agent_id"] == "agent-X"
        assert row["claude_session_id"] == "claude-C"
        assert row["session_type"] == "claude"
        assert row["status"] == "running"

    async def test_register_duplicate_raises(self, db: SqliteSessionDB):
        """중복 호출 시 UNIQUE 제약 위반 예외 발생 (ON CONFLICT 없음)"""
        await db.register_session_initial(
            "sess-reg-2",
            node_id="node-A",
            agent_id="agent-X",
        )
        with pytest.raises(Exception):
            await db.register_session_initial(
                "sess-reg-2",
                node_id="node-A",
                agent_id="agent-X",
            )

    async def test_register_with_null_claude_session_id(self, db: SqliteSessionDB):
        """claude_session_id=None 허용 (LLM 세션 등록 시나리오)"""
        await db.register_session_initial(
            "sess-reg-3",
            node_id="node-B",
            agent_id="agent-Y",
            claude_session_id=None,
        )
        row = await db.get_session("sess-reg-3")
        assert row is not None
        assert row["claude_session_id"] is None
        assert row["node_id"] == "node-B"


class TestUpdateSession:
    """update_session — 순수 UPDATE, 불변 필드 전달 시 ValueError"""

    async def test_update_mutable_field(self, db: SqliteSessionDB):
        """가변 필드 업데이트 성공"""
        await db.register_session_initial(
            "sess-upd-1",
            node_id="node-A",
            agent_id="agent-X",
        )
        await db.update_session("sess-upd-1", status="completed")
        row = await db.get_session("sess-upd-1")
        assert row["status"] == "completed"

    async def test_update_node_id_raises(self, db: SqliteSessionDB):
        """node_id 전달 시 ValueError"""
        await db.register_session_initial(
            "sess-upd-2",
            node_id="node-A",
            agent_id="agent-X",
        )
        with pytest.raises(ValueError, match="Immutable fields"):
            await db.update_session("sess-upd-2", node_id="node-B")

    async def test_update_agent_id_raises(self, db: SqliteSessionDB):
        """agent_id 전달 시 ValueError"""
        await db.register_session_initial(
            "sess-upd-3",
            node_id="node-A",
            agent_id="agent-X",
        )
        with pytest.raises(ValueError, match="Immutable fields"):
            await db.update_session("sess-upd-3", agent_id="agent-Z")

    async def test_update_claude_session_id_raises(self, db: SqliteSessionDB):
        """claude_session_id 전달 시 ValueError"""
        await db.register_session_initial(
            "sess-upd-4",
            node_id="node-A",
            agent_id="agent-X",
            claude_session_id="claude-original",
        )
        with pytest.raises(ValueError, match="Immutable fields"):
            await db.update_session("sess-upd-4", claude_session_id="claude-new")

    async def test_update_session_type_raises(self, db: SqliteSessionDB):
        """session_type 전달 시 ValueError"""
        await db.register_session_initial(
            "sess-upd-5",
            node_id="node-A",
            agent_id="agent-X",
        )
        with pytest.raises(ValueError, match="Immutable fields"):
            await db.update_session("sess-upd-5", session_type="llm")

    async def test_update_preserves_immutable_fields(self, db: SqliteSessionDB):
        """가변 필드 업데이트 후 불변 필드가 유지된다"""
        await db.register_session_initial(
            "sess-upd-6",
            node_id="node-A",
            agent_id="agent-X",
            claude_session_id="claude-stable",
        )
        await db.update_session("sess-upd-6", status="completed", display_name="My Session")
        row = await db.get_session("sess-upd-6")
        assert row["node_id"] == "node-A"
        assert row["agent_id"] == "agent-X"
        assert row["claude_session_id"] == "claude-stable"
        assert row["status"] == "completed"
        assert row["display_name"] == "My Session"
