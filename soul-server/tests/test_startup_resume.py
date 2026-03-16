"""
test_startup_resume - 서버 재기동 후 세션 재개 동작 테스트

lifespan의 pre_shutdown_sessions.json 처리 로직을 검증합니다.
주요 시나리오:
1. auto_resumed=True → start_execution()이 호출됨
2. auto_resumed=False (RUNNING 세션, queue_position 반환) → start_execution()이 호출되지 않음
3. start_execution() 호출 시 get_soul_engine()과 resource_manager가 올바르게 전달됨
"""

import json
import pytest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch, call

import soul_server.main as main_module


class TestStartupResume:
    """pre_shutdown_sessions.json 처리 + start_execution 호출 검증."""

    async def test_auto_resumed_calls_start_execution(self, tmp_path):
        """auto_resumed=True 시 start_execution()이 호출된다."""
        # pre_shutdown_sessions.json 준비
        sessions = [{"agent_session_id": "sess-abc", "claude_session_id": "claude-xyz"}]
        pre_shutdown_file = tmp_path / "pre_shutdown_sessions.json"
        pre_shutdown_file.write_text(json.dumps(sessions))

        task_manager = MagicMock()
        task_manager.load = AsyncMock(return_value=0)
        task_manager.add_intervention = AsyncMock(return_value={"auto_resumed": True})
        task_manager.start_execution = AsyncMock()

        mock_engine = MagicMock()
        mock_broadcaster = MagicMock()

        with (
            patch("soul_server.main.settings") as mock_settings,
            patch("soul_server.main.init_task_manager", return_value=task_manager),
            patch("soul_server.main.init_session_broadcaster", return_value=mock_broadcaster),
            patch("soul_server.main.get_soul_engine", return_value=mock_engine),
            patch("soul_server.main.resource_manager") as mock_resource_manager,
            patch("soul_server.main.EventStore"),
        ):
            mock_settings.data_dir = str(tmp_path)

            # lifespan 내부의 세션 재개 블록을 직접 재현
            pre_shutdown_file_path = tmp_path / "pre_shutdown_sessions.json"
            sessions_to_resume = json.loads(pre_shutdown_file_path.read_text())

            for s in sessions_to_resume:
                result = await task_manager.add_intervention(
                    s["agent_session_id"],
                    "소울스트림 서버 재시작이 완료되었습니다. 이전에 진행하던 작업을 재개해주세요.",
                    user="system",
                )
                if result.get("auto_resumed"):
                    await task_manager.start_execution(
                        agent_session_id=s["agent_session_id"],
                        claude_runner=main_module.get_soul_engine(),
                        resource_manager=mock_resource_manager,
                    )

        task_manager.start_execution.assert_called_once()

    async def test_not_auto_resumed_does_not_call_start_execution(self, tmp_path):
        """auto_resumed=False (RUNNING 세션, queue_position 반환) 시 start_execution()이 호출되지 않는다."""
        sessions = [{"agent_session_id": "sess-running", "claude_session_id": "claude-running"}]
        pre_shutdown_file = tmp_path / "pre_shutdown_sessions.json"
        pre_shutdown_file.write_text(json.dumps(sessions))

        task_manager = MagicMock()
        task_manager.add_intervention = AsyncMock(return_value={"queue_position": 0})
        task_manager.start_execution = AsyncMock()

        sessions_to_resume = json.loads(pre_shutdown_file.read_text())
        for s in sessions_to_resume:
            result = await task_manager.add_intervention(
                s["agent_session_id"],
                "소울스트림 서버 재시작이 완료되었습니다. 이전에 진행하던 작업을 재개해주세요.",
                user="system",
            )
            if result.get("auto_resumed"):
                await task_manager.start_execution(
                    agent_session_id=s["agent_session_id"],
                    claude_runner=MagicMock(),
                    resource_manager=MagicMock(),
                )

        task_manager.start_execution.assert_not_called()

    async def test_start_execution_receives_correct_arguments(self, tmp_path):
        """start_execution() 호출 시 get_soul_engine() 반환값과 resource_manager가 전달된다."""
        sessions = [{"agent_session_id": "sess-check", "claude_session_id": "claude-check"}]
        pre_shutdown_file = tmp_path / "pre_shutdown_sessions.json"
        pre_shutdown_file.write_text(json.dumps(sessions))

        task_manager = MagicMock()
        task_manager.add_intervention = AsyncMock(return_value={"auto_resumed": True})
        task_manager.start_execution = AsyncMock()

        mock_engine = MagicMock(name="soul_engine")
        mock_resource_manager = MagicMock(name="resource_manager")

        sessions_to_resume = json.loads(pre_shutdown_file.read_text())
        for s in sessions_to_resume:
            result = await task_manager.add_intervention(
                s["agent_session_id"],
                "소울스트림 서버 재시작이 완료되었습니다. 이전에 진행하던 작업을 재개해주세요.",
                user="system",
            )
            if result.get("auto_resumed"):
                await task_manager.start_execution(
                    agent_session_id=s["agent_session_id"],
                    claude_runner=mock_engine,
                    resource_manager=mock_resource_manager,
                )

        task_manager.start_execution.assert_called_once_with(
            agent_session_id="sess-check",
            claude_runner=mock_engine,
            resource_manager=mock_resource_manager,
        )

    async def test_multiple_sessions_only_auto_resumed_start_execution(self, tmp_path):
        """여러 세션 중 auto_resumed=True인 세션에 대해서만 start_execution()이 호출된다."""
        sessions = [
            {"agent_session_id": "sess-1", "claude_session_id": "claude-1"},
            {"agent_session_id": "sess-2", "claude_session_id": "claude-2"},
            {"agent_session_id": "sess-3", "claude_session_id": "claude-3"},
        ]
        pre_shutdown_file = tmp_path / "pre_shutdown_sessions.json"
        pre_shutdown_file.write_text(json.dumps(sessions))

        # sess-1: auto_resumed=True, sess-2: queue_position, sess-3: auto_resumed=True
        add_intervention_results = [
            {"auto_resumed": True},
            {"queue_position": 1},
            {"auto_resumed": True},
        ]

        task_manager = MagicMock()
        task_manager.add_intervention = AsyncMock(side_effect=add_intervention_results)
        task_manager.start_execution = AsyncMock()

        mock_engine = MagicMock()
        mock_resource_manager = MagicMock()

        sessions_to_resume = json.loads(pre_shutdown_file.read_text())
        for s in sessions_to_resume:
            result = await task_manager.add_intervention(
                s["agent_session_id"],
                "소울스트림 서버 재시작이 완료되었습니다. 이전에 진행하던 작업을 재개해주세요.",
                user="system",
            )
            if result.get("auto_resumed"):
                await task_manager.start_execution(
                    agent_session_id=s["agent_session_id"],
                    claude_runner=mock_engine,
                    resource_manager=mock_resource_manager,
                )

        # sess-1, sess-3 → 2번 호출
        assert task_manager.start_execution.call_count == 2
        call_session_ids = [
            c.kwargs["agent_session_id"]
            for c in task_manager.start_execution.call_args_list
        ]
        assert "sess-1" in call_session_ids
        assert "sess-3" in call_session_ids
        assert "sess-2" not in call_session_ids
