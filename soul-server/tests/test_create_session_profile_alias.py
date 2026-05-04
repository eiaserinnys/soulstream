"""
test_create_session_profile_alias - CreateSessionBody의 agentId/profile 양방향 alias 테스트

cron run_session.sh는 'profile' 필드를 보내고, 기존 대시보드는 'agentId' 필드를 보낸다.
두 키 모두 수용하여 task_manager.create_task(profile_id=...)에 올바르게 전달되는지 검증한다.

관련 사고: 2026-04-20 eb-steam-sync cron이 'profile' 필드를 보냈지만 soul-server는
'agentId'만 받도록 정의되어 profile이 조용히 drop되어 agent_id=NULL로 세션이 생성됨.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture
def mock_task_manager():
    tm = MagicMock()
    task = MagicMock()
    task.agent_session_id = "sess-created"
    tm.create_task = AsyncMock(return_value=task)
    tm.executor.start_execution = AsyncMock()
    return tm


def _build_app():
    from soul_server.dashboard.api_router import router
    from soul_server.dashboard.auth import require_dashboard_auth

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[require_dashboard_auth] = lambda: None
    return app


def _post_create_session(mock_task_manager, body: dict):
    app = _build_app()
    with (
        patch("soul_server.dashboard.routes.sessions.get_task_manager", return_value=mock_task_manager),
        patch("soul_server.dashboard.routes.sessions.resource_manager") as mock_rm,
        patch("soul_server.dashboard.routes.sessions.get_soul_engine", return_value=MagicMock()),
    ):
        mock_rm.can_acquire.return_value = True
        client = TestClient(app, raise_server_exceptions=True)
        return client.post("/api/sessions", json=body)


class TestCreateSessionAgentIdAlias:
    """CreateSessionBody가 agentId와 profile 두 키를 모두 수용하는지 검증."""

    def test_agentId_primary_field_accepted(self, mock_task_manager):
        """기존 동작: {'agentId': 'seosoyoung'} → profile_id='seosoyoung'."""
        resp = _post_create_session(mock_task_manager, {"prompt": "x", "agentId": "seosoyoung"})
        assert resp.status_code == 201
        call_kwargs = mock_task_manager.create_task.call_args.kwargs
        assert call_kwargs["profile_id"] == "seosoyoung"

    def test_profile_alias_accepted(self, mock_task_manager):
        """회귀 방지: {'profile': 'seosoyoung'} → profile_id='seosoyoung'.

        cron run_session.sh가 사용하는 필드명. 이 테스트가 실패하면 이번 사고가 재발한다.
        """
        resp = _post_create_session(mock_task_manager, {"prompt": "x", "profile": "seosoyoung"})
        assert resp.status_code == 201
        call_kwargs = mock_task_manager.create_task.call_args.kwargs
        assert call_kwargs["profile_id"] == "seosoyoung"

    def test_both_keys_agentId_wins(self, mock_task_manager):
        """두 키 동시 전달 시 AliasChoices 순서대로 agentId가 우선 사용된다. 에러 없이 201."""
        resp = _post_create_session(
            mock_task_manager, {"prompt": "x", "agentId": "from-agentId", "profile": "from-profile"}
        )
        assert resp.status_code == 201
        call_kwargs = mock_task_manager.create_task.call_args.kwargs
        assert call_kwargs["profile_id"] == "from-agentId"

    def test_no_agent_id_passes_none(self, mock_task_manager):
        """둘 다 없으면 profile_id=None으로 전달된다 (기존 동작 유지)."""
        resp = _post_create_session(mock_task_manager, {"prompt": "x"})
        assert resp.status_code == 201
        call_kwargs = mock_task_manager.create_task.call_args.kwargs
        assert call_kwargs["profile_id"] is None
