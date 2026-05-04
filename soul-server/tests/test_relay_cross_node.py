"""_relay_cross_node_intervention 단위 테스트.

cross-node 위임 완료 보고 시 orch-server protected route에
Bearer 헤더가 정상 전달되고, 실패 시 적절히 로깅하는지 검증한다.

NOTE: _relay_cross_node_intervention은 내부에서 lazy import한다:
  from soul_server.config import get_settings
  import httpx
따라서 patch 대상은 소스 모듈 레벨이다:
  - soul_server.config.get_settings  (함수 body의 lazy import가 캡처)
  - httpx.AsyncClient  (함수 body의 import httpx가 sys.modules에서 가져옴)
함수 import는 모듈 레벨에서 수행하여 import 시점의 get_settings 호출과 격리.
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from soul_server.service.task_manager import _relay_cross_node_intervention


def _make_settings(upstream_url="ws://orch:5200/ws/node1", auth_token="secret-token"):
    """테스트용 Settings mock 생성."""
    settings = MagicMock()
    settings.soulstream_upstream_url = upstream_url
    settings.auth_bearer_token = auth_token
    return settings


@pytest.mark.asyncio
class TestRelayCrossNodeIntervention:
    """_relay_cross_node_intervention 검증."""

    async def test_relay_sends_bearer_header(self):
        """auth_bearer_token이 있으면 Authorization 헤더를 포함하여 httpx.AsyncClient를 생성한다."""
        settings = _make_settings(auth_token="my-secret")

        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_resp)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        mock_client_cls = MagicMock(return_value=mock_client)

        with (
            patch("soul_server.config.get_settings", return_value=settings),
            patch("httpx.AsyncClient", mock_client_cls),
        ):
            await _relay_cross_node_intervention("sess-caller-123", "완료 보고 텍스트")

        mock_client_cls.assert_called_once_with(
            timeout=10.0,
            headers={"Authorization": "Bearer my-secret"},
        )
        mock_client.post.assert_called_once_with(
            "http://orch:5200/api/sessions/sess-caller-123/intervene",
            json={"text": "완료 보고 텍스트", "user": "agent"},
        )
        mock_resp.raise_for_status.assert_called_once()

    async def test_relay_raises_on_401(self):
        """raise_for_status가 HTTPStatusError를 던지면 logger.error가 호출된다."""
        import httpx as real_httpx

        settings = _make_settings(auth_token="bad-token")

        mock_resp = MagicMock()
        mock_resp.raise_for_status.side_effect = real_httpx.HTTPStatusError(
            "401 Unauthorized",
            request=MagicMock(),
            response=MagicMock(status_code=401),
        )

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_resp)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        mock_client_cls = MagicMock(return_value=mock_client)

        with (
            patch("soul_server.config.get_settings", return_value=settings),
            patch("httpx.AsyncClient", mock_client_cls),
            patch("soul_server.service.task_manager.logger") as mock_logger,
        ):
            await _relay_cross_node_intervention("sess-caller-401", "보고 텍스트")

        mock_logger.error.assert_called_once()
        assert "sess-caller-401" in mock_logger.error.call_args[0][0]
        mock_logger.info.assert_not_called()

    async def test_relay_success_logs_info(self):
        """200 응답 시 logger.info가 호출된다."""
        settings = _make_settings(auth_token="good-token")

        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()  # 예외 없음

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_resp)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        mock_client_cls = MagicMock(return_value=mock_client)

        with (
            patch("soul_server.config.get_settings", return_value=settings),
            patch("httpx.AsyncClient", mock_client_cls),
            patch("soul_server.service.task_manager.logger") as mock_logger,
        ):
            await _relay_cross_node_intervention("sess-caller-ok", "성공 보고")

        mock_logger.info.assert_called_once()
        assert "sess-caller-ok" in mock_logger.info.call_args[0][0]
        mock_logger.error.assert_not_called()

    async def test_relay_no_header_when_token_empty(self):
        """auth_bearer_token이 빈 문자열이면 headers={}로 전달한다 (개발 모드 호환)."""
        settings = _make_settings(auth_token="")

        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_resp)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        mock_client_cls = MagicMock(return_value=mock_client)

        with (
            patch("soul_server.config.get_settings", return_value=settings),
            patch("httpx.AsyncClient", mock_client_cls),
        ):
            await _relay_cross_node_intervention("sess-dev", "dev 테스트")

        mock_client_cls.assert_called_once_with(
            timeout=10.0,
            headers={},
        )

    async def test_relay_skips_when_no_upstream_url(self):
        """soulstream_upstream_url이 None이면 httpx 호출 없이 즉시 반환한다."""
        settings = _make_settings(upstream_url=None, auth_token="token")

        with (
            patch("soul_server.config.get_settings", return_value=settings),
            patch("httpx.AsyncClient") as mock_client_cls,
        ):
            await _relay_cross_node_intervention("sess-no-url", "no upstream")

        mock_client_cls.assert_not_called()
