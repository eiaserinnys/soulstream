"""
test_file_upload_session - 세션 기반 파일 업로드 API 테스트

Phase 1 구현 항목:
1. FileManager.save_file_for_session() — session_id 기반 파일 저장
2. FileManager.cleanup_session() — session_id 기반 정리
3. POST /attachments/sessions — 세션 파일 업로드 엔드포인트
4. DELETE /attachments/sessions/{session_id} — 세션 파일 정리 엔드포인트
5. CreateSessionBody.attachmentPaths 필드 및 context_items 주입
6. adapter._handle_intervene attachment_paths 전달
"""

import io
import pytest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient


# ── FileManager 단위 테스트 ──────────────────────────────────────────────────

class TestFileManagerSessionMethods:
    """FileManager.save_file_for_session() 및 cleanup_session() 테스트"""

    @pytest.fixture
    def tmp_base_dir(self, tmp_path):
        return tmp_path / "incoming"

    @pytest.fixture
    def manager(self, tmp_base_dir):
        from soul_server.service.file_manager import FileManager
        return FileManager(base_dir=str(tmp_base_dir))

    @pytest.mark.asyncio
    async def test_save_file_for_session_creates_file(self, manager, tmp_base_dir):
        """session_id 디렉토리에 파일이 저장된다"""
        result = await manager.save_file_for_session(
            filename="test.txt",
            content=b"hello world",
            session_id="sess-abc123",
        )

        assert result["size"] == 11
        assert result["filename"].endswith("test.txt")
        assert "sess-abc123" in result["path"]
        assert Path(result["path"]).exists()

    @pytest.mark.asyncio
    async def test_save_file_for_session_returns_absolute_path(self, manager):
        """반환된 path가 절대 경로이다"""
        result = await manager.save_file_for_session(
            filename="doc.pdf",
            content=b"pdf content",
            session_id="sess-xyz",
        )
        assert Path(result["path"]).is_absolute()

    @pytest.mark.asyncio
    async def test_save_file_for_session_content_type(self, manager):
        """MIME 타입이 올바르게 추측된다"""
        result = await manager.save_file_for_session(
            filename="image.png",
            content=b"\x89PNG",
            session_id="sess-img",
        )
        assert result["content_type"] == "image/png"

    @pytest.mark.asyncio
    async def test_save_file_for_session_unknown_content_type(self, manager):
        """알 수 없는 확장자는 application/octet-stream 또는 시스템 추측값"""
        result = await manager.save_file_for_session(
            filename="data.nodots_unusual_ext_abc123",
            content=b"raw data",
            session_id="sess-bin",
        )
        assert result["content_type"] == "application/octet-stream"

    @pytest.mark.asyncio
    async def test_save_file_for_session_validates_size(self, manager):
        """파일 크기 초과 시 AttachmentError 발생"""
        from soul_server.service.file_manager import AttachmentError
        huge_content = b"x" * (manager._max_size + 1)
        with pytest.raises(AttachmentError, match="너무 큽니다"):
            await manager.save_file_for_session(
                filename="huge.txt",
                content=huge_content,
                session_id="sess-big",
            )

    @pytest.mark.asyncio
    async def test_save_file_for_session_validates_extension(self, manager):
        """위험 확장자는 AttachmentError 발생"""
        from soul_server.service.file_manager import AttachmentError
        with pytest.raises(AttachmentError, match="허용되지 않는"):
            await manager.save_file_for_session(
                filename="private.env",
                content=b"SECRET=abc",
                session_id="sess-evil",
            )

    @pytest.mark.asyncio
    async def test_cleanup_session_removes_directory(self, manager, tmp_base_dir):
        """cleanup_session()이 session 디렉토리를 삭제한다"""
        session_id = "sess-clean"
        await manager.save_file_for_session(
            filename="a.txt", content=b"a", session_id=session_id
        )
        await manager.save_file_for_session(
            filename="b.txt", content=b"b", session_id=session_id
        )

        session_dir = tmp_base_dir / session_id
        assert session_dir.exists()

        removed = manager.cleanup_session(session_id)
        assert removed == 2
        assert not session_dir.exists()

    def test_cleanup_session_nonexistent(self, manager):
        """없는 session_id는 0 반환"""
        result = manager.cleanup_session("nonexistent-session")
        assert result == 0

    @pytest.mark.asyncio
    async def test_flat_structure_compatible_with_cleanup_old_files(self, manager, tmp_base_dir):
        """session_id 디렉토리가 _base_dir 직하에 생성되어 cleanup_old_files가 인식한다"""
        session_id = "sess-flat"
        await manager.save_file_for_session(
            filename="f.txt", content=b"f", session_id=session_id
        )
        session_dir = tmp_base_dir / session_id
        assert session_dir.exists()
        # _base_dir.iterdir()에서 해당 디렉토리가 보여야 함
        subdirs = [d.name for d in tmp_base_dir.iterdir() if d.is_dir()]
        assert session_id in subdirs


# ── POST /attachments/sessions 엔드포인트 테스트 ───────────────────────────

