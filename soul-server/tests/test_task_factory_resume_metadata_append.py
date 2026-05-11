"""test_task_factory_resume_metadata_append — R-6 G-20 resume 시 caller_info metadata append 회귀.

R-6 fix(2026-05-11, atom G-20):
- `_resume_existing_task_locked`가 `_has_identity` 통과 시 *DB metadata에 caller_info entry append*.
- 이전(F-9~R-5): `task.caller_info`만 인메모리 갱신, `append_metadata` 미호출.
- 결과적으로 `_register_new_session_async`(신규 세션) 경로만 metadata append 발동, resume 경로는
  누락 → REST 응답(DB-derived) vs SSE wire(in-memory-derived) 시간 축 비대칭 회로.
  sess-20260419114049-8cf09982 라이브 재현 (D1 카드 첫 동기화: dashboard owner Jubok Kim,
  후속 동기화: スバル로 대체).

매트릭스:
- T-G20-A1: resume + caller_info(identity, slack) → append_metadata 1회 호출, entry 값 정합
- T-G20-A2: resume + caller_info(no identity, browser+ip만) → append_metadata 0회 (R-2 graceful 보존)
- T-G20-A3: resume + caller_info=None → append_metadata 0회 (graceful)
- T-G20-A4: resume + caller_info(identity, agent source-only) → append_metadata 1회
- T-G20-A5: resume + caller_info(identity, slack + display_name+avatar_url) → entry 값에 신원 필드 포함
- T-G20-A6: 신규 세션(_register_new_session_async) 경로 append 패턴 보존 — 본 R-6 변경에 영향 없음
  (회귀 안전망: _register_new_session_async와 _resume_existing_task_locked가 *같은 entry 형식*으로
  append하는지 §9 대칭 검증)
"""

from __future__ import annotations

import asyncio
from typing import Any, Dict, Optional
from unittest.mock import AsyncMock, MagicMock

import pytest

from soul_server.service.task_factory import (
    CreateTaskParams,
    TaskFactory,
)
from soul_server.service.task_models import Task, TaskStatus


# === Helpers ===


def _make_existing_task(
    session_id: str = "sess-existing",
    prior_caller_info: Optional[dict] = None,
) -> Task:
    """COMPLETED 상태의 기존 task — resume 대상."""
    task = Task(
        agent_session_id=session_id,
        prompt="prior prompt",
        client_id="prior-user",
        status=TaskStatus.COMPLETED,
        caller_info=prior_caller_info,
    )
    task.node_id = "test-node"
    task.metadata = []
    return task


def _make_factory(
    *,
    existing_task: Task,
    db: MagicMock,
) -> tuple[TaskFactory, asyncio.Lock, Dict[str, Task]]:
    """TaskFactory + 의존성 mock 묶음 생성.

    eviction_manager는 MagicMock(unregister 호출만 필요).
    assign_default_folder는 사용 안 됨 (resume 경로라 _register_new_session_async 미진입).
    """
    tasks: Dict[str, Task] = {existing_task.agent_session_id: existing_task}
    lock = asyncio.Lock()

    eviction_manager = MagicMock()
    eviction_manager.unregister = MagicMock()
    eviction_manager.is_candidate = MagicMock(return_value=False)
    eviction_manager.register = MagicMock()

    async def assign_default_folder(*args, **kwargs):
        return None

    factory = TaskFactory(
        session_db=db,
        tasks=tasks,
        lock=lock,
        eviction_manager=eviction_manager,
        agent_registry=None,
        assign_default_folder=assign_default_folder,
    )
    return factory, lock, tasks


def _make_db_mock(prior_metadata: Optional[list] = None) -> MagicMock:
    """PostgresSessionDB mock — get_session + append_metadata."""
    db = MagicMock()
    db.node_id = "test-node"
    db.get_session = AsyncMock(return_value={"metadata": prior_metadata or []})
    db.append_metadata = AsyncMock(return_value=None)
    # _resume_task_unlocked에서 호출되는 추가 메서드 mock (테스트 격리 — 본 테스트는 lock 내 동작만)
    db.update_session_status = AsyncMock(return_value=None)
    db.update_session = AsyncMock(return_value=None)
    return db


# === T-G20-A: Resume 시 metadata append 매트릭스 ===


