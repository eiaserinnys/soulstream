"""Tests for /api/status (dashboard) endpoint reflecting actual _is_draining state.

app.dependency_overrides를 사용하여 인증을 우회하고,
get_task_manager / resource_manager를 mock으로 대체한다.
이 테스트의 목적은 is_draining 상태가 HTTP 응답에 올바르게 반영되는지 검증하는 것이며,
인증 로직이나 task_manager 동작은 별도 테스트 파일에서 검증된다.

TestClient에 `with` 컨텍스트 매니저를 사용하지 않는다.
`with TestClient(...)` 형태로 사용하면 앱의 lifespan이 실행되어 DB 풀이 열리고,
테스트 종료 시 lifespan shutdown이 DB 풀을 닫아 후속 테스트(test_cogito_mcp.py 등)가 깨진다.
"""

import pytest
from unittest.mock import MagicMock, patch
import soul_server.main as main_module
from fastapi.testclient import TestClient
from soul_server.dashboard.auth import require_dashboard_auth


@pytest.fixture(autouse=True)
def reset_draining_state():
    """각 테스트 전후 _is_draining 전역 변수와 app.state.is_draining을 초기화한다."""
    main_module._is_draining = False
    main_module.app.state.is_draining = False
    yield
    main_module._is_draining = False
    main_module.app.state.is_draining = False


@pytest.fixture
def client_no_auth():
    """require_dashboard_auth를 dependency_overrides로 우회하고
    task_manager / resource_manager를 mock으로 대체한 TestClient.

    lifespan 없이 동작하므로 with 컨텍스트 매니저를 사용하지 않는다.
    """
    async def bypass_auth():
        return None

    mock_task_manager = MagicMock()
    mock_task_manager.get_running_tasks.return_value = []

    mock_resource_manager = MagicMock()
    mock_resource_manager.max_concurrent = 3

    main_module.app.dependency_overrides[require_dashboard_auth] = bypass_auth
    with (
        patch("soul_server.dashboard.api_router.get_task_manager", return_value=mock_task_manager),
        patch("soul_server.dashboard.api_router.resource_manager", mock_resource_manager),
    ):
        yield TestClient(main_module.app, raise_server_exceptions=False)

    # clear() 대신 해당 키만 제거: 다른 테스트가 설정한 dependency_overrides를 건드리지 않는다
    main_module.app.dependency_overrides.pop(require_dashboard_auth, None)


def test_api_status_returns_not_draining_by_default(client_no_auth):
    """정상 상태에서 /api/status는 is_draining: false를 반환한다."""
    resp = client_no_auth.get("/api/status")
    assert resp.status_code == 200
    data = resp.json()
    assert data["is_draining"] is False


def test_api_status_returns_draining_when_draining(client_no_auth):
    """드레이닝 상태에서 /api/status는 is_draining: true를 반환한다."""
    # graceful_shutdown()이 설정할 값을 직접 시뮬레이션
    main_module._is_draining = True
    main_module.app.state.is_draining = True

    resp = client_no_auth.get("/api/status")
    assert resp.status_code == 200
    assert resp.json()["is_draining"] is True


def test_api_status_returns_not_draining_after_recovery(client_no_auth):
    """복구 후 /api/status는 is_draining: false로 돌아온다."""
    main_module._is_draining = True
    main_module.app.state.is_draining = True

    # except 복구 경로 시뮬레이션
    main_module._is_draining = False
    main_module.app.state.is_draining = False

    resp = client_no_auth.get("/api/status")
    assert resp.status_code == 200
    assert resp.json()["is_draining"] is False