class TestUploadSessionAttachmentEndpoint:
    """POST /attachments/sessions 엔드포인트 테스트"""

    @pytest.fixture
    def app_with_attachments(self, tmp_path):
        from fastapi import FastAPI
        from soul_server.api.attachments import router
        from soul_server.service.file_manager import FileManager
        import soul_server.api.attachments as att_module

        # 임시 디렉토리의 FileManager로 교체
        test_manager = FileManager(base_dir=str(tmp_path / "incoming"))
        att_module.file_manager = test_manager

        app = FastAPI()
        app.include_router(router, prefix="/attachments")
        return app, test_manager

    def test_upload_session_attachment_success(self, app_with_attachments):
        """정상 업로드 시 path, filename, size, content_type 반환"""
        app, manager = app_with_attachments
        client = TestClient(app)

        resp = client.post(
            "/attachments/sessions",
            data={"session_id": "sess-test"},
            files={"file": ("hello.txt", io.BytesIO(b"hello"), "text/plain")},
        )

        assert resp.status_code == 201
        data = resp.json()
        assert data["size"] == 5
        assert data["filename"].endswith("hello.txt")
        assert "sess-test" in data["path"]
        assert Path(data["path"]).exists()

    def test_upload_session_attachment_invalid_extension(self, app_with_attachments):
        """위험 확장자 파일은 400"""
        app, _ = app_with_attachments
        client = TestClient(app)

        resp = client.post(
            "/attachments/sessions",
            data={"session_id": "sess-evil"},
            files={"file": ("secret.env", io.BytesIO(b"SECRET=abc"), "text/plain")},
        )
        assert resp.status_code == 400

    def test_upload_session_attachment_no_auth_required(self, app_with_attachments):
        """세션 업로드 엔드포인트는 인증 헤더 없이도 동작한다 (내부 프록시 호환)"""
        app, _ = app_with_attachments
        client = TestClient(app)

        # Authorization 헤더 없이 요청
        resp = client.post(
            "/attachments/sessions",
            data={"session_id": "sess-noauth"},
            files={"file": ("doc.txt", io.BytesIO(b"content"), "text/plain")},
        )
        assert resp.status_code == 201


# ── DELETE /attachments/sessions/{session_id} 테스트 ──────────────────────

class TestCleanupSessionAttachmentEndpoint:
    """DELETE /attachments/sessions/{session_id} 엔드포인트 테스트"""

    @pytest.fixture
    def app_with_attachments(self, tmp_path):
        from fastapi import FastAPI
        from soul_server.api.attachments import router
        from soul_server.service.file_manager import FileManager
        import soul_server.api.attachments as att_module

        test_manager = FileManager(base_dir=str(tmp_path / "incoming"))
        att_module.file_manager = test_manager

        app = FastAPI()
        app.include_router(router, prefix="/attachments")
        return app, test_manager

    @pytest.mark.asyncio
    async def test_cleanup_session_attachment_success(self, app_with_attachments):
        """파일 업로드 후 DELETE 시 정리되고 files_removed 반환"""
        app, manager = app_with_attachments
        client = TestClient(app)

        # 미리 파일 업로드
        await manager.save_file_for_session(
            filename="to_delete.txt", content=b"bye", session_id="sess-del"
        )

        resp = client.delete("/attachments/sessions/sess-del")
        assert resp.status_code == 200
        data = resp.json()
        assert data["cleaned"] is True
        assert data["files_removed"] == 1

    def test_cleanup_session_nonexistent(self, app_with_attachments):
        """없는 session_id DELETE 시 files_removed=0"""
        app, _ = app_with_attachments
        client = TestClient(app)

        resp = client.delete("/attachments/sessions/no-such-session")
        assert resp.status_code == 200
        data = resp.json()
        assert data["cleaned"] is True
        assert data["files_removed"] == 0

    def test_cleanup_session_no_auth_required(self, app_with_attachments):
        """DELETE 엔드포인트도 인증 불필요"""
        app, _ = app_with_attachments
        client = TestClient(app)

        resp = client.delete("/attachments/sessions/some-session")
        assert resp.status_code == 200

    def test_sessions_route_not_shadowed_by_thread_id_route(self, app_with_attachments):
        """DELETE /sessions/{id}가 DELETE /{thread_id} 패턴에 가려지지 않는다"""
        app, _ = app_with_attachments
        client = TestClient(app)

        # "sessions"는 int로 변환 불가이므로 /{thread_id} 패턴에 매칭되면 422가 된다.
        # 올바른 라우팅이면 200이 반환되어야 한다.
        resp = client.delete("/attachments/sessions/sess-routing-test")
        assert resp.status_code == 200, (
            f"세션 DELETE가 thread_id 패턴에 가려져 {resp.status_code}를 반환했습니다"
        )


# ── CreateSessionBody.attachmentPaths + context_items 주입 테스트 ──────────