class TestResumeMetadataAppend:
    """`_resume_existing_task_locked` — R-6 G-20 fix 회귀.

    `create_or_resume`을 호출하면 *lock 내부에서* `_resume_existing_task_locked`가 실행되고,
    lock 외부에서 `_resume_task_unlocked`가 호출된다. 본 테스트는 *lock 내 동작*만 검증하므로
    `_resume_existing_task_locked`를 직접 호출하지 않고 `create_or_resume`의 부수효과를 단언.
    `_resume_task_unlocked`의 의존성은 db mock으로 흡수.
    """

    @pytest.mark.asyncio
    async def test_resume_with_identity_slack_appends_metadata(self):
        """T-G20-A1: resume + caller_info(slack, identity) → metadata에 caller_info entry append."""
        existing = _make_existing_task(prior_caller_info=None)
        db = _make_db_mock(prior_metadata=[])
        factory, _, _ = _make_factory(existing_task=existing, db=db)

        new_caller = {
            "source": "slack",
            "display_name": "スバル",
            "avatar_url": "https://slack-edge.com/.../192.png",
            "user_id": "U0A9ELR53R8",
        }
        params = CreateTaskParams(
            prompt="next message",
            agent_session_id=existing.agent_session_id,
            caller_info=new_caller,
        )

        await factory.create_or_resume(params)

        # task.caller_info 인메모리 갱신 (R-2 보존)
        assert existing.caller_info == new_caller
        # DB metadata에 caller_info entry append (R-6 신규)
        assert db.append_metadata.call_count == 1
        call_args = db.append_metadata.call_args
        assert call_args.args[0] == existing.agent_session_id
        entry = call_args.args[1]
        assert entry["type"] == "caller_info"
        assert entry["value"] == new_caller

    @pytest.mark.asyncio
    async def test_resume_with_identity_agent_source_only_appends(self):
        """T-G20-A4: agent source-only(IDENTITY_BEARING_SOURCES) → identity로 취급, append 발동."""
        existing = _make_existing_task(prior_caller_info=None)
        db = _make_db_mock(prior_metadata=[])
        factory, _, _ = _make_factory(existing_task=existing, db=db)

        new_caller = {"source": "agent"}
        params = CreateTaskParams(
            prompt="next",
            agent_session_id=existing.agent_session_id,
            caller_info=new_caller,
        )

        await factory.create_or_resume(params)

        assert existing.caller_info == new_caller
        assert db.append_metadata.call_count == 1
        assert db.append_metadata.call_args.args[1]["value"] == new_caller

    @pytest.mark.asyncio
    async def test_resume_with_no_identity_browser_skips_append(self):
        """T-G20-A2: caller_info(browser + ip만, identity 부재) → R-2 graceful 보존:
        task.caller_info 미갱신 + metadata append 미발동."""
        prior = {
            "source": "slack",
            "display_name": "PriorIdentity",
        }
        existing = _make_existing_task(prior_caller_info=prior)
        db = _make_db_mock(prior_metadata=[])
        factory, _, _ = _make_factory(existing_task=existing, db=db)

        empty_caller = {"source": "browser", "ip": "127.0.0.1"}
        params = CreateTaskParams(
            prompt="next",
            agent_session_id=existing.agent_session_id,
            caller_info=empty_caller,
        )

        await factory.create_or_resume(params)

        # R-2 G-3 회귀 보존 — task.caller_info 미갱신
        assert existing.caller_info == prior
        # R-6 신규 — _has_identity 미통과 시 append 미발동
        assert db.append_metadata.call_count == 0

    @pytest.mark.asyncio
    async def test_resume_with_caller_info_none_skips_append(self):
        """T-G20-A3: caller_info=None → graceful, append 미발동 (외부 호출자 의도 표명 없음)."""
        prior = {"source": "slack", "display_name": "Prior"}
        existing = _make_existing_task(prior_caller_info=prior)
        db = _make_db_mock(prior_metadata=[])
        factory, _, _ = _make_factory(existing_task=existing, db=db)

        params = CreateTaskParams(
            prompt="next",
            agent_session_id=existing.agent_session_id,
            caller_info=None,
        )

        await factory.create_or_resume(params)

        # task.caller_info 미갱신 + append 미발동
        assert existing.caller_info == prior
        assert db.append_metadata.call_count == 0

    @pytest.mark.asyncio
    async def test_resume_appended_entry_value_preserves_all_keys(self):
        """T-G20-A5: append되는 entry value가 caller_info 통합 v1 전체 키를 보존
        (스키마 손실 없음 — `extract_caller_info_from_metadata`가 *그대로* 재구성 가능)."""
        existing = _make_existing_task(prior_caller_info=None)
        db = _make_db_mock(prior_metadata=[])
        factory, _, _ = _make_factory(existing_task=existing, db=db)

        new_caller = {
            "source": "slack",
            "display_name": "スバル",
            "user_id": "U0A9ELR53R8",
            "avatar_url": "https://slack-edge.com/.../192.png",
            "bot_name": "seosoyoung",
            "slack": {
                "channel_id": "C0A9CKUH77Y",
                "user_id": "U0A9ELR53R8",
                "thread_ts": "1776598846.205369",
            },
        }
        params = CreateTaskParams(
            prompt="next",
            agent_session_id=existing.agent_session_id,
            caller_info=new_caller,
        )

        await factory.create_or_resume(params)

        entry = db.append_metadata.call_args.args[1]
        # 모든 키 보존 (스키마 손실 없음)
        assert entry["value"] == new_caller
        assert entry["value"]["slack"]["channel_id"] == "C0A9CKUH77Y"

    @pytest.mark.asyncio
    async def test_resume_task_metadata_in_memory_also_appended(self):
        """task.metadata 인메모리 array에도 같은 entry append (§9 대칭 — DB와 인메모리 정합).

        `_register_new_session_async`(L289-291) 패턴 그대로:
            task.metadata.append(entry)
            await self._db.append_metadata(...)
        둘 다 발생해야 caller_info entry가 호출자 코드에서 즉시 가시.
        """
        existing = _make_existing_task(prior_caller_info=None)
        # 기존 metadata에 1개 entry 있다고 가정 (caller_info와 무관한 type)
        existing.metadata = [{"type": "other", "value": "x"}]
        db = _make_db_mock(prior_metadata=existing.metadata)
        factory, _, _ = _make_factory(existing_task=existing, db=db)

        new_caller = {"source": "slack", "display_name": "スバル"}
        params = CreateTaskParams(
            prompt="next",
            agent_session_id=existing.agent_session_id,
            caller_info=new_caller,
        )

        await factory.create_or_resume(params)

        # task.metadata 인메모리에도 caller_info entry append
        caller_info_entries = [m for m in existing.metadata if m.get("type") == "caller_info"]
        assert len(caller_info_entries) == 1
        assert caller_info_entries[0]["value"] == new_caller
