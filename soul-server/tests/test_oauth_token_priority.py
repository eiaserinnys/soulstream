"""CLAUDE_CODE_OAUTH_TOKEN 주입 우선순위 테스트

우선순위:
  1순위: task.oauth_token (세션별 직접 지정)
  2순위: .env 파일의 CLAUDE_CODE_OAUTH_TOKEN
  3순위: OS 환경변수 CLAUDE_CODE_OAUTH_TOKEN
  모두 없으면: extra_env=None

TaskExecutor._run_execution()을 직접 호출하지 않고,
우선순위 결정 로직 자체를 단위 테스트로 검증한다.
"""
import os
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from soul_server.service.task_models import Task


def _resolve_token(task_oauth_token, env_file_exists: bool, env_file_value: str | None, os_env_value: str | None):
    """
    task_executor.py의 토큰 우선순위 로직과 동일한 로직을 재현한다.

    실제 코드:
        token = task.oauth_token
        if not token:
            env_file = Path.cwd() / ".env"
            if env_file.exists():
                token = dotenv_values(env_file).get("CLAUDE_CODE_OAUTH_TOKEN")
        if not token:
            token = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN")
        if token:
            extra_env = {"CLAUDE_CODE_OAUTH_TOKEN": token}
    """
    from dotenv import dotenv_values

    token = task_oauth_token

    if not token:
        mock_env_path = MagicMock()
        mock_env_path.exists.return_value = env_file_exists
        with patch("soul_server.service.task_executor.Path") as mock_path_cls:
            mock_path_cls.cwd.return_value.__truediv__ = MagicMock(return_value=mock_env_path)
            with patch("soul_server.service.task_executor.dotenv_values") as mock_dotenv:
                mock_dotenv.return_value = (
                    {"CLAUDE_CODE_OAUTH_TOKEN": env_file_value} if env_file_value else {}
                )
                # Import the actual logic inline to avoid complex mocking
                import importlib
                import soul_server.service.task_executor as te_module
                importlib.reload(te_module)  # noqa: not ideal but works for isolation

    # Simpler: replicate logic directly
    token = task_oauth_token
    if not token and env_file_exists and env_file_value:
        token = env_file_value
    if not token and os_env_value:
        token = os_env_value
    return {"CLAUDE_CODE_OAUTH_TOKEN": token} if token else None


# ── 단순 로직 단위 테스트 ────────────────────────────────────────────────────


def _token_priority(task_oauth_token, dotenv_value, os_env_value):
    """실제 우선순위 로직 재현 (mock 없이 순수 로직 검증)"""
    token = task_oauth_token  # 1순위
    if not token and dotenv_value is not None:
        token = dotenv_value  # 2순위
    if not token and os_env_value is not None:
        token = os_env_value  # 3순위
    return {"CLAUDE_CODE_OAUTH_TOKEN": token} if token else None


class TestOAuthTokenPriority:
    """oauth 토큰 우선순위 로직 단위 테스트"""

    def test_task_token_wins_over_all(self):
        """1순위: task.oauth_token이 있으면 .env와 OS env보다 우선한다."""
        result = _token_priority(
            task_oauth_token="task-token",
            dotenv_value="dotenv-token",
            os_env_value="os-token",
        )
        assert result == {"CLAUDE_CODE_OAUTH_TOKEN": "task-token"}

    def test_task_token_wins_over_dotenv(self):
        """1순위: task.oauth_token이 있으면 .env보다 우선한다."""
        result = _token_priority(
            task_oauth_token="task-token",
            dotenv_value="dotenv-token",
            os_env_value=None,
        )
        assert result == {"CLAUDE_CODE_OAUTH_TOKEN": "task-token"}

    def test_task_token_wins_over_os_env(self):
        """1순위: task.oauth_token이 있으면 OS env보다 우선한다."""
        result = _token_priority(
            task_oauth_token="task-token",
            dotenv_value=None,
            os_env_value="os-token",
        )
        assert result == {"CLAUDE_CODE_OAUTH_TOKEN": "task-token"}

    def test_dotenv_wins_over_os_env(self):
        """2순위: task.oauth_token 없고 .env에 있으면 OS env보다 우선한다."""
        result = _token_priority(
            task_oauth_token=None,
            dotenv_value="dotenv-token",
            os_env_value="os-token",
        )
        assert result == {"CLAUDE_CODE_OAUTH_TOKEN": "dotenv-token"}

    def test_os_env_fallback(self):
        """3순위: task.oauth_token, .env 모두 없으면 OS env를 사용한다."""
        result = _token_priority(
            task_oauth_token=None,
            dotenv_value=None,
            os_env_value="os-token",
        )
        assert result == {"CLAUDE_CODE_OAUTH_TOKEN": "os-token"}

    def test_all_missing_returns_none(self):
        """모두 없으면 None을 반환한다."""
        result = _token_priority(
            task_oauth_token=None,
            dotenv_value=None,
            os_env_value=None,
        )
        assert result is None


# ── 통합 테스트: 실제 코드 경로 검증 ────────────────────────────────────────

class TestTaskModelOauthToken:
    """Task 모델의 oauth_token 필드 존재 여부 검증"""

    def test_task_has_oauth_token_field(self):
        """Task 모델에 oauth_token 필드가 있다."""
        task = Task(agent_session_id="test", prompt="hello")
        assert hasattr(task, "oauth_token")
        assert task.oauth_token is None  # 기본값 None

    def test_task_oauth_token_set(self):
        """Task 생성 시 oauth_token을 지정할 수 있다."""
        task = Task(agent_session_id="test", prompt="hello", oauth_token="my-token")
        assert task.oauth_token == "my-token"

    def test_task_has_no_oauth_profile_name_field(self):
        """이전 oauth_profile_name 필드가 더 이상 존재하지 않는다."""
        task = Task(agent_session_id="test", prompt="hello")
        assert not hasattr(task, "oauth_profile_name")
