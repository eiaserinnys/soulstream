"""Tests for orchestrator cogito brief aggregation."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest

from soulstream_server.api.cogito import collect_cogito_briefs


pytestmark = pytest.mark.asyncio


async def _register_node(
    node_manager,
    node_id: str,
    host: str = "localhost",
    port: int = 4100,
    capabilities: dict | None = None,
):
    ws = AsyncMock()
    ws.send_json = AsyncMock()
    ws.close = AsyncMock()
    node = await node_manager.register_node(
        ws,
        {
            "node_id": node_id,
            "host": host,
            "port": port,
            "capabilities": (
                capabilities if capabilities is not None else {"reflect_brief": True}
            ),
            "agents": [],
            "user": {},
        },
    )
    return node, ws


def _brief(node_id: str) -> dict:
    return {
        "schema_version": "soulstream.reflect.v1",
        "kind": "compact_aggregate",
        "status": "ok",
        "services": [
            {
                "name": "soul-server-ts",
                "type": "internal",
                "data": {"node_id": node_id},
            }
        ],
    }


class TestCogitoBriefsApi:
    async def test_returns_empty_aggregate_when_no_nodes(self, client):
        resp = await client.get("/cogito/briefs")

        assert resp.status_code == 200
        body = resp.json()
        assert body["schema_version"] == "soulstream.reflect.aggregate.v1"
        assert body["kind"] == "orchestrator_node_brief_aggregate"
        assert body["status"] == "empty"
        assert body["node_count"] == 0
        assert body["nodes"] == []
        assert body["source"] == {
            "type": "orchestrator",
            "transport": "node_ws_command",
            "command": "reflect_brief",
        }

    async def test_skips_nodes_without_reflect_brief_capability(self, client, node_manager):
        _node, ws = await _register_node(
            node_manager,
            "legacy-python-node",
            capabilities={},
        )

        resp = await client.get("/cogito/briefs")

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "empty"
        assert body["node_count"] == 0
        assert body["nodes"] == []
        ws.send_json.assert_not_called()

    async def test_collects_node_briefs_over_ws_command(self, client, node_manager):
        node, ws = await _register_node(node_manager, "node-a")

        async def resolve_future(data):
            req_id = data["requestId"]
            node._pending[req_id].set_result({
                "type": "reflect_brief",
                "requestId": req_id,
                "ok": True,
                "checked_at": "2026-05-25T20:41:00.000Z",
                "brief": _brief("node-a"),
            })

        ws.send_json.side_effect = resolve_future

        resp = await client.get("/cogito/briefs")

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert body["node_count"] == 1
        assert body["nodes"][0]["node_id"] == "node-a"
        assert body["nodes"][0]["status"] == "ok"
        assert body["nodes"][0]["checked_at"] == "2026-05-25T20:41:00.000Z"
        assert body["nodes"][0]["source"] == {
            "type": "node",
            "transport": "websocket",
            "command": "reflect_brief",
        }
        assert body["nodes"][0]["data"]["services"][0]["data"]["node_id"] == "node-a"
        sent = ws.send_json.call_args[0][0]
        assert sent["type"] == "reflect_brief"
        assert sent["requestId"].startswith("req-")

    async def test_partial_failure_isolated_per_node(self, client, node_manager):
        ok_node, ok_ws = await _register_node(node_manager, "node-ok", port=4100)
        err_node, _ = await _register_node(node_manager, "node-slow", port=4101)

        async def resolve_ok(data):
            req_id = data["requestId"]
            ok_node._pending[req_id].set_result({
                "type": "reflect_brief",
                "requestId": req_id,
                "ok": True,
                "checked_at": "2026-05-25T20:41:00.000Z",
                "brief": _brief("node-ok"),
            })

        ok_ws.send_json.side_effect = resolve_ok
        err_node.send_reflect_brief = AsyncMock(side_effect=TimeoutError("slow node"))

        resp = await client.get("/cogito/briefs?timeout=0.05")

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "partial"
        by_id = {entry["node_id"]: entry for entry in body["nodes"]}
        assert by_id["node-ok"]["status"] == "ok"
        assert by_id["node-slow"]["status"] == "timeout"
        assert by_id["node-slow"]["errors"] == [
            {"code": "node_timeout", "message": "slow node"}
        ]


class TestCogitoBriefCollection:
    async def test_node_collection_starts_nodes_concurrently(self):
        started: list[str] = []
        release = asyncio.Event()

        class BlockingNode:
            def __init__(self, node_id: str):
                self.node_id = node_id
                self.capabilities = {"reflect_brief": True}

            async def send_reflect_brief(self, timeout: float) -> dict:
                started.append(self.node_id)
                if len(started) == 2:
                    release.set()
                await asyncio.wait_for(release.wait(), timeout=timeout)
                return {
                    "type": "reflect_brief",
                    "requestId": f"req-{self.node_id}",
                    "ok": True,
                    "checked_at": "2026-05-25T20:41:00.000Z",
                    "brief": _brief(self.node_id),
                }

        class FakeNodeManager:
            def get_connected_nodes(self):
                return [BlockingNode("node-a"), BlockingNode("node-b")]

        body = await collect_cogito_briefs(FakeNodeManager(), per_node_timeout=0.05)

        assert body["status"] == "ok"
        assert started == ["node-a", "node-b"]
        assert [entry["status"] for entry in body["nodes"]] == ["ok", "ok"]
