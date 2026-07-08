import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(__dirname, "../../orch-server/tests/fixtures/orch_contract");

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(fixtureDir, name), "utf8")) as T;
}

type RouteFixture = {
  version: number;
  routes: Array<{
    order: number;
    methods: string[];
    path: string;
    name: string;
    authRequired: boolean;
  }>;
};

type UpstreamFixture = {
  version: number;
  outbound: {
    respond: {
      type: string;
      agentSessionId: string;
      inputRequestId: string;
      answers: Record<string, unknown>;
      requestId: string;
      requestIdMustNotEqual: string;
    };
    subscribeEvents: {
      type: string;
      agentSessionId: string;
      subscribeId: string;
      requestId: string;
      fireAndForget: boolean;
    };
  };
};

describe("orch contract fixtures", () => {
  it("keeps route inventory unique by method and path", () => {
    const fixture = loadFixture<RouteFixture>("route_inventory.json");
    const seen = new Set<string>();

    for (const route of fixture.routes) {
      expect(route.order).toBeGreaterThanOrEqual(0);
      for (const method of route.methods) {
        const key = `${method} ${route.path}`;
        expect(seen.has(key), key).toBe(false);
        seen.add(key);
      }
    }
  });

  it("keeps static route priority hazards explicit", () => {
    const fixture = loadFixture<RouteFixture>("route_inventory.json");
    const order = new Map(fixture.routes.map((route) => [route.path, route.order]));

    expect(order.has("/api/nodes/claude-auth/callback")).toBe(true);
    expect(order.has("/api/nodes/{node_id}/claude-auth/callback")).toBe(false);
    expect(order.get("/api/sessions/{session_id}/events/viewport")).toBeLessThan(
      order.get("/api/sessions/{session_id}/events") ?? Number.POSITIVE_INFINITY,
    );
    expect(order.get("/api/runbooks/my-turn")).toBeLessThan(
      order.get("/api/runbooks/{runbook_id}") ?? Number.POSITIVE_INFINITY,
    );
  });

  it("keeps upstream respond and subscribe_events wire semantics explicit", () => {
    const fixture = loadFixture<UpstreamFixture>("upstream_ws_wire.json");

    expect(fixture.outbound.respond.type).toBe("respond");
    expect(fixture.outbound.respond.requestId).toBe("<orch-command-request-id>");
    expect(fixture.outbound.respond.requestIdMustNotEqual).toBe("inputRequestId");
    expect(fixture.outbound.subscribeEvents.type).toBe("subscribe_events");
    expect(fixture.outbound.subscribeEvents.requestId).toBe("<absent>");
    expect(fixture.outbound.subscribeEvents.fireAndForget).toBe(true);
  });

  it("parses all contract fixture documents", () => {
    for (const name of [
      "route_inventory.json",
      "upstream_ws_wire.json",
      "sse_replay_gap.json",
      "fake_node_reconnect.json",
      "board_yjs_host_proxy.json",
      "db_function_contract.json",
    ]) {
      expect(loadFixture<{ version: number }>(name).version).toBe(1);
    }
  });
});
