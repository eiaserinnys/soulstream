"""ExecutionContextBuilder 단위 테스트

TaskExecutor._prepare_context의 책임을 추출한 ExecutionContextBuilder를
독립적으로 검증한다 (260505 분해 시리즈 3단계).

테스트 케이스:
  1. test_no_db_returns_empty_folder
  2. test_no_session_row_returns_empty_folder
  3. test_no_folder_id_returns_empty_folder
  4. test_folder_prompt_prepended_to_system_prompt
  5. test_resume_skips_folder_prompt
  6. test_atom_context_fetched_for_new_session
  7. test_atom_context_skipped_for_resume
  8. test_profile_resolved_from_registry
  9. test_task_tools_override_profile_tools
  10. test_oauth_token_emits_extra_env
  11. test_assembled_prompt_uses_task_prompt_and_context
"""
from pathlib import Path
from typing import Optional
from unittest.mock import AsyncMock, MagicMock

import pytest

from soul_server.service.execution_context_builder import (
    ExecutionContextBuilder,
    _PreparedContext,
)
from soul_server.service.task_models import Task


# ── Helpers ──────────────────────────────────────────────────


def _make_task(
    session_id: str = "test-session",
    resume_session_id: Optional[str] = None,
    prompt: str = "test prompt",
    system_prompt: Optional[str] = None,
    profile_id: Optional[str] = None,
    allowed_tools: Optional[list] = None,
    disallowed_tools: Optional[list] = None,
    context_items: Optional[list] = None,
    caller_info: Optional[dict] = None,
    oauth_token: Optional[str] = None,
    context: Optional[dict] = None,
) -> Task:
    t = Task(agent_session_id=session_id, prompt=prompt)
    t.resume_session_id = resume_session_id
    t.system_prompt = system_prompt
    t.profile_id = profile_id
    t.allowed_tools = allowed_tools
    t.disallowed_tools = disallowed_tools
    t.context_items = context_items
    t.caller_info = caller_info
    t.oauth_token = oauth_token
    t.context = context
    return t


def _make_db(
    *,
    session_row=None,
    folder_row=None,
) -> MagicMock:
    db = MagicMock()
    db.get_session = AsyncMock(return_value=session_row)
    db.get_folder = AsyncMock(return_value=folder_row)
    return db


def _make_runner(workspace_dir: str = "/runner/ws") -> MagicMock:
    runner = MagicMock()
    runner.workspace_dir = workspace_dir
    return runner


# ── Tests ────────────────────────────────────────────────────


class TestResolveFolder:
    """_resolve_folder 단락 분기 검증."""

    @pytest.mark.asyncio
    async def test_no_db_returns_empty_folder(self):
        """session_db=None이면 folder lookup 자체를 건너뛴다."""
        builder = ExecutionContextBuilder(session_db=None, agent_registry=None)
        task = _make_task()
        ctx = await builder.build(task, _make_runner())
        assert ctx.folder_name is None
        assert ctx.effective_system_prompt is None  # folder_prompt 미적용

    @pytest.mark.asyncio
    async def test_no_session_row_returns_empty_folder(self):
        """get_session이 None을 반환하면 folder lookup 단락."""
        db = _make_db(session_row=None)
        builder = ExecutionContextBuilder(session_db=db, agent_registry=None)
        task = _make_task()
        ctx = await builder.build(task, _make_runner())
        assert ctx.folder_name is None
        db.get_folder.assert_not_called()

    @pytest.mark.asyncio
    async def test_no_folder_id_returns_empty_folder(self):
        """session_row에 folder_id가 없으면 단락."""
        db = _make_db(session_row={"folder_id": None}, folder_row=None)
        builder = ExecutionContextBuilder(session_db=db, agent_registry=None)
        task = _make_task()
        ctx = await builder.build(task, _make_runner())
        assert ctx.folder_name is None
        db.get_folder.assert_not_called()

    @pytest.mark.asyncio
    async def test_no_folder_row_returns_empty_folder(self):
        """get_folder가 None이면 folder_name/folder_prompt 모두 None."""
        db = _make_db(
            session_row={"folder_id": "missing-folder"},
            folder_row=None,
        )
        builder = ExecutionContextBuilder(session_db=db, agent_registry=None)
        task = _make_task(system_prompt="SYS")
        ctx = await builder.build(task, _make_runner())
        # get_folder는 호출되지만 None을 반환하므로 folder 정보 없음
        db.get_folder.assert_called_once_with("missing-folder")
        assert ctx.folder_name is None
        # folder_prompt 미적용 — task.system_prompt 그대로
        assert ctx.effective_system_prompt == "SYS"


