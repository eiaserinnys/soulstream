"""Tests for Attachments proxy API (/api/attachments).

WS reverse-proxy 전환 (2026-05-13, atom 260513.01) — orch는 노드 self-reported
host:port HTTP 호출을 *하지 않는다*. 대신 노드와 이미 신뢰 가능하게 연결된
WebSocket을 통해 attachment binary를 base64-in-JSON으로 forward한다.

본 테스트는 `NodeConnection.send_upload_attachment` / `send_delete_session_attachments`
호출 결과를 mock하여 라우트 분기(404 미등록 / 400 INVALID_REQUEST / 502 일반 에러 /
504 timeout)를 검증한다. 직접 노드 vs cross-node는 *노드 객체 자체*가 다를 뿐
같은 코드 경로이므로 두 케이스를 별도로 검증한다.
"""

import pytest
from unittest.mock import AsyncMock
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from soulstream_server.nodes.node_connection import NodeConnection
from soulstream_server.nodes.node_manager import NodeManager


def make_test_app(node_manager: NodeManager) -> FastAPI:
    """attachments 라우터만 마운트한 테스트 앱."""
    from soulstream_server.api.attachments import create_attachments_router

    app = FastAPI()
    app.include_router(create_attachments_router(node_manager))
    return app


@pytest.fixture
def mock_ws_for_attachments():
    ws = AsyncMock()
    ws.send_json = AsyncMock()
    ws.close = AsyncMock()
    ws.accept = AsyncMock()
    return ws


def _make_node(node_id: str, host: str = "10.0.0.1", port: int = 4100) -> NodeConnection:
    """직접 NodeConnection 생성 (NodeManager fixture 의존성 분리)."""
    ws = AsyncMock()
    ws.send_json = AsyncMock()
    ws.close = AsyncMock()
    return NodeConnection(
        ws=ws,
        node_id=node_id,
        host=host,
        port=port,
    )


@pytest.fixture
def populated_node_manager(mock_ws_for_attachments):
    """단일 노드 'node-1' 등록 (host=localhost, port=4100)."""
    nm = NodeManager()
    conn = NodeConnection(
        ws=mock_ws_for_attachments,
        node_id="node-1",
        host="localhost",
        port=4100,
    )
    nm._nodes["node-1"] = conn
    return nm


@pytest.fixture
def two_node_manager():
    """cross-node 시나리오 — 'node-direct'(같은 머신 가정)와 'node-remote'(다른 머신 가정).

    WS wire 전환 후엔 host:port 가정 자체가 무의미하므로 직접/cross-node 분기는
    *코드 경로*가 아닌 *노드 인스턴스 선택* 수준만 검증한다.
    """
    nm = NodeManager()
    nm._nodes["node-direct"] = _make_node("node-direct", host="0.0.0.0", port=3105)
    nm._nodes["node-remote"] = _make_node("node-remote", host="127.0.0.1", port=4105)
    return nm


@pytest.fixture
def empty_node_manager():
    return NodeManager()


@pytest.fixture
async def attachments_client(populated_node_manager):
    app = make_test_app(populated_node_manager)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.fixture
async def empty_attachments_client(empty_node_manager):
    app = make_test_app(empty_node_manager)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.fixture
async def two_node_client(two_node_manager):
    app = make_test_app(two_node_manager)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c, two_node_manager


# ─── proxy_upload ────────────────────────────────────


