"""Cogito runtime brief composer.

Collects reflection data from services declared in a cogito manifest.
The brief is returned to callers in memory; soulstream no longer persists
auto-generated cogito brief files.
"""

from __future__ import annotations

from typing import Any

from cogito.manifest import compose as cogito_compose, load_manifest


class BriefComposer:
    """Composes a service brief from cogito reflection data.

    Reads a cogito manifest and queries internal services' ``/reflect``
    endpoints. The result is consumed by runtime MCP tools.

    Args:
        manifest_path: Absolute path to ``cogito-manifest.yaml``.
    """

    def __init__(self, manifest_path: str) -> None:
        self._manifest_path = manifest_path

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
