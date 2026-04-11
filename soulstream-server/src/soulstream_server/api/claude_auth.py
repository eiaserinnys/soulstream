"""soulstream-server Claude Code OAuth 프록시 API

방화벽 뒤 soul-server를 대신하여 PKCE 흐름을 처리:
1. GET /api/nodes/{node_id}/claude-auth/start  → PKCE state 생성, auth_url 반환
2. GET /api/nodes/claude-auth/callback         → code 수신, token 교환, WS로 soul-server push
3. GET /api/nodes/{node_id}/claude-auth/status → soul-server 토큰 존재 여부
4. GET /api/nodes/{node_id}/claude-auth/usage  → soul-server Usage 대리 조회
5. DELETE /api/nodes/{node_id}/claude-auth/token → soul-server 토큰 삭제
6. GET /api/nodes/{node_id}/claude-auth/headless/start       → headless OAuth auth_url 반환
7. POST /api/nodes/{node_id}/claude-auth/headless/submit-code → paste-code 수신, 토큰 교환, WS push
"""
from __future__ import annotations

import logging
import os
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from soulstream_server.nodes.node_manager import NodeManager
from soulstream_server.utils.pkce import generate_verifier, generate_challenge, generate_state
from soulstream_server.utils.web_session import WebSessionStore

logger = logging.getLogger(__name__)

CLAUDE_OAUTH_AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize"
CLAUDE_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token"

# Headless paste-code 흐름 상수
# Anthropic이 허용하는 고정 redirect_uri — 인증 코드를 화면에 표시하는 흐름
HEADLESS_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback"
HEADLESS_SCOPE = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"

# 모듈 레벨 PKCE state 저장소
_web_sessions = WebSessionStore()


class SubmitCodeRequest(BaseModel):
    """POST headless/submit-code 요청 본문"""
    code: str


