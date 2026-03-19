"""
test_brief_composer — BriefComposer 유닛/통합 테스트

cogito manifest를 읽고 서비스 리플렉션 데이터를 수집하여
brief.md를 생성하는 기능을 검증합니다.
"""

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# === Fixtures ===


@pytest.fixture
def manifest_file(tmp_path: Path) -> Path:
    """최소한의 cogito manifest 파일."""
    manifest = tmp_path / "cogito-manifest.yaml"
    manifest.write_text(
        """\
services:
  - name: svc-internal
    endpoint: http://localhost:9999/reflect
    type: internal
  - name: svc-external
    type: external
    static:
      identity:
        name: svc-external
        description: "An external MCP server"
        port: 1234
      capabilities:
        - name: feature_a
          description: "Feature A"
""",
        encoding="utf-8",
    )
    return manifest


@pytest.fixture
def output_dir(tmp_path: Path) -> Path:
    return tmp_path / "rules" / "cogito"


# === _format_as_rule ===


class TestFormatAsRule:
    """_format_as_rule 정적 메서드 검증."""

    def _import(self):
        from soul_server.cogito.brief_composer import BriefComposer

        return BriefComposer

    def test_includes_generated_timestamp(self):
        cls = self._import()
        services = [("svc", "internal", {"identity": {"name": "svc"}, "capabilities": []})]
        content = cls._format_as_rule(services)
        assert "Generated:" in content

    def test_healthy_internal_service(self):
        cls = self._import()
        services = [
            (
                "my-svc",
                "internal",
                {
                    "identity": {"name": "my-svc", "description": "My service", "port": 8080},
                    "capabilities": [{"name": "cap1", "description": "Cap one"}],
                },
            ),
        ]
        content = cls._format_as_rule(services)
        assert "my-svc:" in content
        assert 'description: "My service"' in content
        assert "port: 8080" in content
        assert "status: healthy" in content
        assert "cap1 (Cap one)" in content
        # Internal services should NOT have type: external
        assert "type: external" not in content

    def test_external_service_marked(self):
        cls = self._import()
        services = [
            (
                "ext",
                "external",
                {
                    "identity": {"name": "ext", "description": "External", "port": 3101},
                    "capabilities": [],
                },
            ),
        ]
        content = cls._format_as_rule(services)
        assert "type: external" in content

    def test_unreachable_service(self):
        cls = self._import()
        services = [
            (
                "dead",
                "internal",
                {
                    "identity": {"name": "dead", "status": "unreachable"},
                    "error": "Connection refused",
                },
            ),
        ]
        content = cls._format_as_rule(services)
        assert "status: unreachable" in content
        assert "Connection refused" in content

    def test_error_implies_unreachable(self):
        """identity에 status가 없지만 error가 있으면 unreachable로 추론."""
        cls = self._import()
        services = [
            (
                "bad",
                "internal",
                {
                    "identity": {"name": "bad"},
                    "error": "timeout",
                },
            ),
        ]
        content = cls._format_as_rule(services)
        assert "status: unreachable" in content

    def test_multiple_capabilities(self):
        cls = self._import()
        services = [
            (
                "multi",
                "internal",
                {
                    "identity": {"name": "multi"},
                    "capabilities": [
                        {"name": "a", "description": "Alpha"},
                        {"name": "b", "description": "Beta"},
                        {"name": "c"},  # description 없는 경우
                    ],
                },
            ),
        ]
        content = cls._format_as_rule(services)
        assert "a (Alpha)" in content
        assert "b (Beta)" in content
        assert "      - c" in content

    def test_description_with_quotes_escaped(self):
        cls = self._import()
        services = [
            (
                "q",
                "internal",
                {
                    "identity": {"name": "q", "description": 'He said "hello"'},
                    "capabilities": [],
                },
            ),
        ]
        content = cls._format_as_rule(services)
        assert r'He said \"hello\"' in content

    def test_error_newlines_collapsed(self):
        """에러 메시지의 줄바꿈이 공백으로 치환되어 YAML이 깨지지 않음."""
        cls = self._import()
        services = [
            (
                "bad",
                "internal",
                {
                    "identity": {"name": "bad", "status": "unreachable"},
                    "error": "404 Not Found\nFor more info: https://example.com",
                },
            ),
        ]
        content = cls._format_as_rule(services)
        # Newline should be collapsed to space
        assert "404 Not Found For more info:" in content
        # Should be a single line
        error_line = [l for l in content.split("\n") if "error:" in l][0]
        assert "\n" not in error_line.strip()


