"""CommandDispatcher의 attachment WS reverse-proxy 핸들러 단위 테스트.

`_handle_upload_attachment` / `_handle_delete_session_attachments` 검증.

진입 시점: orch가 노드 self-reported host:port HTTP로 cross-node 첨부를 호출하던
가정을 폐기하고, 신뢰 가능한 WS wire로 통합한 결함 회로 차단. 운영 로그
(`eias-shopping host=127.0.0.1`) 기준 진단됨 — atom 작업 이력 260513.01.

테스트 패턴은 test_upstream_adapter.py와 동일 (UpstreamAdapter 인스턴스 →
`adapter._dispatcher.dispatch(cmd)` → `adapter._ws.send_json` 호출 검증).
"""

import asyncio
import base64
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from soul_server.service import AttachmentError
from soul_server.upstream.adapter import UpstreamAdapter
from soul_server.upstream.protocol import (
    CMD_DELETE_SESSION_ATTACHMENTS,
    CMD_DOWNLOAD_ATTACHMENT,
    CMD_UPLOAD_ATTACHMENT,
    EVT_ERROR,
)


def _make_broadcaster():
    broadcaster = MagicMock()
    broadcaster.add_client = MagicMock(return_value=asyncio.Queue())
    broadcaster.remove_client = MagicMock()
    return broadcaster


def _make_adapter() -> UpstreamAdapter:
    tm = MagicMock()
    se = MagicMock()
    rm = MagicMock()
    rm.max_concurrent = 3
    rm.get_stats.return_value = {"active": 1, "available": 2, "max": 3}
    return UpstreamAdapter(
        task_manager=tm,
        soul_engine=se,
        resource_manager=rm,
        session_broadcaster=_make_broadcaster(),
        upstream_url="ws://localhost:5200/ws/node",
        node_id="test-node",
        session_db=MagicMock(),
        host="localhost",
        port=3105,
        auth_bearer_token="test-token",
    )


def _attach_ws(adapter: UpstreamAdapter) -> AsyncMock:
    """adapter에 send_json mock WS를 부착하여 dispatch 가능 상태로 만든다."""
    adapter._ws = MagicMock()
    adapter._ws.closed = False
    adapter._ws.send_json = AsyncMock()
    adapter._running = True
    return adapter._ws.send_json


def _sent_messages(send_json: AsyncMock) -> list[dict]:
    return [call.args[0] for call in send_json.call_args_list]


# ─── upload_attachment ───────────────────────────────


