"""
test_claude_auth_api - Claude Auth REST API 통합 테스트

FastAPI TestClient를 사용한 엔드포인트 통합 테스트.
실제 CLI 실행 없이 모킹을 통해 테스트합니다.
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# api/__init__.py를 통하지 않고 직접 임포트 (cogito 의존성 회피)
from soul_server.api.claude_auth.router import create_claude_auth_router
from soul_server.api.claude_auth.session import AuthSessionManager, SessionStatus
from soul_server.api.claude_auth.cli_runner import StartResult, SubmitResult, CliRunnerError
from soul_server.api.claude_auth.token_store import TOKEN_ENV_KEY


@pytest.fixture
def session_manager():
    """테스트용 세션 매니저"""
    return AuthSessionManager(timeout_seconds=60)


@pytest.fixture(autouse=True)
def cleanup_token_env():
    """테스트 전후 토큰 환경변수 정리"""
    import os

    # 테스트 전 삭제
    if TOKEN_ENV_KEY in os.environ:
        del os.environ[TOKEN_ENV_KEY]

    yield

    # 테스트 후 삭제
    if TOKEN_ENV_KEY in os.environ:
        del os.environ[TOKEN_ENV_KEY]


@pytest.fixture
def setup(tmp_path: Path, auth_headers: dict, session_manager: AuthSessionManager):
    """테스트용 앱, 클라이언트 셋업"""
    env_path = tmp_path / ".env"

    app = FastAPI()
    router = create_claude_auth_router(
        session_manager=session_manager,
        env_path=env_path,
    )
    app.include_router(router, prefix="/auth/claude")

    client = TestClient(app)
    return {
        "client": client,
        "session_manager": session_manager,
        "env_path": env_path,
        "auth_headers": auth_headers,
    }


class TestStartAuth:
    """POST /auth/claude/start 테스트"""

    def test_start_success(self, setup):
        """정상 시작 - URL 반환"""
        mock_process = MagicMock()
        mock_result = StartResult(
            process=mock_process,
            auth_url="https://claude.ai/oauth/authorize?code=true&client_id=test",
        )

        with patch(
            "soul_server.api.claude_auth.router.cli_runner.start_cli",
            new_callable=AsyncMock,
            return_value=mock_result,
        ):
            resp = setup["client"].post(
                "/auth/claude/start", headers=setup["auth_headers"]
            )

        assert resp.status_code == 200
        data = resp.json()
        assert "session_id" in data
        assert data["auth_url"] == mock_result.auth_url
        assert data["status"] == "waiting_code"

    def test_start_cli_error(self, setup):
        """CLI 시작 실패 시 500 반환"""
        with patch(
            "soul_server.api.claude_auth.router.cli_runner.start_cli",
            new_callable=AsyncMock,
            side_effect=CliRunnerError("claude not found"),
        ):
            resp = setup["client"].post(
                "/auth/claude/start", headers=setup["auth_headers"]
            )

        assert resp.status_code == 500

    def test_start_cancels_existing_session(self, setup):
        """새 세션 시작 시 기존 세션 취소"""
        mock_process = MagicMock()
        mock_result = StartResult(
            process=mock_process,
            auth_url="https://claude.ai/oauth/authorize?code=true",
        )

        with patch(
            "soul_server.api.claude_auth.router.cli_runner.start_cli",
            new_callable=AsyncMock,
            return_value=mock_result,
        ):
            # 첫 번째 세션 시작
            resp1 = setup["client"].post(
                "/auth/claude/start", headers=setup["auth_headers"]
            )
            session_id_1 = resp1.json()["session_id"]

            # 두 번째 세션 시작
            resp2 = setup["client"].post(
                "/auth/claude/start", headers=setup["auth_headers"]
            )
            session_id_2 = resp2.json()["session_id"]

        # 세션 ID가 다름
        assert session_id_1 != session_id_2

        # 현재 세션은 두 번째 세션
        assert setup["session_manager"].current_session.id == session_id_2

    def test_start_no_auth_returns_401(self, setup):
        """인증 없이 요청 시 401 반환"""
        resp = setup["client"].post("/auth/claude/start")
        assert resp.status_code == 401


class TestSubmitCode:
    """POST /auth/claude/code 테스트"""

    def test_submit_code_success(self, setup):
        """코드 제출 성공 - 토큰 저장"""
        mock_process = MagicMock()
        mock_process.stdin = MagicMock()

        start_result = StartResult(
            process=mock_process,
            auth_url="https://claude.ai/oauth/authorize?code=true",
        )

        submit_result = SubmitResult(token="sk-ant-oat01-test-token-12345")

        with patch(
            "soul_server.api.claude_auth.router.cli_runner.start_cli",
            new_callable=AsyncMock,
            return_value=start_result,
        ):
            resp1 = setup["client"].post(
                "/auth/claude/start", headers=setup["auth_headers"]
            )
            session_id = resp1.json()["session_id"]

        with patch(
            "soul_server.api.claude_auth.router.cli_runner.submit_code",
            new_callable=AsyncMock,
            return_value=submit_result,
        ):
            resp2 = setup["client"].post(
                "/auth/claude/code",
                json={"session_id": session_id, "code": "test-code"},
                headers=setup["auth_headers"],
            )

        assert resp2.status_code == 200
        data = resp2.json()
        assert data["success"] is True
        assert "1년" in data["message"]

        # .env 파일에 토큰 저장됨
        env_content = setup["env_path"].read_text()
        assert "sk-ant-oat01-test-token-12345" in env_content

    def test_submit_code_session_not_found(self, setup):
        """존재하지 않는 세션 - 404"""
        resp = setup["client"].post(
            "/auth/claude/code",
            json={"session_id": "nonexistent", "code": "test"},
            headers=setup["auth_headers"],
        )
        assert resp.status_code == 404

    def test_submit_code_wrong_status(self, setup):
        """잘못된 세션 상태 - 400"""
        # 세션 생성 (STARTING 상태)
        session = asyncio.get_event_loop().run_until_complete(
            setup["session_manager"].create_session()
        )
        # 상태를 COMPLETED로 변경
        setup["session_manager"].update_status(session, SessionStatus.COMPLETED)

        resp = setup["client"].post(
            "/auth/claude/code",
            json={"session_id": session.id, "code": "test"},
            headers=setup["auth_headers"],
        )
        assert resp.status_code == 400

    def test_submit_code_cli_error(self, setup):
        """코드 제출 실패 - 400"""
        mock_process = MagicMock()
        mock_process.stdin = MagicMock()

        start_result = StartResult(
            process=mock_process,
            auth_url="https://claude.ai/oauth/authorize?code=true",
        )

        with patch(
            "soul_server.api.claude_auth.router.cli_runner.start_cli",
            new_callable=AsyncMock,
            return_value=start_result,
        ):
            resp1 = setup["client"].post(
                "/auth/claude/start", headers=setup["auth_headers"]
            )
            session_id = resp1.json()["session_id"]

        with patch(
            "soul_server.api.claude_auth.router.cli_runner.submit_code",
            new_callable=AsyncMock,
            side_effect=CliRunnerError("Invalid code"),
        ):
            resp2 = setup["client"].post(
                "/auth/claude/code",
                json={"session_id": session_id, "code": "bad-code"},
                headers=setup["auth_headers"],
            )

        assert resp2.status_code == 400


class TestCancelSession:
    """DELETE /auth/claude/cancel 테스트"""

    def test_cancel_active_session(self, setup):
        """활성 세션 취소"""
        mock_process = MagicMock()
        mock_process.terminate = MagicMock()
        mock_process.wait = AsyncMock()

        start_result = StartResult(
            process=mock_process,
            auth_url="https://claude.ai/oauth/authorize?code=true",
        )

        with patch(
            "soul_server.api.claude_auth.router.cli_runner.start_cli",
            new_callable=AsyncMock,
            return_value=start_result,
        ):
            resp1 = setup["client"].post(
                "/auth/claude/start", headers=setup["auth_headers"]
            )
            session_id = resp1.json()["session_id"]

        resp2 = setup["client"].delete(
            "/auth/claude/cancel", headers=setup["auth_headers"]
        )

        assert resp2.status_code == 200
        data = resp2.json()
        assert data["cancelled"] is True
        assert data["session_id"] == session_id

    def test_cancel_no_session(self, setup):
        """세션이 없을 때"""
        resp = setup["client"].delete(
            "/auth/claude/cancel", headers=setup["auth_headers"]
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["cancelled"] is False
        assert data["session_id"] is None


class TestTokenManagement:
    """GET/DELETE /auth/claude/token 테스트"""

    def test_get_token_status_no_token(self, setup):
        """토큰 없을 때 has_token=False"""
        resp = setup["client"].get(
            "/auth/claude/token", headers=setup["auth_headers"]
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["has_token"] is False

    def test_get_token_status_with_token(self, setup, monkeypatch):
        """토큰 있을 때 has_token=True"""
        monkeypatch.setenv(TOKEN_ENV_KEY, "sk-ant-oat01-test")

        resp = setup["client"].get(
            "/auth/claude/token", headers=setup["auth_headers"]
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["has_token"] is True

    def test_delete_token(self, setup, monkeypatch):
        """토큰 삭제"""
        import os
        monkeypatch.setenv(TOKEN_ENV_KEY, "sk-ant-oat01-test")

        # .env 파일에도 토큰 저장
        setup["env_path"].write_text(f"{TOKEN_ENV_KEY}=sk-ant-oat01-test\n")

        resp = setup["client"].delete(
            "/auth/claude/token", headers=setup["auth_headers"]
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is True
        assert data["message"] == "토큰이 삭제되었습니다."

        # 환경변수에서 삭제됨
        assert TOKEN_ENV_KEY not in os.environ

        # .env 파일에서도 삭제됨
        env_content = setup["env_path"].read_text()
        assert TOKEN_ENV_KEY not in env_content

    def test_delete_token_not_found(self, setup):
        """토큰이 없을 때 삭제"""
        resp = setup["client"].delete(
            "/auth/claude/token", headers=setup["auth_headers"]
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is True
        assert data["message"] == "삭제할 토큰이 없습니다."


class TestAuthenticationRequired:
    """인증 없이 요청 시 401 반환 테스트"""

    def test_start_no_auth(self, setup):
        resp = setup["client"].post("/auth/claude/start")
        assert resp.status_code == 401

    def test_code_no_auth(self, setup):
        resp = setup["client"].post(
            "/auth/claude/code",
            json={"session_id": "test", "code": "test"},
        )
        assert resp.status_code == 401

    def test_cancel_no_auth(self, setup):
        resp = setup["client"].delete("/auth/claude/cancel")
        assert resp.status_code == 401

    def test_token_get_no_auth(self, setup):
        resp = setup["client"].get("/auth/claude/token")
        assert resp.status_code == 401

    def test_token_delete_no_auth(self, setup):
        resp = setup["client"].delete("/auth/claude/token")
        assert resp.status_code == 401