class TestProxyUpload:
    """POST /api/attachments/sessions 테스트."""

    async def test_routes_upload_via_ws_and_returns_node_path(
        self, attachments_client, populated_node_manager
    ):
        """노드의 send_upload_attachment 응답을 그대로 forward한다."""
        node = populated_node_manager.get_node("node-1")
        node.send_upload_attachment = AsyncMock(return_value={
            "path": "/incoming/session-abc/123_test.txt",
            "filename": "test.txt",
            "size": 11,
            "content_type": "text/plain",
        })

        resp = await attachments_client.post(
            "/api/attachments/sessions?nodeId=node-1",
            data={"session_id": "session-abc"},
            files={"file": ("test.txt", b"hello world", "text/plain")},
        )

        assert resp.status_code == 201
        body = resp.json()
        assert body["path"] == "/incoming/session-abc/123_test.txt"
        assert body["filename"] == "test.txt"
        assert body["size"] == 11
        assert body["content_type"] == "text/plain"

        # WS 호출 검증 — content_b64 인코딩, session_id/filename forward
        node.send_upload_attachment.assert_awaited_once()
        kwargs = node.send_upload_attachment.await_args.kwargs
        assert kwargs["session_id"] == "session-abc"
        assert kwargs["filename"] == "test.txt"
        assert kwargs["content_type"] == "text/plain"
        import base64
        assert base64.b64decode(kwargs["content_b64"]) == b"hello world"

    async def test_returns_404_for_unknown_node(self, attachments_client):
        resp = await attachments_client.post(
            "/api/attachments/sessions?nodeId=unknown-node",
            data={"session_id": "session-abc"},
            files={"file": ("test.txt", b"hello", "text/plain")},
        )
        assert resp.status_code == 404

    async def test_returns_422_when_no_nodeid(self, attachments_client):
        resp = await attachments_client.post(
            "/api/attachments/sessions",
            data={"session_id": "session-abc"},
            files={"file": ("test.txt", b"hello", "text/plain")},
        )
        assert resp.status_code == 422

    async def test_returns_400_on_node_invalid_request(
        self, attachments_client, populated_node_manager
    ):
        """노드가 INVALID_REQUEST: prefix EVT_ERROR로 응답 → 400 + 메시지 forward."""
        node = populated_node_manager.get_node("node-1")
        node.send_upload_attachment = AsyncMock(
            side_effect=RuntimeError("INVALID_REQUEST: 보안상 허용되지 않는 파일 형식입니다: .exe")
        )

        resp = await attachments_client.post(
            "/api/attachments/sessions?nodeId=node-1",
            data={"session_id": "sess-1"},
            files={"file": ("evil.exe", b"payload", "application/octet-stream")},
        )

        assert resp.status_code == 400
        body = resp.json()
        detail = body.get("detail", "")
        assert ".exe" in detail
        assert "INVALID_REQUEST" not in detail  # prefix 제거 확인

    async def test_returns_502_on_other_node_error(
        self, attachments_client, populated_node_manager
    ):
        """노드가 일반 EVT_ERROR로 응답 → 502."""
        node = populated_node_manager.get_node("node-1")
        node.send_upload_attachment = AsyncMock(
            side_effect=RuntimeError("Internal disk write failed")
        )

        resp = await attachments_client.post(
            "/api/attachments/sessions?nodeId=node-1",
            data={"session_id": "sess-1"},
            files={"file": ("a.txt", b"x", "text/plain")},
        )

        assert resp.status_code == 502

    async def test_returns_504_on_node_timeout(
        self, attachments_client, populated_node_manager
    ):
        """노드 응답 timeout → 504."""
        node = populated_node_manager.get_node("node-1")
        node.send_upload_attachment = AsyncMock(
            side_effect=TimeoutError("Command upload_attachment timed out after 30s")
        )

        resp = await attachments_client.post(
            "/api/attachments/sessions?nodeId=node-1",
            data={"session_id": "sess-1"},
            files={"file": ("a.txt", b"x", "text/plain")},
        )

        assert resp.status_code == 504

    async def test_returns_503_on_node_disconnect(
        self, attachments_client, populated_node_manager
    ):
        """노드 disconnect 중 outstanding 요청 → ConnectionError → 503."""
        node = populated_node_manager.get_node("node-1")
        node.send_upload_attachment = AsyncMock(
            side_effect=ConnectionError("Node disconnected during command")
        )

        resp = await attachments_client.post(
            "/api/attachments/sessions?nodeId=node-1",
            data={"session_id": "sess-1"},
            files={"file": ("a.txt", b"x", "text/plain")},
        )

        assert resp.status_code == 503

    async def test_returns_502_on_malformed_upload_response(
        self, attachments_client, populated_node_manager
    ):
        """노드 upload 응답이 malformed → 502 (P1-1)."""
        node = populated_node_manager.get_node("node-1")
        node.send_upload_attachment = AsyncMock(return_value={
            "path": "/x",
            # filename/size/content_type 누락
        })
        resp = await attachments_client.post(
            "/api/attachments/sessions?nodeId=node-1",
            data={"session_id": "sess-1"},
            files={"file": ("a.txt", b"x", "text/plain")},
        )
        assert resp.status_code == 502

    async def test_cross_node_routing_selects_correct_node_instance(
        self, two_node_client
    ):
        """직접/cross-node 분기는 *코드 경로 차이 없음* — 같은 라우트가 nodeId로 노드 인스턴스만 선택."""
        client, manager = two_node_client

        direct = manager.get_node("node-direct")
        remote = manager.get_node("node-remote")
        direct.send_upload_attachment = AsyncMock(return_value={
            "path": "/d/sess/x", "filename": "x", "size": 1, "content_type": "text/plain",
        })
        remote.send_upload_attachment = AsyncMock(return_value={
            "path": "/r/sess/x", "filename": "x", "size": 1, "content_type": "text/plain",
        })

        resp1 = await client.post(
            "/api/attachments/sessions?nodeId=node-direct",
            data={"session_id": "s"},
            files={"file": ("x", b"y", "text/plain")},
        )
        resp2 = await client.post(
            "/api/attachments/sessions?nodeId=node-remote",
            data={"session_id": "s"},
            files={"file": ("x", b"y", "text/plain")},
        )

        assert resp1.status_code == 201 and resp1.json()["path"] == "/d/sess/x"
        assert resp2.status_code == 201 and resp2.json()["path"] == "/r/sess/x"
        direct.send_upload_attachment.assert_awaited_once()
        remote.send_upload_attachment.assert_awaited_once()