class TestFolderPromptPrepend:
    """_assemble_context의 folder_prompt 합산 분기."""

    @pytest.mark.asyncio
    async def test_folder_prompt_prepended_to_system_prompt(self):
        """new session + folder_prompt + task.system_prompt → folder_prompt + \\n\\n + system_prompt."""
        db = _make_db(
            session_row={"folder_id": "f1"},
            folder_row={
                "name": "Folder",
                "settings": {"folderPrompt": "FOLDER_PRE"},
            },
        )
        builder = ExecutionContextBuilder(session_db=db, agent_registry=None)
        task = _make_task(system_prompt="SYS_BASE")
        ctx = await builder.build(task, _make_runner())
        assert ctx.effective_system_prompt == "FOLDER_PRE\n\nSYS_BASE"
        assert ctx.folder_name == "Folder"

    @pytest.mark.asyncio
    async def test_resume_skips_folder_prompt(self):
        """resume_session_id가 있으면 folder_prompt 미적용."""
        db = _make_db(
            session_row={"folder_id": "f1"},
            folder_row={
                "name": "Folder",
                "settings": {"folderPrompt": "FOLDER_PRE"},
            },
        )
        builder = ExecutionContextBuilder(session_db=db, agent_registry=None)
        task = _make_task(resume_session_id="claude-prev", system_prompt="SYS_BASE")
        ctx = await builder.build(task, _make_runner())
        # folder_name은 새 세션 여부와 무관 — folder_row가 존재하면 set
        assert ctx.folder_name == "Folder"
        # folder_prompt는 새 세션에서만 prepend
        assert ctx.effective_system_prompt == "SYS_BASE"


class TestAtomContextFetch:
    """_fetch_atom_context의 monkeypatch 가능성 + resume 단락."""

    @pytest.mark.asyncio
    async def test_atom_context_fetched_for_new_session(self, monkeypatch):
        """new session + atomContextNode → fetch_atom_context 호출, atom_context_items가 combined에 포함."""
        fetch_mock = AsyncMock(return_value="# atom md")
        monkeypatch.setattr(
            "soul_server.service.execution_context_builder.fetch_atom_context",
            fetch_mock,
        )
        db = _make_db(
            session_row={"folder_id": "f1"},
            folder_row={
                "name": "Folder",
                "settings": {
                    "atomContextNode": {"nodeId": "node-abc", "depth": 5, "titlesOnly": True},
                },
            },
        )
        builder = ExecutionContextBuilder(session_db=db, agent_registry=None)
        task = _make_task()
        ctx = await builder.build(task, _make_runner())
        fetch_mock.assert_awaited_once_with(
            node_id="node-abc", depth=5, titles_only=True
        )
        atom_items = [it for it in ctx.combined_context_items if it.get("key") == "atom_context"]
        assert len(atom_items) == 1
        assert atom_items[0]["content"] == "# atom md"
        assert atom_items[0]["label"] == "atom 트리"

    @pytest.mark.asyncio
    async def test_atom_context_skipped_for_resume(self, monkeypatch):
        """resume session이면 fetch_atom_context 미호출, atom_context_items 비어 있음."""
        fetch_mock = AsyncMock(return_value="should-not-be-used")
        monkeypatch.setattr(
            "soul_server.service.execution_context_builder.fetch_atom_context",
            fetch_mock,
        )
        db = _make_db(
            session_row={"folder_id": "f1"},
            folder_row={
                "name": "Folder",
                "settings": {
                    "atomContextNode": {"nodeId": "node-abc"},
                },
            },
        )
        builder = ExecutionContextBuilder(session_db=db, agent_registry=None)
        task = _make_task(resume_session_id="claude-prev")
        ctx = await builder.build(task, _make_runner())
        fetch_mock.assert_not_awaited()
        atom_items = [it for it in ctx.combined_context_items if it.get("key") == "atom_context"]
        assert atom_items == []


