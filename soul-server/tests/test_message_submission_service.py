"""submit_message 정본(message_submission_service) 단위 테스트.

분기 의미:
- agent_session_id is None → kind='new_session' (신규 task 생성)
- agent_session_id + RUNNING → kind='intervened' (intervention queue 큐잉)
- agent_session_id + terminal → kind='auto_resumed' (기존 Claude 세션 resume)

핵심 검증:
- terminal 분기에서 task.resume_session_id가 기존 claude_session_id로 설정됨
- caller_info 운반 (running 큐잉 / 신규 task 모두)
- _notify_caller_completion 재귀 경로(add_intervention → submit_message)에서도 동일 정책 적용
"""

from unittest.mock import AsyncMock, MagicMock

import pytest

from soul_server.service.message_submission_service import (
    SubmitMessageParams,
    submit_message,
)
from soul_server.service.task_manager import TaskManager, set_task_manager
from soul_server.service.task_factory import CreateTaskParams
from soul_server.service.task_models import (
    TaskNotFoundError,
    TaskStatus,
)


def _make_mock_db():
    db = MagicMock()
    db._pool = AsyncMock()
    db.node_id = "test-node"
    db.register_session_initial = AsyncMock()
    db.set_claude_session_id = AsyncMock()
    db.update_session = AsyncMock()
    db.update_session_status = AsyncMock()
    db.get_session = AsyncMock(return_value=None)
    db.get_all_sessions = AsyncMock(return_value=([], 0))
    db.append_event = AsyncMock(return_value=1)
    db.read_events = AsyncMock(return_value=[])
    db.update_last_read_event_id = AsyncMock(return_value=True)
    db.get_read_position = AsyncMock(return_value=(0, 0))
    db.get_all_folders = AsyncMock(return_value=[
        {"id": "claude", "name": "⚙️ 클로드 코드 세션", "sort_order": 0},
    ])
    db.get_folder = AsyncMock(return_value={"id": "claude", "name": "⚙️ 클로드 코드 세션"})
    db.get_catalog = AsyncMock(return_value={"folders": [], "sessions": {}})
    db.get_default_folder = AsyncMock(return_value={"id": "claude", "name": "⚙️ 클로드 코드 세션"})
    db.assign_session_to_folder = AsyncMock()
    db.append_metadata = AsyncMock()
    db.DEFAULT_FOLDERS = {"claude": "⚙️ 클로드 코드 세션", "llm": "⚙️ LLM 세션"}
    return db


@pytest.fixture
def manager():
    m = TaskManager(session_db=_make_mock_db())
    yield m
    set_task_manager(None)