# ─── proxy_delete ────────────────────────────────────


class TestProxyDelete:
    """DELETE /api/attachments/sessions/{session_id} 테스트."""

    async def test_routes_delete_via_ws(
        self, attachments_client, populated_node_manager
    ):
        node = populated_node_manager.get_node("node-1")
        node.send_delete_session_attachments = AsyncMock(
            return_value={"cleaned": True, "files_removed": 2}
        )

        resp = await attachments_client.delete(
            "/api/attachments/sessions/session-abc?nodeId=node-1"
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["cleaned"] is True
        assert body["files_removed"] == 2

        node.send_delete_session_attachments.assert_awaited_once_with("session-abc")

    async def test_returns_404_for_unknown_node(self, attachments_client):
        resp = await attachments_client.delete(
            "/api/attachments/sessions/session-abc?nodeId=no-such-node"
        )
        assert resp.status_code == 404

    async def test_returns_400_on_node_invalid_request(
        self, attachments_client, populated_node_manager
    ):
        node = populated_node_manager.get_node("node-1")
        node.send_delete_session_attachments = AsyncMock(
            side_effect=RuntimeError("INVALID_REQUEST: session_id 누락")
        )
        resp = await attachments_client.delete(
            "/api/attachments/sessions/x?nodeId=node-1"
        )
        assert resp.status_code == 400

    async def test_returns_502_on_other_node_error(
        self, attachments_client, populated_node_manager
    ):
        node = populated_node_manager.get_node("node-1")
        node.send_delete_session_attachments = AsyncMock(
            side_effect=RuntimeError("disk error")
        )
        resp = await attachments_client.delete(
            "/api/attachments/sessions/x?nodeId=node-1"
        )
        assert resp.status_code == 502

    async def test_returns_504_on_timeout(
        self, attachments_client, populated_node_manager
    ):
        node = populated_node_manager.get_node("node-1")
        node.send_delete_session_attachments = AsyncMock(
            side_effect=TimeoutError("timeout")
        )
        resp = await attachments_client.delete(
            "/api/attachments/sessions/x?nodeId=node-1"
        )
        assert resp.status_code == 504

    async def test_returns_503_on_disconnect(
        self, attachments_client, populated_node_manager
    ):
        node = populated_node_manager.get_node("node-1")
        node.send_delete_session_attachments = AsyncMock(
            side_effect=ConnectionError("Node disconnected during command")
        )
        resp = await attachments_client.delete(
            "/api/attachments/sessions/x?nodeId=node-1"
        )
        assert resp.status_code == 503


# ─── GET /files (Phase 2 — chat-inline-attachment) ────


class TestProxyDownload:
    """GET /api/attachments/files 테스트.

    soul-app UserMessage가 채팅 영역 인라인 표시를 위해 호출하는 라우트.
    cross-node 다운로드는 WS reverse-proxy로 위임된다.
    """

    async def test_returns_streaming_response_on_success(
        self, attachments_client, populated_node_manager
    ):
        node = populated_node_manager.get_node("node-1")
        import base64
        node.send_download_attachment = AsyncMock(return_value={
            "content_b64": base64.b64encode(b"\x89PNG\r\nbinarydata").decode("ascii"),
            "content_type": "image/png",
            "filename": "photo.png",
            "size": 16,
        })

        resp = await attachments_client.get(
            "/api/attachments/files?nodeId=node-1&path=%2Fincoming%2Fs%2Fphoto.png"
        )

        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("image/png")
        assert "photo.png" in resp.headers.get("content-disposition", "")
        assert "max-age=3600" in resp.headers.get("cache-control", "")
        assert resp.content == b"\x89PNG\r\nbinarydata"

        node.send_download_attachment.assert_awaited_once_with(path="/incoming/s/photo.png")

    async def test_returns_404_for_unknown_node(self, attachments_client):
        resp = await attachments_client.get(
            "/api/attachments/files?nodeId=unknown&path=/x"
        )
        assert resp.status_code == 404

    async def test_returns_404_on_node_not_found(
        self, attachments_client, populated_node_manager
    ):
        node = populated_node_manager.get_node("node-1")
        node.send_download_attachment = AsyncMock(
            side_effect=RuntimeError("NOT_FOUND: 파일이 존재하지 않습니다")
        )
        resp = await attachments_client.get(
            "/api/attachments/files?nodeId=node-1&path=%2Fincoming%2Fmissing"
        )
        assert resp.status_code == 404

    async def test_returns_400_on_traversal(
        self, attachments_client, populated_node_manager
    ):
        node = populated_node_manager.get_node("node-1")
        node.send_download_attachment = AsyncMock(
            side_effect=RuntimeError("INVALID_REQUEST: path가 첨부 디렉토리 하위가 아닙니다")
        )
        resp = await attachments_client.get(
            "/api/attachments/files?nodeId=node-1&path=%2Fetc%2Fpasswd"
        )
        assert resp.status_code == 400

    async def test_returns_502_on_other_node_error(
        self, attachments_client, populated_node_manager
    ):
        node = populated_node_manager.get_node("node-1")
        node.send_download_attachment = AsyncMock(
            side_effect=RuntimeError("disk read failed")
        )
        resp = await attachments_client.get(
            "/api/attachments/files?nodeId=node-1&path=%2Fincoming%2Fa"
        )
        assert resp.status_code == 502

    async def test_returns_504_on_timeout(
        self, attachments_client, populated_node_manager
    ):
        node = populated_node_manager.get_node("node-1")
        node.send_download_attachment = AsyncMock(
            side_effect=TimeoutError("Command download_attachment timed out")
        )
        resp = await attachments_client.get(
            "/api/attachments/files?nodeId=node-1&path=%2Fincoming%2Fa"
        )
        assert resp.status_code == 504

    async def test_returns_503_on_disconnect(
        self, attachments_client, populated_node_manager
    ):
        node = populated_node_manager.get_node("node-1")
        node.send_download_attachment = AsyncMock(
            side_effect=ConnectionError("Node disconnected during command")
        )
        resp = await attachments_client.get(
            "/api/attachments/files?nodeId=node-1&path=%2Fincoming%2Fa"
        )
        assert resp.status_code == 503

    async def test_falls_back_to_octet_stream_when_content_type_missing(
        self, attachments_client, populated_node_manager
    ):
        node = populated_node_manager.get_node("node-1")
        import base64
        node.send_download_attachment = AsyncMock(return_value={
            "content_b64": base64.b64encode(b"raw").decode("ascii"),
            "content_type": None,
            "filename": "unknown.bin",
            "size": 3,
        })
        resp = await attachments_client.get(
            "/api/attachments/files?nodeId=node-1&path=%2Fincoming%2Fa"
        )
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("application/octet-stream")

    async def test_returns_502_on_malformed_node_response(
        self, attachments_client, populated_node_manager
    ):
        """노드가 정상 응답 type으로 응답하지만 필수 키 누락 → 502 (KeyError 누수 차단)."""
        node = populated_node_manager.get_node("node-1")
        node.send_download_attachment = AsyncMock(return_value={
            # content_b64 누락
            "filename": "x.png",
        })
        resp = await attachments_client.get(
            "/api/attachments/files?nodeId=node-1&path=%2Fincoming%2Fa"
        )
        assert resp.status_code == 502

    async def test_returns_502_on_invalid_base64(
        self, attachments_client, populated_node_manager
    ):
        """노드가 base64로 디코딩 불가능한 string을 보내면 → 502."""
        node = populated_node_manager.get_node("node-1")
        node.send_download_attachment = AsyncMock(return_value={
            "content_b64": "this-is-not-valid-base64!!!@@@",
            "content_type": "image/png",
            "filename": "x.png",
            "size": 0,
        })
        resp = await attachments_client.get(
            "/api/attachments/files?nodeId=node-1&path=%2Fincoming%2Fa"
        )
        assert resp.status_code == 502
