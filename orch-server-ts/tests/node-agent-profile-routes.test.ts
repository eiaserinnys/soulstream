import { describe, expect, it } from "vitest";

import {
  NodeAgentProfileRouteError,
  createApp,
  loadContractFixtures,
  nodeAgentProfileRouteAuthRequirements,
  parseOrchServerConfig,
  type NodeAgentProfileProvider,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

type ProviderCall =
  | ["listAgents", string]
  | ["agentPortrait", string, string]
  | ["userPortrait", string]
  | ["plan", string, unknown]
  | ["apply", string, unknown]
  | ["snapshots", string]
  | ["rollback", string, unknown];

function createProvider(overrides: Partial<NodeAgentProfileProvider> = {}) {
  const calls: ProviderCall[] = [];
  const provider: NodeAgentProfileProvider = {
    async listAgentProfiles(nodeId) {
      calls.push(["listAgents", nodeId]);
      if (nodeId === "missing-node") return undefined;
      return {
        "agent-a": {
          name: "Alpha",
          portrait_url: "/api/agents/agent-a/portrait",
          max_turns: 8,
        },
        "agent-b": {
          name: "Beta",
          backend: "codex",
        },
      };
    },
    async getAgentPortrait(nodeId, agentId) {
      calls.push(["agentPortrait", nodeId, agentId]);
      if (nodeId === "missing-node" || agentId === "missing") {
        return { status: "missing" };
      }
      if (agentId === "upstream-502") {
        return { status: "upstream", statusCode: 502 };
      }
      if (agentId === "upstream-ok") {
        return {
          status: "upstream",
          statusCode: 200,
          body: "upstream-body",
          contentType: "image/png",
        };
      }
      return { status: "cached", body: "GIF89a-agent" };
    },
    async getUserPortrait(nodeId) {
      calls.push(["userPortrait", nodeId]);
      if (nodeId === "missing-node") return { status: "missing" };
      return {
        status: "cached",
        body: Buffer.from("RIFFxxxxWEBP-user").toString("base64"),
        encoding: "base64",
      };
    },
    async planAgentProfileUpdate(nodeId, input) {
      calls.push(["plan", nodeId, input]);
      return { planned: true };
    },
    async applyAgentProfileUpdate(nodeId, input) {
      calls.push(["apply", nodeId, input]);
      return { applied: true };
    },
    async listAgentsConfigSnapshots(nodeId) {
      calls.push(["snapshots", nodeId]);
      return { snapshots: ["agents.yaml.1"] };
    },
    async rollbackAgentsConfig(nodeId, input) {
      calls.push(["rollback", nodeId, input]);
      return { rolledBack: true };
    },
    ...overrides,
  };
  return { provider, calls };
}

describe("node agent/profile route harness", () => {
  const fixtures = loadContractFixtures();

  it("keeps node agent/profile routes disabled on the default app", async () => {
    const app = createApp({ config });

    for (const [method, url, payload] of [
      ["GET", "/api/nodes/node-a/agents", undefined],
      ["GET", "/api/nodes/node-a/agents/agent-a/portrait", undefined],
      [
        "POST",
        "/api/nodes/node-a/agents/config/plan-profile-update",
        { profile: {} },
      ],
      [
        "POST",
        "/api/nodes/node-a/agents/config/apply-profile-update",
        { profile: {} },
      ],
      ["GET", "/api/nodes/node-a/agents/config/snapshots", undefined],
      [
        "POST",
        "/api/nodes/node-a/agents/config/rollback",
        { snapshot_id: "snap-1" },
      ],
      ["GET", "/api/nodes/node-a/oauth-profiles", undefined],
      ["GET", "/api/nodes/node-a/user/portrait", undefined],
    ] as const) {
      expect(await app.inject({ method, url, payload })).toMatchObject({
        statusCode: 404,
      });
    }

    await app.close();
  });

  it("registers Python auth contract rows for route inventory order 36-43", () => {
    expect(nodeAgentProfileRouteAuthRequirements).toEqual({
      "GET /api/nodes/:node_id/agents": true,
      "GET /api/nodes/:node_id/agents/:agent_id/portrait": true,
      "POST /api/nodes/:node_id/agents/config/plan-profile-update": true,
      "POST /api/nodes/:node_id/agents/config/apply-profile-update": true,
      "GET /api/nodes/:node_id/agents/config/snapshots": true,
      "POST /api/nodes/:node_id/agents/config/rollback": true,
      "GET /api/nodes/:node_id/oauth-profiles": true,
      "GET /api/nodes/:node_id/user/portrait": true,
    });

    const routeRows = fixtures.routeInventory.routes
      .filter((route) =>
        [
          "list_node_agents",
          "proxy_agent_portrait",
          "plan_agent_profile_update",
          "apply_agent_profile_update",
          "list_agents_config_snapshots",
          "rollback_agents_config",
          "deprecated_node_oauth_profiles",
          "proxy_user_portrait",
        ].includes(route.name),
      )
      .map((route) => [route.order, route.methods[0], route.path, route.authRequired]);

    expect(routeRows).toEqual([
      [36, "GET", "/api/nodes/{node_id}/agents", true],
      [37, "GET", "/api/nodes/{node_id}/agents/{agent_id}/portrait", true],
      [38, "POST", "/api/nodes/{node_id}/agents/config/plan-profile-update", true],
      [39, "POST", "/api/nodes/{node_id}/agents/config/apply-profile-update", true],
      [40, "GET", "/api/nodes/{node_id}/agents/config/snapshots", true],
      [41, "POST", "/api/nodes/{node_id}/agents/config/rollback", true],
      [42, "GET", "/api/nodes/{node_id}/oauth-profiles", true],
      [43, "GET", "/api/nodes/{node_id}/user/portrait", true],
    ]);
  });

  it("projects Python agent list shape and maps missing nodes to 404", async () => {
    const { provider, calls } = createProvider();
    const app = createApp({ config, nodeAgentProfileRoutes: { provider } });

    const response = await app.inject({
      method: "GET",
      url: "/api/nodes/node-a/agents",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      agents: [
        {
          id: "agent-a",
          name: "Alpha",
          portraitUrl: "/api/nodes/node-a/agents/agent-a/portrait",
          max_turns: 8,
          backend: "claude",
        },
        {
          id: "agent-b",
          name: "Beta",
          portraitUrl: "",
          max_turns: null,
          backend: "codex",
        },
      ],
    });

    const missing = await app.inject({
      method: "GET",
      url: "/api/nodes/missing-node/agents",
    });
    expect(missing.statusCode).toBe(404);
    expect(calls).toEqual([
      ["listAgents", "node-a"],
      ["listAgents", "missing-node"],
    ]);

    await app.close();
  });

  it("applies Python portrait response policy", async () => {
    const { provider } = createProvider();
    const app = createApp({ config, nodeAgentProfileRoutes: { provider } });

    const cachedGif = await app.inject({
      method: "GET",
      url: "/api/nodes/node-a/agents/agent-a/portrait",
    });
    expect(cachedGif.statusCode).toBe(200);
    expect(cachedGif.headers["content-type"]).toContain("image/gif");
    expect(cachedGif.headers["cache-control"]).toBe("public, max-age=3600");
    expect(cachedGif.body).toBe("GIF89a-agent");

    const cachedWebp = await app.inject({
      method: "GET",
      url: "/api/nodes/node-a/user/portrait",
    });
    expect(cachedWebp.statusCode).toBe(200);
    expect(cachedWebp.headers["content-type"]).toContain("image/webp");
    expect(cachedWebp.headers["cache-control"]).toBe("public, max-age=3600");
    expect(cachedWebp.body).toBe("RIFFxxxxWEBP-user");

    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/nodes/missing-node/agents/agent-a/portrait",
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/nodes/node-a/agents/missing/portrait",
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/nodes/node-a/agents/upstream-502/portrait",
        })
      ).statusCode,
    ).toBe(502);

    const upstreamOk = await app.inject({
      method: "GET",
      url: "/api/nodes/node-a/agents/upstream-ok/portrait",
    });
    expect(upstreamOk.statusCode).toBe(200);
    expect(upstreamOk.headers["content-type"]).toContain("image/png");
    expect(upstreamOk.headers["cache-control"]).toBe("public, max-age=3600");
    expect(upstreamOk.body).toBe("upstream-body");

    await app.close();
  });

  it("normalizes config command aliases and keeps config routes before portrait routes", async () => {
    const { provider, calls } = createProvider({
      async getAgentPortrait() {
        throw new Error("config route was consumed as portrait route");
      },
    });
    const app = createApp({ config, nodeAgentProfileRoutes: { provider } });

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/nodes/node-a/agents/config/plan-profile-update",
          payload: {
            profile: { id: "agent-a" },
            create_if_missing: true,
            includeTextDiff: true,
          },
        })
      ).json(),
    ).toEqual({ planned: true });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/nodes/node-a/agents/config/apply-profile-update",
          payload: {
            profile: { id: "agent-a" },
            createIfMissing: true,
            include_text_diff: true,
            expected_config_checksum: "checksum-a",
          },
        })
      ).json(),
    ).toEqual({ applied: true });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/nodes/node-a/agents/config/snapshots",
        })
      ).json(),
    ).toEqual({ snapshots: ["agents.yaml.1"] });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/nodes/node-a/agents/config/rollback",
          payload: {
            snapshotPath: "/tmp/agents.yaml.1",
            include_text_diff: true,
          },
        })
      ).json(),
    ).toEqual({ rolledBack: true });

    expect(calls).toEqual([
      [
        "plan",
        "node-a",
        {
          profile: { id: "agent-a" },
          createIfMissing: true,
          includeTextDiff: true,
        },
      ],
      [
        "apply",
        "node-a",
        {
          profile: { id: "agent-a" },
          createIfMissing: true,
          includeTextDiff: true,
          expectedConfigChecksum: "checksum-a",
        },
      ],
      ["snapshots", "node-a"],
      [
        "rollback",
        "node-a",
        {
          snapshotPath: "/tmp/agents.yaml.1",
          snapshotId: undefined,
          includeTextDiff: true,
        },
      ],
    ]);

    await app.close();
  });

  it("maps invalid config bodies and provider errors predictably", async () => {
    const invalid = createProvider();
    const invalidApp = createApp({
      config,
      nodeAgentProfileRoutes: { provider: invalid.provider },
    });

    expect(
      (
        await invalidApp.inject({
          method: "POST",
          url: "/api/nodes/node-a/agents/config/plan-profile-update",
          payload: { create_if_missing: true },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await invalidApp.inject({
          method: "POST",
          url: "/api/nodes/node-a/agents/config/rollback",
          payload: { include_text_diff: true },
        })
      ).statusCode,
    ).toBe(422);
    await invalidApp.close();

    const missingNode = createProvider({
      async listAgentsConfigSnapshots() {
        throw new NodeAgentProfileRouteError(
          "NODE_NOT_CONNECTED",
          "Node node-a not connected",
          404,
        );
      },
    });
    const connectionError = createProvider({
      async applyAgentProfileUpdate() {
        throw new NodeAgentProfileRouteError(
          "NODE_CONNECTION_ERROR",
          "connection failed",
          503,
        );
      },
    });
    const runtimeError = createProvider({
      async planAgentProfileUpdate() {
        throw new Error("runtime failed");
      },
    });

    const missingApp = createApp({
      config,
      nodeAgentProfileRoutes: { provider: missingNode.provider },
    });
    const connectionApp = createApp({
      config,
      nodeAgentProfileRoutes: { provider: connectionError.provider },
    });
    const runtimeApp = createApp({
      config,
      nodeAgentProfileRoutes: { provider: runtimeError.provider },
    });

    expect(
      (
        await missingApp.inject({
          method: "GET",
          url: "/api/nodes/node-a/agents/config/snapshots",
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await connectionApp.inject({
          method: "POST",
          url: "/api/nodes/node-a/agents/config/apply-profile-update",
          payload: { profile: {} },
        })
      ).statusCode,
    ).toBe(503);
    expect(
      (
        await runtimeApp.inject({
          method: "POST",
          url: "/api/nodes/node-a/agents/config/plan-profile-update",
          payload: { profile: {} },
        })
      ).statusCode,
    ).toBe(400);

    await missingApp.close();
    await connectionApp.close();
    await runtimeApp.close();
  });

  it("returns deprecated oauth profile envelope without node lookup", async () => {
    const { provider, calls } = createProvider({
      async listAgentProfiles() {
        throw new Error("oauth-profiles must not lookup node state");
      },
    });
    const app = createApp({ config, nodeAgentProfileRoutes: { provider } });

    const response = await app.inject({
      method: "GET",
      url: "/api/nodes/node-a/oauth-profiles",
    });

    expect(response.statusCode).toBe(410);
    expect(response.headers["x-soulstream-deprecated-path"]).toBe(
      "/api/nodes/node-a/oauth-profiles",
    );
    expect(response.headers["x-soulstream-replacement-path"]).toBe(
      "/api/nodes/node-a/claude-auth/profiles",
    );
    expect(response.headers["x-soulstream-desktop-action"]).toBe("hard-reload");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      error: {
        code: "DEPRECATED_API_PATH",
        deprecatedPath: "/api/nodes/node-a/oauth-profiles",
        replacementPath: "/api/nodes/node-a/claude-auth/profiles",
        replacementMethod: "GET",
        desktopAction: "hard-reload",
      },
    });
    expect(calls).toEqual([]);

    await app.close();
  });
});