class TestSubmitMessageBranches:
    """submit_message의 3분기 동작."""

    async def test_new_session_when_agent_session_id_none(self, manager):
        """agent_session_id 미제공 → kind='new_session', 신규 task 반환."""
        result = await submit_message(
            SubmitMessageParams(prompt="hello", agent_session_id=None),
            task_manager=manager,
        )
        assert result.kind == "new_session"
        assert result.agent_session_id is not None
        assert result.task is not None
        assert result.task.status == TaskStatus.RUNNING
        # 신규 세션이라 resume_session_id 박지 않음 (skip_claude_resume 무관)
        assert result.task.resume_session_id is None

    async def test_intervened_when_running(self, manager):
        """RUNNING 세션 + agent_session_id → kind='intervened', intervention_queue 큐잉."""
        await manager.create_task(CreateTaskParams(prompt="first", agent_session_id="sess-1"))

        result = await submit_message(
            SubmitMessageParams(
                prompt="개입 메시지",
                agent_session_id="sess-1",
                user="user1",
            ),
            task_manager=manager,
        )
        assert result.kind == "intervened"
        assert result.agent_session_id == "sess-1"
        assert result.queue_position == 1
        # 큐에 메시지가 박혀 있는지 확인
        task = await manager.get_task("sess-1")
        msg = task.intervention_queue.get_nowait()
        assert msg["text"] == "개입 메시지"
        assert msg["user"] == "user1"

    async def test_auto_resumed_terminal_keeps_claude_resume(self, manager):
        """terminal(INTERRUPTED) 세션 + agent_session_id → kind='auto_resumed',
        task.resume_session_id에 기존 claude_session_id를 박는다.
        """
        await manager.create_task(CreateTaskParams(prompt="first", agent_session_id="sess-1"))
        await manager.register_session("claude-orig", "sess-1")

        # terminal 시뮬레이션
        task = await manager.get_task("sess-1")
        task.status = TaskStatus.INTERRUPTED

        result = await submit_message(
            SubmitMessageParams(prompt="후속 메시지", agent_session_id="sess-1"),
            task_manager=manager,
        )
        assert result.kind == "auto_resumed"
        assert result.agent_session_id == "sess-1"
        assert result.task.resume_session_id == "claude-orig"
        assert result.task.claude_session_id == "claude-orig"

    async def test_auto_resumed_from_completed_status(self, manager):
        """COMPLETED 세션도 기존 Claude 세션을 resume한다."""
        await manager.create_task(CreateTaskParams(prompt="first", agent_session_id="sess-2"))
        await manager.register_session("claude-c", "sess-2")
        await manager.finalize_task("sess-2", result="done")

        result = await submit_message(
            SubmitMessageParams(prompt="다시 시작", agent_session_id="sess-2"),
            task_manager=manager,
        )
        assert result.kind == "auto_resumed"
        assert result.task.resume_session_id == "claude-c"

    async def test_auto_resumed_from_error_status(self, manager):
        """ERROR 세션도 기존 Claude 세션을 resume한다."""
        await manager.create_task(CreateTaskParams(prompt="first", agent_session_id="sess-3"))
        await manager.register_session("claude-e", "sess-3")
        await manager.finalize_task("sess-3", error="crashed")

        result = await submit_message(
            SubmitMessageParams(prompt="재시도", agent_session_id="sess-3"),
            task_manager=manager,
        )
        assert result.kind == "auto_resumed"
        assert result.task.resume_session_id == "claude-e"

    async def test_task_not_found_raises(self, manager):
        """존재하지 않는 agent_session_id에 submit_message → TaskNotFoundError."""
        # _eviction_manager.load_evicted_task가 None 반환하도록 — 기본 mock이 그렇게 동작
        with pytest.raises(TaskNotFoundError):
            await submit_message(
                SubmitMessageParams(
                    prompt="없는 세션",
                    agent_session_id="sess-nonexistent",
                ),
                task_manager=manager,
            )

    async def test_preallocated_id_can_create_new_session_when_allowed(self, manager):
        """orch create_session은 미리 발급한 agent_session_id로 신규 세션을 생성한다."""
        result = await submit_message(
            SubmitMessageParams(
                prompt="새 upstream 세션",
                agent_session_id="orch-preallocated-id",
                profile_id="agent-X",
                allow_new_session_with_id=True,
            ),
            task_manager=manager,
        )

        assert result.kind == "new_session"
        assert result.agent_session_id == "orch-preallocated-id"
        assert result.task.agent_session_id == "orch-preallocated-id"
        assert result.task.profile_id == "agent-X"


class TestSubmitMessageCallerInfo:
    """caller_info 운반 검증 — 모든 분기에서 wire에 박힘."""

    async def test_intervened_caller_info_in_queue(self, manager):
        """running 큐잉 시 caller_info가 intervention_queue 메시지에 박힘."""
        await manager.create_task(CreateTaskParams(prompt="first", agent_session_id="sess-c1"))
        caller_info = {"source": "agent", "agent_id": "test", "display_name": "Test"}

        await submit_message(
            SubmitMessageParams(
                prompt="개입",
                agent_session_id="sess-c1",
                caller_info=caller_info,
            ),
            task_manager=manager,
        )
        task = await manager.get_task("sess-c1")
        msg = task.intervention_queue.get_nowait()
        assert msg["caller_info"] == caller_info

    async def test_auto_resumed_caller_info_on_task(self, manager):
        """terminal auto-resume 시 caller_info가 task.caller_info에 박힘."""
        await manager.create_task(CreateTaskParams(prompt="first", agent_session_id="sess-c2"))
        await manager.register_session("claude-c", "sess-c2")
        task = await manager.get_task("sess-c2")
        task.status = TaskStatus.INTERRUPTED

        caller_info = {"source": "slack", "display_name": "Slack User"}
        result = await submit_message(
            SubmitMessageParams(
                prompt="후속",
                agent_session_id="sess-c2",
                caller_info=caller_info,
            ),
            task_manager=manager,
        )
        assert result.task.caller_info == caller_info


