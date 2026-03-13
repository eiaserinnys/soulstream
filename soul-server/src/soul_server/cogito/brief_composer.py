"""Cogito brief composer.

Collects reflection data from services declared in a cogito manifest
and writes a brief file (.md) for Claude Code to load as a project rule.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from cogito.manifest import compose as cogito_compose, load_manifest

logger = logging.getLogger(__name__)


class BriefComposer:
    """Composes a service brief from cogito reflection data.

    Reads a cogito manifest, queries internal services' ``/reflect`` endpoints,
    and assembles a YAML brief file that Claude Code loads as a project rule.

    Args:
        manifest_path: Absolute path to ``cogito-manifest.yaml``.
        output_dir: Directory where ``brief.md`` will be written.
            Typically ``{WORKSPACE_DIR}/.claude/rules/cogito/``.
    """

    def __init__(self, manifest_path: str, output_dir: str) -> None:
        self._manifest_path = manifest_path
        self._output_dir = Path(output_dir)

    async def compose(self) -> list[tuple[str, str, dict[str, Any]]]:
        """Collect reflection data from all services.

        Returns:
            List of ``(name, type, data)`` tuples where *name* is the service
            name from the manifest, *type* is ``"internal"`` or ``"external"``,
            and *data* is the reflection dict (or error stub).
        """
        manifest = load_manifest(self._manifest_path)
        services_spec = manifest.get("services", [])
        results = await cogito_compose(self._manifest_path)

        named: list[tuple[str, str, dict[str, Any]]] = []
        for spec, data in zip(services_spec, results, strict=True):
            name = spec.get("name", "unknown")
            svc_type = spec.get("type", "internal")
            named.append((name, svc_type, data))
        return named

    async def write_brief(self) -> Path:
        """Compose brief and write to file.

        Returns:
            Path to the written brief file.
        """
        services = await self.compose()
        self._output_dir.mkdir(parents=True, exist_ok=True)
        output_path = self._output_dir / "brief.md"
        content = self._format_as_rule(services)
        output_path.write_text(content, encoding="utf-8")
        logger.info("Brief written to %s (%d services)", output_path, len(services))
        return output_path

    @staticmethod
    def _format_as_rule(services: list[tuple[str, str, dict[str, Any]]]) -> str:
        """Format service reflection data as a rule file.

        The output is designed to be loaded by Claude Code as a project rule
        (``setting_sources=["project"]``).
        """
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S%z")
        lines = [
            "# Cogito Service Brief",
            "# Auto-generated file — do not edit manually",
            f"# Generated: {now}",
            "#",
            "# 이 파일은 cogito 프로토콜에 의해 자동 생성됩니다.",
            "# 각 서비스의 /reflect 엔드포인트에서 수집한 최신 상태입니다.",
            "#",
            "# 아래 서비스에 대한 상세 정보(소스 코드 위치, 설정, API 명세 등)가 필요하면",
            "# soulstream-cogito MCP 도구를 사용하세요:",
            "#   - reflect_service(name, level) : 개별 서비스의 상세 리플렉션 (level 0~3)",
            "#   - reflect_brief() : 전체 서비스 브리프 재조회",
            "#   - reflect_refresh() : 브리프 파일 즉시 갱신",
            "",
            "services:",
        ]

        for name, svc_type, data in services:
            identity = data.get("identity", {})
            capabilities = data.get("capabilities", [])
            error = data.get("error")

            description = identity.get("description", "")
            port = identity.get("port")
            status = identity.get("status")
            if status is None:
                status = "unreachable" if error else "healthy"

            lines.append(f"  {name}:")
            if description:
                safe_desc = str(description).replace("\\", "\\\\").replace('"', '\\"')
                lines.append(f'    description: "{safe_desc}"')
            if port is not None:
                lines.append(f"    port: {port}")
            if svc_type == "external":
                lines.append("    type: external")
            lines.append(f"    status: {status}")

            if error:
                # Collapse newlines and escape for single-line YAML value
                safe_error = (
                    str(error)
                    .replace("\n", " ")
                    .replace("\r", "")
                    .replace("\\", "\\\\")
                    .replace('"', '\\"')
                )
                lines.append(f'    error: "{safe_error}"')

            if capabilities:
                lines.append("    capabilities:")
                for cap in capabilities:
                    if isinstance(cap, dict):
                        cap_name = cap.get("name", "")
                        cap_desc = cap.get("description", "")
                        if cap_desc:
                            lines.append(f"      - {cap_name} ({cap_desc})")
                        else:
                            lines.append(f"      - {cap_name}")
                    else:
                        lines.append(f"      - {cap}")
            lines.append("")

        return "\n".join(lines)
