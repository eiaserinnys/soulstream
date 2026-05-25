"""
test_brief_composer — Cogito runtime brief tests.

The composer gathers reflection data for MCP responses. It must not create
or refresh local ``brief.md`` rule files.
"""

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture
def manifest_file(tmp_path: Path) -> Path:
    """Minimal cogito manifest file."""
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


class TestBriefComposer:
    """BriefComposer compose-only behavior."""

    @pytest.mark.asyncio
    async def test_compose_returns_named_tuples(self, manifest_file):
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
            composer = BriefComposer(manifest_path=str(manifest_file))
            result = await composer.compose()

        assert len(result) == 2
        assert result[0] == ("svc-internal", "internal", mock_results[0])
        assert result[1] == ("svc-external", "external", mock_results[1])

    @pytest.mark.asyncio
    async def test_compose_does_not_create_legacy_brief_file(self, manifest_file, tmp_path):
        from soul_server.cogito.brief_composer import BriefComposer

        legacy_brief = tmp_path / "workspace" / ".claude" / "rules" / "cogito" / "brief.md"
        mock_manifest = {"services": [{"name": "svc", "type": "internal"}]}

        with (
            patch("soul_server.cogito.brief_composer.load_manifest", return_value=mock_manifest),
            patch("soul_server.cogito.brief_composer.cogito_compose", new_callable=AsyncMock) as mock_compose,
        ):
            mock_compose.return_value = [{"identity": {"name": "svc"}, "capabilities": []}]
            composer = BriefComposer(manifest_path=str(manifest_file))
            assert not hasattr(composer, "write_brief")
            result = await composer.compose()

        assert result == [("svc", "internal", {"identity": {"name": "svc"}, "capabilities": []})]
        assert not legacy_brief.exists()
        assert not legacy_brief.parent.exists()


class TestEngineAdapterIntegration:
    """SoulEngineAdapter no longer refreshes cogito files at session start."""

    @pytest.mark.asyncio
    async def test_execute_has_no_brief_writer_dependency(self):
        from soul_server.service.engine_adapter import SoulEngineAdapter

        adapter = SoulEngineAdapter(workspace_dir="/tmp/ws")
        assert not hasattr(adapter, "_brief_composer")

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

        assert len(events) > 0