class TestTerminalResumePreservesOptions:
    """카드 5RcnygV5: terminal 분기에서 model/allowed_tools 등 옵션이 forward되어야 한다.

    PR #69 이전 동작: terminal 재개 시 SubmitMessageParams의 model 등이 forward 안 됨 →
    task_factory._resume_existing_task_locked가 task 필드를 None으로 reset.
    본 카드 fix: 명시된 옵션이 CreateTaskParams로 forward되어 task에 박힘.
    """

    async def test_terminal_resume_preserves_model_and_tools(self, manager):
        """terminal 재개 시 model/allowed_tools/disallowed_tools/use_mcp/system_prompt가 보존된다."""
        await manager.create_task(CreateTaskParams(prompt="first", agent_session_id="sess-O"))
        await manager.register_session("claude-O", "sess-O")
        task = await manager.get_task("sess-O")
        task.status = TaskStatus.INTERRUPTED

        result = await submit_message(
            SubmitMessageParams(
                prompt="후속",
                agent_session_id="sess-O",
                model="claude-opus-4-5",
                allowed_tools=["Read", "Grep"],
                disallowed_tools=["Bash"],
                use_mcp=False,
                system_prompt="한국어로 답해",
            ),
            task_manager=manager,
        )
        assert result.kind == "auto_resumed"
        # ★ 핵심 — 옵션이 task에 박혔는지 (task_factory._resume_existing_task_locked가 덮어쓴 결과)
        assert result.task.model == "claude-opus-4-5"
        assert result.task.allowed_tools == ["Read", "Grep"]
        assert result.task.disallowed_tools == ["Bash"]
        assert result.task.use_mcp is False
        assert result.task.system_prompt == "한국어로 답해"

    async def test_terminal_resume_preserves_context_and_items(self, manager):
        """terminal 재개 시 context와 context_items가 forward되어 task에 박힌다.

        P1 (code-reviewer 2차 지적): context_items도 forward 대상. extra_ctx 분기와 별개.
        """
        await manager.create_task(CreateTaskParams(prompt="first", agent_session_id="sess-P"))
        await manager.register_session("claude-P", "sess-P")
        task = await manager.get_task("sess-P")
        task.status = TaskStatus.INTERRUPTED

        result = await submit_message(
            SubmitMessageParams(
                prompt="후속",
                agent_session_id="sess-P",
                context={"key": "value"},
                context_items=[{"key": "additional_ctx", "label": "ctx", "content": "x"}],
            ),
            task_manager=manager,
        )
        assert result.kind == "auto_resumed"
        assert result.task.context == {"key": "value"}
        # ★ P1 fix — context_items가 task.context_items로 forward됨
        assert result.task.context_items is not None
        assert any(item.get("key") == "additional_ctx" for item in result.task.context_items)

    async def test_terminal_resume_preserves_profile_and_folder(self, manager):
        """terminal 재개 시 profile_id가 forward되어 task.profile_id에 박힌다.

        folder_id는 _register_new_session_async에서만 처리되고 resume에서는 영향 없음 —
        본 케이스는 profile_id만 검증.
        """
        # registry 없이 profile_id 검증 시도하면 ValueError이므로, registry None 상태에서는
        # profile_id가 그대로 통과한다 (task_factory.create_or_resume L113-117).
        await manager.create_task(CreateTaskParams(prompt="first", agent_session_id="sess-PR"))
        await manager.register_session("claude-PR", "sess-PR")
        task = await manager.get_task("sess-PR")
        task.status = TaskStatus.INTERRUPTED

        result = await submit_message(
            SubmitMessageParams(
                prompt="후속",
                agent_session_id="sess-PR",
                profile_id="agent-X",
            ),
            task_manager=manager,
        )
        assert result.kind == "auto_resumed"
        # ★ profile_id가 task에 박힘 (resume_existing_task_locked L213-214 적용)
        assert result.task.profile_id == "agent-X"


class TestNotifyCallerCompletionRecursion:
    """_notify_caller_completion 재귀 경로 검증 (지적 4-2).

    자식 task의 finalize 시 caller_session_id로 add_intervention 재귀 호출 →
    add_intervention 내부에서 submit_message로 위임 → terminal caller 케이스에서도
    기존 Claude 세션을 resume한다.
    """

    async def test_caller_terminal_resumed_with_existing_claude_session(self, manager):
        """caller_session_id가 terminal 상태일 때 _notify_caller_completion 시
        caller task가 기존 Claude 세션으로 resumed된다.
        """
        # caller 세션 생성 → claude_session_id 등록 → terminal 상태로 전환
        await manager.create_task(
            CreateTaskParams(prompt="caller prompt", agent_session_id="caller-1")
        )
        await manager.register_session("claude-caller", "caller-1")
        caller_task = await manager.get_task("caller-1")
        caller_task.status = TaskStatus.COMPLETED

        # 자식 task 생성 → caller_session_id 박음 → finalize
        child = await manager.create_task(
            CreateTaskParams(
                prompt="child prompt",
                agent_session_id="child-1",
                caller_session_id="caller-1",
            )
        )

        # finalize → _notify_caller_completion 자동 호출
        # _notify_caller_completion 내부에서 add_intervention("caller-1") 호출
        # add_intervention → submit_message → caller task resume
        await manager.finalize_task("child-1", result="자식 완료")

        # caller가 resumed되었고, 기존 claude_session_id로 resume되는지 검증
        resumed_caller = await manager.get_task("caller-1")
        assert resumed_caller.status == TaskStatus.RUNNING
        assert resumed_caller.resume_session_id == "claude-caller"
        assert resumed_caller.claude_session_id == "claude-caller"
