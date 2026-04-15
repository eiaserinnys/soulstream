"""Claude Auth 명령 핸들러

UpstreamAdapter의 claude_auth_* WebSocket 명령을 처리하는 함수 모듈.
각 함수는 명령 dict를 받아 응답 dict를 반환한다.
"""

import logging
from typing import Optional

import httpx

from soul_server.api.claude_auth.token_store import (
    delete_oauth_token,
    get_env_path,
    get_oauth_token,
    save_credentials_json,
    save_oauth_token,
)

logger = logging.getLogger(__name__)

ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
ANTHROPIC_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile"


def handle_auth_status(request_id: str, response_type: str) -> dict:
    """claude_auth_status: 토큰 존재 여부를 반환."""
    token = get_oauth_token()
    return {
        "type": response_type,
        "has_token": token is not None,
        "requestId": request_id,
    }


def handle_auth_set_token(
    cmd: dict, request_id: str, response_type: str
) -> tuple[Optional[dict], Optional[str]]:
    """claude_auth_set_token: 토큰을 저장한다.

    Returns:
        (response_dict, error_message)
        error_message가 None이 아니면 실패.
    """
    token_val = cmd.get("token", "")
    if not token_val:
        return None, "token is required"

    refresh_val = cmd.get("refresh_token")
    if refresh_val:
        save_credentials_json(
            token_val,
            refresh_val,
            expires_in=cmd.get("expires_in"),
            scope=cmd.get("scope", ""),
        )
    else:
        save_oauth_token(token_val, get_env_path())

    logger.info("Claude Code OAuth token set via WS command")
    return {
        "type": response_type,
        "success": True,
        "requestId": request_id,
    }, None


def handle_auth_delete_token(request_id: str, response_type: str) -> dict:
    """claude_auth_delete_token: 토큰을 삭제한다."""
    delete_oauth_token(get_env_path())
    logger.info("Claude Code OAuth token deleted via WS command")
    return {
        "type": response_type,
        "success": True,
        "requestId": request_id,
    }


async def handle_auth_api_request(
    request_id: str,
    response_type: str,
    api_url: str,
) -> dict:
    """claude_auth_get_usage / claude_auth_get_profile 공통 처리.

    Anthropic OAuth API에 GET 요청을 보내고 결과를 반환한다.
    """
    token = get_oauth_token()
    if not token:
        return {
            "type": response_type,
            "success": False,
            "error": "no token",
            "requestId": request_id,
        }

    async with httpx.AsyncClient() as client:
        resp = await client.get(
            api_url,
            headers={
                "Authorization": f"Bearer {token}",
                "anthropic-beta": "oauth-2025-04-20",
            },
        )

    if resp.status_code != 200:
        return {
            "type": response_type,
            "success": False,
            "error": resp.text,
            "requestId": request_id,
        }

    return {
        "type": response_type,
        "success": True,
        "data": resp.json(),
        "requestId": request_id,
    }