class TestResolveProfile:
    """_resolve_profile의 4-tuple 반환 검증."""

    @pytest.mark.asyncio
    async def test_profile_resolved_from_registry(self):
        """profile_id + registry → profile.workspace_dir/max_turns/allowed_tools/disallowed_tools 반영."""
        profile = MagicMock()
        profile.workspace_dir = Path("/profile/ws")
        profile.max_turns = 7
        profile.allowed_tools = ["Read", "Edit"]
        profile.disallowed_tools = ["Bash"]
        registry = MagicMock()
        registry.get = MagicMock(return_value=profile)

        builder = ExecutionContextBuilder(session_db=None, agent_registry=registry)
        task = _make_task(profile_id="my-profile")
        ctx = await builder.build(task, _make_runner())

        registry.get.assert_called_once_with("my-profile")
        assert ctx.working_dir == Path("/profile/ws")
        assert ctx.max_turns == 7
        # task.allowed_tools=None이므로 profile 설정 반영
        assert ctx.effective_allowed_tools == ["Read", "Edit"]
        assert ctx.effective_disallowed_tools == ["Bash"]

    @pytest.mark.asyncio
    async def test_task_tools_override_profile_tools(self):
        """task.allowed_tools가 not None이면 profile.allowed_tools 무시."""
        profile = MagicMock()
        profile.workspace_dir = None
        profile.max_turns = None
        profile.allowed_tools = ["Read"]
        profile.disallowed_tools = ["Bash"]
        registry = MagicMock()
        registry.get = MagicMock(return_value=profile)

        builder = ExecutionContextBuilder(session_db=None, agent_registry=registry)
        task = _make_task(
            profile_id="my-profile",
            allowed_tools=["Edit", "Write"],
            disallowed_tools=[],
        )
        ctx = await builder.build(task, _make_runner())

        assert ctx.effective_allowed_tools == ["Edit", "Write"]
        # task.disallowed_tools=[] (빈 리스트)도 not None이므로 우선
        assert ctx.effective_disallowed_tools == []


class TestExtraEnvAndPrompt:
    """oauth_token, assemble_prompt 검증."""

    @pytest.mark.asyncio
    async def test_oauth_token_emits_extra_env(self):
        """task.oauth_token 있으면 extra_env에 CLAUDE_CODE_OAUTH_TOKEN 주입."""
        builder = ExecutionContextBuilder(session_db=None, agent_registry=None)
        task = _make_task(oauth_token="sk-token-xyz")
        ctx = await builder.build(task, _make_runner())
        assert ctx.extra_env == {"CLAUDE_CODE_OAUTH_TOKEN": "sk-token-xyz"}

    @pytest.mark.asyncio
    async def test_oauth_token_absent_emits_none_env(self):
        """task.oauth_token이 None/빈 문자열이면 extra_env=None."""
        builder = ExecutionContextBuilder(session_db=None, agent_registry=None)
        task = _make_task(oauth_token=None)
        ctx = await builder.build(task, _make_runner())
        assert ctx.extra_env is None

    @pytest.mark.asyncio
    async def test_assembled_prompt_uses_task_prompt_and_context(self, monkeypatch):
        """assemble_prompt(task.prompt, task.context) 호출 검증 + 결과가 ctx.assembled_prompt에 반영."""
        spy = MagicMock(return_value="ASSEMBLED")
        monkeypatch.setattr(
            "soul_server.service.execution_context_builder.assemble_prompt",
            spy,
        )
        builder = ExecutionContextBuilder(session_db=None, agent_registry=None)
        task = _make_task(
            prompt="raw prompt",
            context={"key": "value"},
        )
        ctx = await builder.build(task, _make_runner())
        spy.assert_called_once_with("raw prompt", {"key": "value"})
        assert ctx.assembled_prompt == "ASSEMBLED"


class TestCombinedContextItems:
    """soulstream_item + atom_items + task.context_items 합산 순서."""

    @pytest.mark.asyncio
    async def test_combined_order_soulstream_atom_task(self, monkeypatch):
        """순서: [soulstream_item, atom_item, *task.context_items]."""
        monkeypatch.setattr(
            "soul_server.service.execution_context_builder.fetch_atom_context",
            AsyncMock(return_value="atom-md"),
        )
        # soulstream_item을 단순 dict로 mock
        monkeypatch.setattr(
            "soul_server.service.execution_context_builder.build_soulstream_context_item",
            lambda **kwargs: {"key": "soulstream", "label": "ss", "content": "ss-content"},
        )
        db = _make_db(
            session_row={"folder_id": "f1"},
            folder_row={
                "name": "F",
                "settings": {"atomContextNode": {"nodeId": "n1"}},
            },
        )
        builder = ExecutionContextBuilder(session_db=db, agent_registry=None)
        task = _make_task(context_items=[{"key": "user", "label": "User", "content": "u"}])
        ctx = await builder.build(task, _make_runner())

        assert [it["key"] for it in ctx.combined_context_items] == [
            "soulstream",
            "atom_context",
            "user",
        ]
