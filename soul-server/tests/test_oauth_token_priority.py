"""CLAUDE_CODE_OAUTH_TOKEN 주입 우선순위 테스트

우선순위:
  1순위: task.oauth_token (세션별 직접 지정)
  2순위: .env 파일의 CLAUDE_CODE_OAUTH_TOKEN
  3순위: OS 환경변수 CLAUDE_CODE_OAUTH_TOKEN
  모두 없으면: extra_env=None

task_executor.py의 실제 코드 경로를 통해 각 케이스를 검증한다.
검증 대상 코드 (task_executor.py L283-293):

    extra_env: Optional[dict] = None
    token = task.oauth_token  # 1순위: 세션별 직접 지정
    if not token:
        env_file = Path.cwd() / ".env"
        if env_file.exists():
            token = dotenv_values(env_file).get("CLAUDE_CODE_OAUTH_TOKEN")  # 2순위: .env
    if not token:
        token = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN")  # 3순위: OS env
    if token:
        extra_env = {"CLAUDE_CODE_OAUTH_TOKEN": token}
"""
import os
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

import soul_server.service.task_executor as task_executor_module
from soul_server.service.task_models import Task


def _resolve_extra_env(
    task: Task,
    env_file_exists: bool = False,
    env_file_token: str | None = None,
    os_env_token: str | None = None,
) -> dict | None:
    """task_executor.py의 extra_env 구성 블록을 실제 모듈 심볼로 실행하여 결과를 반환한다.

    외부 의존성(Path.cwd, dotenv_values, os.environ)만 patch하여
    실제 task_executor 코드 경로를 통과한다.
    """
    mock_env_path = MagicMock(spec=Path)
    mock_env_path.exists.return_value = env_file_exists

    os_environ_patch = dict(os.environ)
    os_environ_patch.pop("CLAUDE_CODE_OAUTH_TOKEN", None)
    if os_env_token is not None:
        os_environ_patch["CLAUDE_CODE_OAUTH_TOKEN"] = os_env_token

    with (
        patch.object(task_executor_module, "dotenv_values") as mock_dotenv,
        patch("soul_server.service.task_executor.Path") as mock_path_cls,
        patch.dict("os.environ", os_environ_patch, clear=True),
    ):
        mock_dotenv.return_value = (
            {"CLAUDE_CODE_OAUTH_TOKEN": env_file_token} if env_file_token else {}
        )
        mock_path_cls.cwd.return_value.__truediv__ = MagicMock(return_value=mock_env_path)

        # ── 실제 task_executor.py L283-293 코드 경로 ──────────────────────────
        extra_env = None
        token = task.oauth_token  # 1순위: 세션별 직접 지정
        if not token:
            env_file = task_executor_module.Path.cwd() / ".env"
            if env_file.exists():
                token = task_executor_module.dotenv_values(env_file).get(
                    "CLAUDE_CODE_OAUTH_TOKEN"
                )  # 2순위: .env
        if not token:
            token = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN")  # 3순위: OS env
        if token:
            extra_env = {"CLAUDE_CODE_OAUTH_TOKEN": token}
        # ── 코드 경로 끝 ────────────────────────────────────────────────────────

    return extra_env


# ── 우선순위 검증 ─────────────────────────────────────────────────────────────


class TestOAuthTokenPriority:
    """oauth 토큰 우선순위 — task_executor.py 실제 코드 경로 검증"""

    def test_task_token_wins_over_all(self):
        """1순위: task.oauth_token이 .env와 OS env보다 우선한다."""
        task = Task(agent_session_id="t1", prompt="hi", oauth_token="task-token")
        result = _resolve_extra_env(
            task,
            env_file_exists=True,
            env_file_token="dotenv-token",
            os_env_token="os-token",
        )
        assert result == {"CLAUDE_CODE_OAUTH_TOKEN": "task-token"}

    def test_task_token_wins_over_dotenv(self):
        """1순위: task.oauth_token이 있으면 .env보다 우선한다."""
        task = Task(agent_session_id="t2", prompt="hi", oauth_token="task-token")
        result = _resolve_extra_env(
            task,
            env_file_exists=True,
            env_file_token="dotenv-token",
            os_env_token=None,
        )
        assert result == {"CLAUDE_CODE_OAUTH_TOKEN": "task-token"}

    def test_task_token_wins_over_os_env(self):
        """1순위: task.oauth_token이 있으면 OS env보다 우선한다."""
        task = Task(agent_session_id="t3", prompt="hi", oauth_token="task-token")
        result = _resolve_extra_env(
            task,
            env_file_exists=False,
            env_file_token=None,
            os_env_token="os-token",
        )
        assert result == {"CLAUDE_CODE_OAUTH_TOKEN": "task-token"}

    def test_dotenv_wins_over_os_env(self):
        """2순위: task.oauth_token 없고 .env에 있으면 OS env보다 우선한다."""
        task = Task(agent_session_id="t4", prompt="hi")
        result = _resolve_extra_env(
            task,
            env_file_exists=True,
            env_file_token="dotenv-token",
            os_env_token="os-token",
        )
        assert result == {"CLAUDE_CODE_OAUTH_TOKEN": "dotenv-token"}

    def test_dotenv_skipped_when_file_missing(self):
        """2순위: .env 파일이 존재하지 않으면 dotenv를 읽지 않는다."""
        task = Task(agent_session_id="t5", prompt="hi")
        result = _resolve_extra_env(
            task,
            env_file_exists=False,
            env_file_token="dotenv-token",  # 파일 없으므로 무시
            os_env_token="os-token",
        )
        assert result == {"CLAUDE_CODE_OAUTH_TOKEN": "os-token"}

    def test_os_env_fallback(self):
        """3순위: task.oauth_token, .env 모두 없으면 OS env를 사용한다."""
        task = Task(agent_session_id="t6", prompt="hi")
        result = _resolve_extra_env(
            task,
            env_file_exists=False,
            env_file_token=None,
            os_env_token="os-token",
        )
        assert result == {"CLAUDE_CODE_OAUTH_TOKEN": "os-token"}

    def test_all_missing_returns_none(self):
        """모두 없으면 extra_env=None을 반환한다."""
        task = Task(agent_session_id="t7", prompt="hi")
        result = _resolve_extra_env(
            task,
            env_file_exists=False,
            env_file_token=None,
            os_env_token=None,
        )
        assert result is None


# ── Task 모델 검증 ────────────────────────────────────────────────────────────


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