# === compose / write_brief ===


class TestBriefComposer:
    """BriefComposer의 compose/write_brief 검증."""

    @pytest.mark.asyncio
    async def test_compose_returns_named_tuples(self, manifest_file, output_dir):
        from soul_server.cogito.brief_composer import BriefComposer

        mock_manifest = {
            "services": [
                {"name": "svc-internal", "endpoint": "http://localhost:9999/reflect", "type": "internal"},
                {"name": "svc-external", "type": "external"},
            ]
        }
        mock_results = [
            {
                "identity": {"name": "svc-internal", "description": "Internal", "port": 9999},
                "capabilities": [{"name": "cap1", "description": "C1"}],
            },
            {
                "identity": {"name": "svc-external", "description": "An external MCP server", "port": 1234},
                "capabilities": [{"name": "feature_a", "description": "Feature A"}],
            },
        ]

        with (
            patch("soul_server.cogito.brief_composer.load_manifest", return_value=mock_manifest),
            patch("soul_server.cogito.brief_composer.cogito_compose", new_callable=AsyncMock) as mock_compose,
        ):
            mock_compose.return_value = mock_results
            composer = BriefComposer(manifest_path=str(manifest_file), output_dir=str(output_dir))
            result = await composer.compose()

        assert len(result) == 2
        assert result[0] == ("svc-internal", "internal", mock_results[0])
        assert result[1] == ("svc-external", "external", mock_results[1])

    @pytest.mark.asyncio
    async def test_write_brief_creates_file(self, manifest_file, output_dir):
        from soul_server.cogito.brief_composer import BriefComposer

        mock_manifest = {
            "services": [
                {"name": "svc-internal", "endpoint": "http://localhost:9999/reflect", "type": "internal"},
                {"name": "svc-external", "type": "external"},
            ]
        }
        mock_results = [
            {
                "identity": {"name": "svc-internal", "description": "Internal", "port": 9999},
                "capabilities": [{"name": "cap1", "description": "C1"}],
            },
            {
                "identity": {"name": "svc-external", "description": "External", "port": 1234},
                "capabilities": [{"name": "feature_a", "description": "Feature A"}],
            },
        ]

        with (
            patch("soul_server.cogito.brief_composer.load_manifest", return_value=mock_manifest),
            patch("soul_server.cogito.brief_composer.cogito_compose", new_callable=AsyncMock) as mock_compose,
        ):
            mock_compose.return_value = mock_results
            composer = BriefComposer(manifest_path=str(manifest_file), output_dir=str(output_dir))
            path = await composer.write_brief()

        assert path.exists()
        content = path.read_text(encoding="utf-8")
        assert "svc-internal:" in content
        assert "svc-external:" in content
        assert "cap1 (C1)" in content
        assert "feature_a (Feature A)" in content

    @pytest.mark.asyncio
    async def test_write_brief_creates_output_dir(self, manifest_file, tmp_path):
        """output_dir이 존재하지 않아도 자동 생성."""
        from soul_server.cogito.brief_composer import BriefComposer

        mock_manifest = {
            "services": [
                {"name": "s", "type": "internal"},
                {"name": "e", "type": "external"},
            ]
        }
        deep_dir = tmp_path / "a" / "b" / "c"
        assert not deep_dir.exists()

        with (
            patch("soul_server.cogito.brief_composer.load_manifest", return_value=mock_manifest),
            patch("soul_server.cogito.brief_composer.cogito_compose", new_callable=AsyncMock) as mock_compose,
        ):
            mock_compose.return_value = [
                {"identity": {"name": "s"}, "capabilities": []},
                {"identity": {"name": "e"}, "capabilities": []},
            ]
            composer = BriefComposer(manifest_path=str(manifest_file), output_dir=str(deep_dir))
            path = await composer.write_brief()

        assert path.exists()
        assert deep_dir.exists()

    @pytest.mark.asyncio
    async def test_unreachable_service_included(self, manifest_file, output_dir):
        """조회 실패한 서비스도 brief에 포함 (status: unreachable)."""
        from soul_server.cogito.brief_composer import BriefComposer

        mock_manifest = {
            "services": [
                {"name": "svc-internal", "endpoint": "http://localhost:9999/reflect", "type": "internal"},
                {"name": "svc-external", "type": "external"},
            ]
        }
        mock_results = [
            {
                "identity": {"name": "http://localhost:9999/reflect", "status": "unreachable"},
                "error": "Connection refused",
            },
            {
                "identity": {"name": "svc-external", "description": "External", "port": 1234},
                "capabilities": [{"name": "feature_a", "description": "Feature A"}],
            },
        ]

        with (
            patch("soul_server.cogito.brief_composer.load_manifest", return_value=mock_manifest),
            patch("soul_server.cogito.brief_composer.cogito_compose", new_callable=AsyncMock) as mock_compose,
        ):
            mock_compose.return_value = mock_results
            composer = BriefComposer(manifest_path=str(manifest_file), output_dir=str(output_dir))
            path = await composer.write_brief()

        content = path.read_text(encoding="utf-8")
        # 매니페스트의 name이 사용되어야 함 (endpoint URL이 아닌)
        assert "svc-internal:" in content
        assert "unreachable" in content
        assert "Connection refused" in content