class TestHandleUploadAttachment:
    @pytest.mark.asyncio
    async def test_success_decodes_b64_and_persists_via_file_manager(self):
        """정상 흐름 — base64 → file_manager.save_file_for_session → 성공 응답."""
        adapter = _make_adapter()
        send_json = _attach_ws(adapter)

        cmd = {
            "type": CMD_UPLOAD_ATTACHMENT,
            "requestId": "req-att-1",
            "session_id": "sess-abc",
            "filename": "photo.png",
            "content_type": "image/png",
            "content_b64": base64.b64encode(b"\x89PNG\r\nbinary").decode("ascii"),
        }

        # file_manager는 module-level singleton. command_handler가 함수 내부에서
        # `from soul_server.service import file_manager`로 import하므로 그 시점의
        # singleton 인스턴스의 메서드를 직접 patch한다.
        from soul_server.service import file_manager as fm_module
        with patch.object(
            fm_module,
            "save_file_for_session",
            new=AsyncMock(return_value={
                "path": "/tmp/incoming/sess-abc/123_photo.png",
                "filename": "photo.png",
                "size": 11,
                "content_type": "image/png",
            }),
        ) as mock_save:
            await adapter._dispatcher.dispatch(cmd)

        mock_save.assert_awaited_once()
        kwargs = mock_save.await_args.kwargs
        assert kwargs["filename"] == "photo.png"
        assert kwargs["content"] == b"\x89PNG\r\nbinary"
        assert kwargs["session_id"] == "sess-abc"

        results = [m for m in _sent_messages(send_json) if m.get("type") == "upload_attachment_result"]
        assert len(results) == 1
        assert results[0]["requestId"] == "req-att-1"
        assert results[0]["path"] == "/tmp/incoming/sess-abc/123_photo.png"
        assert results[0]["filename"] == "photo.png"
        assert results[0]["size"] == 11
        assert results[0]["content_type"] == "image/png"

    @pytest.mark.asyncio
    async def test_invalid_base64_returns_invalid_request_error(self):
        """base64 디코딩 실패 시 INVALID_REQUEST prefix EVT_ERROR (orch가 400으로 분류)."""
        adapter = _make_adapter()
        send_json = _attach_ws(adapter)

        cmd = {
            "type": CMD_UPLOAD_ATTACHMENT,
            "requestId": "req-att-2",
            "session_id": "sess-abc",
            "filename": "x.png",
            "content_type": "image/png",
            "content_b64": "this is not valid base64!!!@@@",
        }

        await adapter._dispatcher.dispatch(cmd)

        errors = [m for m in _sent_messages(send_json) if m.get("type") == EVT_ERROR]
        assert len(errors) == 1
        assert errors[0]["requestId"] == "req-att-2"
        assert errors[0]["message"].startswith("INVALID_REQUEST:")

    @pytest.mark.asyncio
    async def test_missing_content_b64_returns_invalid_request_error(self):
        adapter = _make_adapter()
        send_json = _attach_ws(adapter)

        cmd = {
            "type": CMD_UPLOAD_ATTACHMENT,
            "requestId": "req-att-3",
            "session_id": "sess-abc",
            "filename": "x.png",
            # content_b64 누락
        }

        await adapter._dispatcher.dispatch(cmd)

        errors = [m for m in _sent_messages(send_json) if m.get("type") == EVT_ERROR]
        assert len(errors) == 1
        assert errors[0]["message"].startswith("INVALID_REQUEST:")

    @pytest.mark.asyncio
    async def test_attachment_error_returns_invalid_request_error(self):
        """file_manager 검증 실패(크기/확장자) → INVALID_REQUEST EVT_ERROR."""
        adapter = _make_adapter()
        send_json = _attach_ws(adapter)

        cmd = {
            "type": CMD_UPLOAD_ATTACHMENT,
            "requestId": "req-att-4",
            "session_id": "sess-abc",
            "filename": "evil.exe",
            "content_type": "application/octet-stream",
            "content_b64": base64.b64encode(b"payload").decode("ascii"),
        }

        from soul_server.service import file_manager as fm_module
        with patch.object(
            fm_module,
            "save_file_for_session",
            new=AsyncMock(side_effect=AttachmentError("보안상 허용되지 않는 파일 형식입니다: .exe")),
        ):
            await adapter._dispatcher.dispatch(cmd)

        errors = [m for m in _sent_messages(send_json) if m.get("type") == EVT_ERROR]
        assert len(errors) == 1
        assert errors[0]["message"].startswith("INVALID_REQUEST:")
        assert ".exe" in errors[0]["message"]

    @pytest.mark.asyncio
    async def test_missing_session_id_returns_invalid_request_error(self):
        adapter = _make_adapter()
        send_json = _attach_ws(adapter)

        cmd = {
            "type": CMD_UPLOAD_ATTACHMENT,
            "requestId": "req-att-5",
            "filename": "x.png",
            "content_type": "image/png",
            "content_b64": base64.b64encode(b"x").decode("ascii"),
            # session_id 누락
        }

        await adapter._dispatcher.dispatch(cmd)

        errors = [m for m in _sent_messages(send_json) if m.get("type") == EVT_ERROR]
        assert len(errors) == 1
        assert errors[0]["message"].startswith("INVALID_REQUEST:")


# ─── delete_session_attachments ───────────────────────


class TestHandleDeleteSessionAttachments:
    @pytest.mark.asyncio
    async def test_success_cleans_up_and_returns_result(self):
        adapter = _make_adapter()
        send_json = _attach_ws(adapter)

        cmd = {
            "type": CMD_DELETE_SESSION_ATTACHMENTS,
            "requestId": "req-del-1",
            "session_id": "sess-xyz",
        }

        from soul_server.service import file_manager as fm_module
        with patch.object(
            fm_module,
            "cleanup_session",
            new=MagicMock(return_value=3),
        ) as mock_cleanup:
            await adapter._dispatcher.dispatch(cmd)

        mock_cleanup.assert_called_once_with("sess-xyz")

        results = [m for m in _sent_messages(send_json) if m.get("type") == "delete_session_attachments_result"]
        assert len(results) == 1
        assert results[0]["requestId"] == "req-del-1"
        assert results[0]["cleaned"] is True
        assert results[0]["files_removed"] == 3

    @pytest.mark.asyncio
    async def test_missing_session_id_returns_invalid_request_error(self):
        adapter = _make_adapter()
        send_json = _attach_ws(adapter)

        cmd = {
            "type": CMD_DELETE_SESSION_ATTACHMENTS,
            "requestId": "req-del-2",
            # session_id 누락
        }

        await adapter._dispatcher.dispatch(cmd)

        errors = [m for m in _sent_messages(send_json) if m.get("type") == EVT_ERROR]
        assert len(errors) == 1
        assert errors[0]["message"].startswith("INVALID_REQUEST:")