class TestCreateSessionWithAttachments:
    """POST /api/sessions에서 attachmentPaths → extra_context_items 주입 테스트"""

    @pytest.fixture
    def mock_task_manager(self):
        tm = MagicMock()
        task = MagicMock()
        task.agent_session_id = "sess-created"
        tm.create_task = AsyncMock(return_value=task)
        tm.start_execution = AsyncMock()
        return tm

    @pytest.mark.asyncio
    async def test_create_session_with_attachment_paths_injects_context(self, mock_task_manager):
        """attachmentPaths가 있으면 extra_context_items에 파일 경로 목록이 포함된다"""
        from soul_server.dashboard.api_router import router
        from soul_server.dashboard.auth import require_dashboard_auth
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        app = FastAPI()
        app.include_router(router)
        # dependency_overrides로 인증 바이패스
        app.dependency_overrides[require_dashboard_auth] = lambda: None

        with (
            patch("soul_server.dashboard.api_router.get_task_manager", return_value=mock_task_manager),
            patch("soul_server.dashboard.api_router.resource_manager") as mock_rm,
            patch("soul_server.dashboard.api_router.get_soul_engine", return_value=MagicMock()),
        ):
            mock_rm.can_acquire.return_value = True

            client = TestClient(app, raise_server_exceptions=True)
            resp = client.post(
                "/api/sessions",
                json={
                    "prompt": "test prompt",
                    "attachmentPaths": ["/path/to/file1.txt", "/path/to/file2.pdf"],
                },
            )

        assert resp.status_code == 201

        # create_task가 extra_context_items를 받았는지 확인
        call_kwargs = mock_task_manager.create_task.call_args.kwargs
        extra = call_kwargs.get("extra_context_items")
        assert extra is not None
        assert len(extra) == 1
        assert extra[0]["key"] == "attached_files"
        assert "/path/to/file1.txt" in extra[0]["content"]
        assert "/path/to/file2.pdf" in extra[0]["content"]

    @pytest.mark.asyncio
    async def test_create_session_without_attachment_paths(self, mock_task_manager):
        """attachmentPaths가 없으면 extra_context_items가 None 또는 미전달"""
        from soul_server.dashboard.api_router import router
        from soul_server.dashboard.auth import require_dashboard_auth
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        app = FastAPI()
        app.include_router(router)
        app.dependency_overrides[require_dashboard_auth] = lambda: None

        with (
            patch("soul_server.dashboard.api_router.get_task_manager", return_value=mock_task_manager),
            patch("soul_server.dashboard.api_router.resource_manager") as mock_rm,
            patch("soul_server.dashboard.api_router.get_soul_engine", return_value=MagicMock()),
        ):
            mock_rm.can_acquire.return_value = True

            client = TestClient(app, raise_server_exceptions=True)
            resp = client.post(
                "/api/sessions",
                json={"prompt": "test prompt"},
            )

        assert resp.status_code == 201

        call_kwargs = mock_task_manager.create_task.call_args.kwargs
        extra = call_kwargs.get("extra_context_items")
        # None이거나 빈 리스트여야 한다
        assert not extra


# ── adapter._handle_intervene attachment_paths 전달 테스트 ─────────────────

class TestAdapterHandleInterveneAttachmentPaths:
    """upstream/adapter.py _handle_intervene이 attachment_paths를 전달하는지 테스트"""

    @pytest.mark.asyncio
    async def test_handle_intervene_passes_attachment_paths(self):
        """cmd에 attachment_paths가 있으면 add_intervention에 전달된다"""
        from soul_server.upstream.adapter import UpstreamAdapter

        mock_tm = MagicMock()
        mock_tm.add_intervention = AsyncMock(return_value={})

        adapter = UpstreamAdapter.__new__(UpstreamAdapter)
        adapter._tm = mock_tm
        adapter._engine = MagicMock()
        adapter._rm = MagicMock()
        adapter._stream_tasks = {}
        adapter._send = AsyncMock()

        cmd = {
            "agentSessionId": "sess-intervene",
            "text": "hello",
            "user": "test-user",
            "attachment_paths": ["/path/file.txt"],
        }

        await adapter._handle_intervene(cmd)

        mock_tm.add_intervention.assert_called_once()
        call_kwargs = mock_tm.add_intervention.call_args.kwargs
        assert call_kwargs["attachment_paths"] == ["/path/file.txt"]

    @pytest.mark.asyncio
    async def test_handle_intervene_no_attachment_paths(self):
        """cmd에 attachment_paths가 없으면 None 전달"""
        from soul_server.upstream.adapter import UpstreamAdapter

        mock_tm = MagicMock()
        mock_tm.add_intervention = AsyncMock(return_value={})

        adapter = UpstreamAdapter.__new__(UpstreamAdapter)
        adapter._tm = mock_tm
        adapter._engine = MagicMock()
        adapter._rm = MagicMock()
        adapter._stream_tasks = {}
        adapter._send = AsyncMock()

        cmd = {
            "agentSessionId": "sess-no-attach",
            "text": "hello",
            "user": "test-user",
        }

        await adapter._handle_intervene(cmd)

        call_kwargs = mock_tm.add_intervention.call_args.kwargs
        assert call_kwargs.get("attachment_paths") is None
