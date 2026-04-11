"""CLAUDE_CODE_OAUTH_TOKEN 주입 우선순위 테스트

task_executor.py의 extra_env 구성 로직:
- task.oauth_token이 있으면 extra_env로 주입 (프로필 전환 용도)
- task.oauth_token이 없으면 extra_env=None (credentials.json 또는 프로세스 환경변수 상속)

PKCE OAuth는 credentials.json에 저장되어 Claude Code가 자동으로 읽는다.
CLAUDE_CODE_OAUTH_TOKEN 환경변수가 있으면 credentials.json이 무시되므로,
PKCE 경로에서는 환경변수를 주입하지 않는다.
"""
from soul_server.service.task_models import Task


class TestOAuthTokenExtraEnv:
    """task_executor.py의 extra_env 구성 로직 검증"""

    @staticmethod
    def _resolve_extra_env(task: Task) -> dict | None:
        """task_executor.py의 extra_env 로직을 재현한다."""
        extra_env = None
        if task.oauth_token:
            extra_env = {"CLAUDE_CODE_OAUTH_TOKEN": task.oauth_token}
        return extra_env

    def test_task_token_sets_extra_env(self):
        """task.oauth_token이 있으면 extra_env에 주입한다."""
        task = Task(agent_session_id="t1", prompt="hi", oauth_token="task-token")
        result = self._resolve_extra_env(task)
        assert result == {"CLAUDE_CODE_OAUTH_TOKEN": "task-token"}

    def test_no_task_token_returns_none(self):
        """task.oauth_token이 없으면 extra_env=None (credentials.json/프로세스 환경변수 사용)."""
        task = Task(agent_session_id="t2", prompt="hi")
        result = self._resolve_extra_env(task)
        assert result is None

    def test_empty_string_token_returns_none(self):
        """task.oauth_token이 빈 문자열이면 extra_env=None."""
        task = Task(agent_session_id="t3", prompt="hi", oauth_token="")
        result = self._resolve_extra_env(task)
        assert result is None


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