def create_claude_auth_router(node_manager: NodeManager) -> APIRouter:
    router = APIRouter(prefix="/api", tags=["claude-auth"])

    @router.get("/nodes/{node_id}/claude-auth/start")
    async def node_claude_auth_start(node_id: str):
        """PKCE OAuth 흐름 시작 — auth_url 반환."""
        client_id = os.environ["CLAUDE_OAUTH_CLIENT_ID"]
        callback_url = os.environ["CLAUDE_OAUTH_CALLBACK_URL"]
        verifier = generate_verifier()
        challenge = generate_challenge(verifier)
        state = generate_state()
        # state에 node_id 연결 — callback 때 어느 노드인지 식별
        _web_sessions.create(state, verifier, metadata={"node_id": node_id})
        params = {
            "client_id": client_id,
            "response_type": "code",
            "redirect_uri": callback_url,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "scope": "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
            "state": state,
        }
        return RedirectResponse(url=f"{CLAUDE_OAUTH_AUTHORIZE_URL}?{urlencode(params)}")

    # ⚠️ 동적 경로 /nodes/{node_id}/... 보다 먼저 등록 (FastAPI 정적 경로 우선)
    @router.get("/nodes/claude-auth/callback")
    async def node_claude_auth_callback(code: str, state: str):
        """OAuth 콜백 — code 수신 후 토큰 교환 및 WS로 soul-server에 push."""
        session = _web_sessions.pop(state)
        if session is None:
            raise HTTPException(status_code=400, detail="Invalid or expired OAuth state")
        node_id = session.metadata.get("node_id")
        if not node_id:
            raise HTTPException(status_code=400, detail="Missing node_id in session")
        client_id = os.environ["CLAUDE_OAUTH_CLIENT_ID"]
        callback_url = os.environ["CLAUDE_OAUTH_CALLBACK_URL"]
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                CLAUDE_OAUTH_TOKEN_URL,
                data={
                    "grant_type": "authorization_code",
                    "client_id": client_id,
                    "code": code,
                    "redirect_uri": callback_url,
                    "code_verifier": session.verifier,
                    "state": state,
                },
            )
            if resp.status_code != 200:
                raise HTTPException(
                    status_code=400, detail=f"Token exchange failed: {resp.text}"
                )
            data = resp.json()
        access_token = data["access_token"]
        refresh_token = data.get("refresh_token")
        node_conn = node_manager.get_node(node_id)
        if node_conn is None:
            raise HTTPException(status_code=404, detail=f"Node {node_id} not connected")
        await node_conn.send_claude_auth_set_token(
            access_token,
            refresh_token=refresh_token,
            expires_in=data.get("expires_in"),
            scope=data.get("scope", ""),
        )
        logger.info(f"Claude Code OAuth token pushed to node {node_id}")
        return RedirectResponse(url="/?claude_auth=success")

    @router.get("/nodes/{node_id}/claude-auth/status")
    async def node_claude_auth_status(node_id: str):
        """soul-server의 토큰 존재 여부 조회."""
        node_conn = node_manager.get_node(node_id)
        if node_conn is None:
            raise HTTPException(status_code=404, detail=f"Node {node_id} not connected")
        return await node_conn.send_claude_auth_status()

    @router.get("/nodes/{node_id}/claude-auth/usage")
    async def node_claude_auth_usage(node_id: str):
        """soul-server를 통해 Anthropic Usage 대리 조회."""
        node_conn = node_manager.get_node(node_id)
        if node_conn is None:
            raise HTTPException(status_code=404, detail=f"Node {node_id} not connected")
        result = await node_conn.send_claude_auth_get_usage()
        if not result.get("success"):
            raise HTTPException(
                status_code=400, detail=result.get("error", "unknown")
            )
        return result["data"]

    @router.get("/nodes/{node_id}/claude-auth/profile")
    async def node_claude_auth_profile(node_id: str):
        """soul-server를 통해 Anthropic 계정 프로필 대리 조회."""
        node_conn = node_manager.get_node(node_id)
        if node_conn is None:
            raise HTTPException(status_code=404, detail=f"Node {node_id} not connected")
        result = await node_conn.send_claude_auth_get_profile()
        if not result.get("success"):
            raise HTTPException(
                status_code=400, detail=result.get("error", "unknown")
            )
        return result["data"]

    @router.delete("/nodes/{node_id}/claude-auth/token")
    async def node_claude_auth_delete_token(node_id: str):
        """soul-server의 토큰 삭제."""
        node_conn = node_manager.get_node(node_id)
        if node_conn is None:
            raise HTTPException(status_code=404, detail=f"Node {node_id} not connected")
        return await node_conn.send_claude_auth_delete_token()

    @router.get("/nodes/{node_id}/claude-auth/headless/start")
    async def node_claude_auth_headless_start(node_id: str):
        """Headless OAuth 흐름 시작 — auth_url JSON 반환.

        사용자가 반환된 URL을 브라우저에서 열면 Anthropic이
        {authorization_code}#{state} 형식의 코드를 화면에 표시한다.
        사용자가 해당 코드를 복사하여 headless/submit-code 엔드포인트에 제출한다.
        """
        node_conn = node_manager.get_node(node_id)
        if node_conn is None:
            raise HTTPException(status_code=404, detail=f"Node {node_id} not connected")
        client_id = os.environ["CLAUDE_OAUTH_CLIENT_ID"]
        verifier = generate_verifier()
        challenge = generate_challenge(verifier)
        state = generate_state()
        _web_sessions.create(state, verifier, metadata={"node_id": node_id})
        params = {
            "code": "true",
            "client_id": client_id,
            "response_type": "code",
            "redirect_uri": HEADLESS_REDIRECT_URI,
            "scope": HEADLESS_SCOPE,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "state": state,
        }
        return {"authUrl": f"{CLAUDE_OAUTH_AUTHORIZE_URL}?{urlencode(params)}"}

    @router.post("/nodes/{node_id}/claude-auth/headless/submit-code")
    async def node_claude_auth_headless_submit_code(
        node_id: str, body: SubmitCodeRequest
    ):
        """Headless OAuth paste-code 수신 — 토큰 교환 후 WS로 soul-server에 push.

        body.code는 Anthropic 화면에 표시된 {authorization_code}#{state} 형식이다.
        """
        raw = body.code.strip()
        if not raw:
            raise HTTPException(status_code=400, detail="missing_code")
        hash_idx = raw.find("#")
        if hash_idx == -1:
            raise HTTPException(status_code=400, detail="invalid_code_format")
        authorization_code = raw[:hash_idx]
        state = raw[hash_idx + 1:]
        session = _web_sessions.pop(state)
        if session is None:
            raise HTTPException(status_code=400, detail="invalid_state")
        meta_node_id = session.metadata.get("node_id")
        if meta_node_id != node_id:
            raise HTTPException(status_code=400, detail="node_id mismatch")
        node_conn = node_manager.get_node(node_id)
        if node_conn is None:
            raise HTTPException(status_code=404, detail=f"Node {node_id} not connected")
        client_id = os.environ["CLAUDE_OAUTH_CLIENT_ID"]
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                CLAUDE_OAUTH_TOKEN_URL,
                data={
                    "grant_type": "authorization_code",
                    "client_id": client_id,
                    "code": authorization_code,
                    "redirect_uri": HEADLESS_REDIRECT_URI,
                    "code_verifier": session.verifier,
                    "state": state,
                },
            )
            if resp.status_code != 200:
                raise HTTPException(
                    status_code=400,
                    detail=f"token_exchange_failed: {resp.text}",
                )
            data = resp.json()
        access_token = data["access_token"]
        refresh_token = data.get("refresh_token")
        await node_conn.send_claude_auth_set_token(
            access_token,
            refresh_token=refresh_token,
            expires_in=data.get("expires_in"),
            scope=data.get("scope", ""),
        )
        logger.info(f"Claude Code OAuth token pushed to node {node_id} (headless)")
        return {"success": True}

    return router
