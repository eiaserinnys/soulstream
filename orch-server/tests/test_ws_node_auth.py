"""Tests for /ws/node Authorization header verification (handle_node_ws).

WS close code 대응 규약:
    - WS_CLOSE_AUTH_REQUIRED = 4401 → HTTP 401 미러링 (헤더 누락 / Bearer 형식 오류)
    - WS_CLOSE_AUTH_INVALID  = 4403 → HTTP 403 미러링 (토큰 값 불일치)
    - WS_CLOSE_CONFIG_ERROR  = 4005 → 서버 인증 미구성 (프로덕션에서 토큰 미설정)

앞 자리 `4` = WS 앱 정의 close code 범위, 뒷자리 3자리 = HTTP status 숫자를
의도적으로 매칭해 디버깅 시 코드 의미를 즉시 파악할 수 있게 한다.

각 시나리오는 기호 상수를 import하여 숫자를 하드코딩하지 않는다 — 번호 변경 시
테스트도 자동으로 추종한다.
"""

import json
from unittest.mock import AsyncMock, patch

import pytest

from soulstream_server.constants import (
    EVT_NODE_REGISTER,
    WS_CLOSE_AUTH_INVALID,
    WS_CLOSE_AUTH_REQUIRED,
    WS_CLOSE_CONFIG_ERROR,
)
from soulstream_server.nodes.node_manager import NodeManager
from soulstream_server.nodes.ws_handler import handle_node_ws
from tests.conftest import TEST_AUTH_TOKEN


def _close_code(mock_close: AsyncMock) -> int | None:
    """ws.close() 첫 호출의 code 인자를 추출."""
    if not mock_close.call_args:
        return None
    args, kwargs = mock_close.call_args
    return kwargs.get("code", args[0] if args else None)


@pytest.fixture
def manager():
    return NodeManager()


class TestWsNodeAuth:
    """/ws/node handle_node_ws 인증 4 시나리오."""

    async def test_valid_bearer_token_accepts_connection(self, mock_ws, manager):
        """유효 Bearer 토큰 → accept 호출, close 미호출 (등록 단계로 진입)."""
        from fastapi import WebSocketDisconnect

        mock_ws.headers = {"authorization": f"Bearer {TEST_AUTH_TOKEN}"}
        # 등록 메시지 후 disconnect로 핸들러를 조기 종료
        mock_ws.receive_text.side_effect = [
            json.dumps({"type": EVT_NODE_REGISTER, "node_id": "n1"}),
            WebSocketDisconnect(1000),
        ]

        await handle_node_ws(mock_ws, manager)

        mock_ws.accept.assert_awaited_once()
        # 등록 흐름에서 close는 정상 경로상 호출되지 않는다 (disconnect는 예외 경로)
        # node.close()가 내부적으로 ws.close를 호출하지 않음을 검증하려면
        # close가 인증 관련 close 코드로 호출되지 않았는지 확인한다.
        assert _close_code(mock_ws.close) not in (
            WS_CLOSE_AUTH_REQUIRED,
            WS_CLOSE_AUTH_INVALID,
            WS_CLOSE_CONFIG_ERROR,
        )

    async def test_missing_authorization_header_closes_with_auth_required(
        self, mock_ws, manager
    ):
        """Authorization 헤더 없음 → WS_CLOSE_AUTH_REQUIRED, accept 미호출."""
        mock_ws.headers = {}  # 헤더 없음

        await handle_node_ws(mock_ws, manager)

        mock_ws.accept.assert_not_awaited()
        mock_ws.close.assert_awaited_once()
        assert _close_code(mock_ws.close) == WS_CLOSE_AUTH_REQUIRED

    async def test_malformed_authorization_header_closes_with_auth_required(
        self, mock_ws, manager
    ):
        """Bearer 형식 오류 → WS_CLOSE_AUTH_REQUIRED."""
        mock_ws.headers = {"authorization": "NotBearer something"}

        await handle_node_ws(mock_ws, manager)

        mock_ws.accept.assert_not_awaited()
        assert _close_code(mock_ws.close) == WS_CLOSE_AUTH_REQUIRED

    async def test_invalid_token_closes_with_auth_invalid(self, mock_ws, manager):
        """토큰 값 불일치 → WS_CLOSE_AUTH_INVALID, accept 미호출."""
        mock_ws.headers = {"authorization": "Bearer this-is-wrong-token"}

        await handle_node_ws(mock_ws, manager)

        mock_ws.accept.assert_not_awaited()
        mock_ws.close.assert_awaited_once()
        assert _close_code(mock_ws.close) == WS_CLOSE_AUTH_INVALID

    async def test_production_without_token_closes_with_config_error(
        self, mock_ws, manager
    ):
        """프로덕션 + AUTH_BEARER_TOKEN 미설정 → WS_CLOSE_CONFIG_ERROR + error 로그.

        get_settings()는 lru_cache이므로 함수 자체를 교체해 가짜 Settings를 반환시킨다.
        실제 Settings 인스턴스를 수정하면 테스트 간 상태 누출 위험이 있다.
        """
        from types import SimpleNamespace
        from soulstream_server.nodes import ws_handler as ws_handler_module

        mock_ws.headers = {}  # 어떤 헤더라도 관계없음 — 토큰 미설정이 먼저 걸린다

        fake = SimpleNamespace(auth_bearer_token="", is_production=True)
        with patch.object(ws_handler_module, "get_settings", lambda: fake):
            await handle_node_ws(mock_ws, manager)

        mock_ws.accept.assert_not_awaited()
        mock_ws.close.assert_awaited_once()
        assert _close_code(mock_ws.close) == WS_CLOSE_CONFIG_ERROR

    async def test_development_without_token_accepts_connection(
        self, mock_ws, manager
    ):
        """개발 모드 + 토큰 미설정 → 인증 우회, accept 진행."""
        from fastapi import WebSocketDisconnect
        from types import SimpleNamespace
        from soulstream_server.nodes import ws_handler as ws_handler_module

        mock_ws.headers = {}  # 헤더 없어도 개발 모드면 통과
        mock_ws.receive_text.side_effect = [
            json.dumps({"type": EVT_NODE_REGISTER, "node_id": "dev-node"}),
            WebSocketDisconnect(1000),
        ]

        fake = SimpleNamespace(auth_bearer_token="", is_production=False)
        with patch.object(ws_handler_module, "get_settings", lambda: fake):
            await handle_node_ws(mock_ws, manager)

        mock_ws.accept.assert_awaited_once()
        assert _close_code(mock_ws.close) not in (
            WS_CLOSE_AUTH_REQUIRED,
            WS_CLOSE_AUTH_INVALID,
            WS_CLOSE_CONFIG_ERROR,
        )