# ─── download_attachment (Phase 2 — atom 260513.02) ──


class TestHandleDownloadAttachment:
    """채팅 영역 인라인 표시용 다운로드 핸들러."""

    @pytest.mark.asyncio
    async def test_success_reads_file_and_returns_b64(self, tmp_path):
        """정상 흐름 — file_manager.is_under_base 통과 + read_bytes → base64 응답."""
        adapter = _make_adapter()
        send_json = _attach_ws(adapter)

        # 임시 디렉토리를 base_dir로 사용하는 FileManager singleton 교체
        from soul_server.service import file_manager as fm_module
        from soul_server.service.file_manager import FileManager
        photo = tmp_path / "session-1" / "001_photo.png"
        photo.parent.mkdir(parents=True)
        photo.write_bytes(b"\x89PNG\r\nbinarycontent")

        from unittest.mock import patch
        original_base = fm_module._base_dir
        fm_module._base_dir = tmp_path
        try:
            cmd = {
                "type": CMD_DOWNLOAD_ATTACHMENT,
                "requestId": "req-dl-1",
                "path": str(photo),
            }
            await adapter._dispatcher.dispatch(cmd)
        finally:
            fm_module._base_dir = original_base

        results = [m for m in _sent_messages(send_json) if m.get("type") == "download_attachment_result"]
        assert len(results) == 1
        assert results[0]["requestId"] == "req-dl-1"
        decoded = base64.b64decode(results[0]["content_b64"])
        assert decoded == b"\x89PNG\r\nbinarycontent"
        assert results[0]["filename"] == "001_photo.png"
        assert results[0]["content_type"] == "image/png"
        assert results[0]["size"] == len(b"\x89PNG\r\nbinarycontent")

    @pytest.mark.asyncio
    async def test_traversal_path_outside_base_returns_invalid_request(self, tmp_path):
        """base_dir 바깥 경로(예: `/etc/passwd`) → INVALID_REQUEST."""
        adapter = _make_adapter()
        send_json = _attach_ws(adapter)

        from soul_server.service import file_manager as fm_module
        original_base = fm_module._base_dir
        fm_module._base_dir = tmp_path
        try:
            cmd = {
                "type": CMD_DOWNLOAD_ATTACHMENT,
                "requestId": "req-dl-traversal",
                "path": "/etc/passwd",
            }
            await adapter._dispatcher.dispatch(cmd)
        finally:
            fm_module._base_dir = original_base

        errors = [m for m in _sent_messages(send_json) if m.get("type") == EVT_ERROR]
        assert len(errors) == 1
        assert errors[0]["message"].startswith("INVALID_REQUEST:")

    @pytest.mark.asyncio
    async def test_missing_file_returns_not_found(self, tmp_path):
        """base_dir 하위지만 파일 없음 → NOT_FOUND."""
        adapter = _make_adapter()
        send_json = _attach_ws(adapter)

        from soul_server.service import file_manager as fm_module
        original_base = fm_module._base_dir
        fm_module._base_dir = tmp_path
        try:
            cmd = {
                "type": CMD_DOWNLOAD_ATTACHMENT,
                "requestId": "req-dl-missing",
                "path": str(tmp_path / "does-not-exist.png"),
            }
            await adapter._dispatcher.dispatch(cmd)
        finally:
            fm_module._base_dir = original_base

        errors = [m for m in _sent_messages(send_json) if m.get("type") == EVT_ERROR]
        assert len(errors) == 1
        assert errors[0]["message"].startswith("NOT_FOUND:")

    @pytest.mark.asyncio
    async def test_missing_path_returns_invalid_request(self):
        adapter = _make_adapter()
        send_json = _attach_ws(adapter)

        cmd = {
            "type": CMD_DOWNLOAD_ATTACHMENT,
            "requestId": "req-dl-no-path",
            # path 누락
        }
        await adapter._dispatcher.dispatch(cmd)

        errors = [m for m in _sent_messages(send_json) if m.get("type") == EVT_ERROR]
        assert len(errors) == 1
        assert errors[0]["message"].startswith("INVALID_REQUEST:")

    @pytest.mark.asyncio
    async def test_empty_path_returns_invalid_request(self):
        adapter = _make_adapter()
        send_json = _attach_ws(adapter)

        cmd = {
            "type": CMD_DOWNLOAD_ATTACHMENT,
            "requestId": "req-dl-empty",
            "path": "",
        }
        await adapter._dispatcher.dispatch(cmd)

        errors = [m for m in _sent_messages(send_json) if m.get("type") == EVT_ERROR]
        assert len(errors) == 1
        assert errors[0]["message"].startswith("INVALID_REQUEST:")