# === engine_adapter 통합 ===


class TestEngineAdapterIntegration:
    """SoulEngineAdapter와 BriefComposer의 통합 검증."""

    @pytest.mark.asyncio
    async def test_execute_calls_write_brief(self):
        """execute() 시작 시 brief 갱신이 호출된다."""
        from soul_server.service.engine_adapter import SoulEngineAdapter

        mock_composer = MagicMock()
        mock_composer.write_brief = AsyncMock(return_value=Path("/tmp/brief.md"))

        adapter = SoulEngineAdapter(
            workspace_dir="/tmp/ws",
            brief_composer=mock_composer,
        )

        # execute()는 async generator이므로 첫 iteration만 해도 충분
        # ClaudeRunner를 모킹하여 즉시 완료
        mock_runner = MagicMock()
        mock_result = MagicMock()
        mock_result.result = "done"
        mock_result.usage = None
        mock_result.session_id = "sess-1"
        mock_result.events = []
        mock_runner.run = AsyncMock(return_value=mock_result)

        mock_pool = MagicMock()
        mock_pool.acquire = AsyncMock(return_value=mock_runner)
        mock_pool.release = AsyncMock()
        adapter._pool = mock_pool

        events = []
        async for event in adapter.execute("test prompt"):
            events.append(event)

        mock_composer.write_brief.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_execute_continues_on_brief_failure(self):
        """brief 갱신이 실패해도 세션은 정상 진행된다."""
        from soul_server.service.engine_adapter import SoulEngineAdapter

        mock_composer = MagicMock()
        mock_composer.write_brief = AsyncMock(side_effect=RuntimeError("manifest not found"))

        adapter = SoulEngineAdapter(
            workspace_dir="/tmp/ws",
            brief_composer=mock_composer,
        )

        mock_runner = MagicMock()
        mock_result = MagicMock()
        mock_result.result = "done"
        mock_result.usage = None
        mock_result.session_id = "sess-2"
        mock_result.events = []
        mock_runner.run = AsyncMock(return_value=mock_result)

        mock_pool = MagicMock()
        mock_pool.acquire = AsyncMock(return_value=mock_runner)
        mock_pool.release = AsyncMock()
        adapter._pool = mock_pool

        events = []
        async for event in adapter.execute("test prompt"):
            events.append(event)

        # 실패했지만 세션은 완료됨
        mock_composer.write_brief.assert_awaited_once()
        assert len(events) > 0  # 최소한 CompleteEvent는 있어야 함

    @pytest.mark.asyncio
    async def test_execute_without_brief_composer(self):
        """brief_composer가 None이면 브리프 갱신을 건너뛴다."""
        from soul_server.service.engine_adapter import SoulEngineAdapter

        adapter = SoulEngineAdapter(
            workspace_dir="/tmp/ws",
            brief_composer=None,
        )

        mock_runner = MagicMock()
        mock_result = MagicMock()
        mock_result.result = "done"
        mock_result.usage = None
        mock_result.session_id = "sess-3"
        mock_result.events = []
        mock_runner.run = AsyncMock(return_value=mock_result)

        mock_pool = MagicMock()
        mock_pool.acquire = AsyncMock(return_value=mock_runner)
        mock_pool.release = AsyncMock()
        adapter._pool = mock_pool

        events = []
        async for event in adapter.execute("test prompt"):
            events.append(event)

        # 에러 없이 완료
        assert len(events) > 0
