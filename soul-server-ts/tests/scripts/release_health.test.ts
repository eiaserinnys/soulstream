import { describe, expect, it, vi } from "vitest";

import {
  deriveOrchestratorHealthUrl,
  readNodeRegistration,
  verifyReleaseHealth,
} from "../../scripts/verify-release-health.mjs";

const env = {
  HOST: "127.0.0.1",
  PORT: "4205",
  MCP_ENABLED: "true",
  MCP_PATH: "/mcp",
  AUTH_BEARER_TOKEN: "token",
  SOULSTREAM_UPSTREAM_URL: "wss://soulstream.example/ws/node?old=1",
  SOULSTREAM_NODE_ID: "eiaserinnys",
};

function healthyFetch(url: URL) {
  if (url.pathname === "/api/nodes") {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({
        nodes: [{ nodeId: "eiaserinnys", connected: true, status: "connected" }],
      }),
    });
  }
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({ status: "ok" }),
  });
}

describe("release health contract", () => {
  it("requires an explicit standalone or cluster scope", async () => {
    await expect(verifyReleaseHealth({
      taskId: null,
      env: { ...env },
      fetchImpl: healthyFetch,
      mcpRead: async () => ({ ping: "ok" }),
    })).rejects.toThrow("scope must be standalone or cluster");
  });

  it("keeps standalone health local and does not require upstream registration", async () => {
    const fetchImpl = vi.fn(healthyFetch);
    const nodeRead = vi.fn();
    const mcpRead = vi.fn(async () => ({ ping: "ok", tool: "list_my_turn_items" }));
    const standaloneEnv = { ...env };
    delete (standaloneEnv as Partial<typeof env>).SOULSTREAM_UPSTREAM_URL;
    delete (standaloneEnv as Partial<typeof env>).SOULSTREAM_NODE_ID;

    const report = await verifyReleaseHealth({
      scope: "standalone",
      taskId: null,
      env: standaloneEnv,
      fetchImpl,
      nodeRead,
      mcpRead,
    });

    expect(report).toMatchObject({ status: "ok", scope: "standalone" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(nodeRead).not.toHaveBeenCalled();
  });

  it("derives the orchestrator HTTP endpoint from the upstream WebSocket URL", () => {
    expect(deriveOrchestratorHealthUrl(env.SOULSTREAM_UPSTREAM_URL).toString()).toBe(
      "https://soulstream.example/api/health",
    );
  });

  it("requires HTTP, node registration, and an MCP representative read together", async () => {
    const fetchImpl = vi.fn(healthyFetch);
    const mcpRead = vi.fn(async () => ({ ping: "ok", tool: "get_task" }));

    const report = await verifyReleaseHealth({
      scope: "cluster",
      taskId: "task-1",
      env: { ...env },
      fetchImpl,
      mcpRead,
    });

    expect(report.status).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: "/api/nodes" }),
      expect.objectContaining({
        headers: { Authorization: "Bearer token" },
      }),
    );
    expect(mcpRead).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-1" }));
    expect(report).not.toHaveProperty("data");
  });

  it("uses the generic Task read contract when no deployment-specific task is configured", async () => {
    const fetchImpl = vi.fn(healthyFetch);
    const mcpRead = vi.fn(async () => ({ ping: "ok", tool: "list_my_turn_items" }));

    const report = await verifyReleaseHealth({
      scope: "cluster",
      taskId: null,
      env: { ...env },
      fetchImpl,
      mcpRead,
    });

    expect(report.status).toBe("ok");
    expect(mcpRead).toHaveBeenCalledWith(expect.objectContaining({ taskId: null }));
  });

  it("fails closed on an HTTP 500 before reporting release success", async () => {
    const fetchImpl = vi.fn(async (url: URL) => {
      if (url.pathname === "/api/nodes") return await healthyFetch(url);
      return {
        ok: !url.pathname.endsWith("/health") || url.hostname !== "127.0.0.1",
        status: 500,
        json: async () => ({ status: "error" }),
      };
    });

    await expect(verifyReleaseHealth({
      scope: "cluster",
      taskId: "task-1",
      env: { ...env },
      fetchImpl,
      mcpRead: async () => ({ ping: "ok" }),
    })).rejects.toThrow("returned HTTP 500");
  });

  it("fails when MCP is not explicitly enabled", async () => {
    await expect(verifyReleaseHealth({
      scope: "cluster",
      taskId: "task-1",
      env: { ...env, MCP_ENABLED: "false" },
    })).rejects.toThrow("MCP_ENABLED must be true");
  });

  it("fails when the local node is listening but absent from the connected registry", async () => {
    const fetchImpl = vi.fn(async (url: URL) => {
      if (url.pathname === "/api/nodes") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            nodes: [{ nodeId: "other-node", connected: true, status: "connected" }],
          }),
        };
      }
      return await healthyFetch(url);
    });

    await expect(verifyReleaseHealth({
      scope: "cluster",
      taskId: null,
      env: { ...env },
      fetchImpl,
      nodeRead: async (options) => await readNodeRegistration({
        ...options,
        attempts: 1,
        intervalMs: 0,
      }),
      mcpRead: async () => ({ ping: "ok" }),
    })).rejects.toThrow("eiaserinnys is not connected");
  });

  it("waits for registration after HTTP readiness instead of racing startup", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (url: URL) => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ nodes: [] }),
        };
      }
      return await healthyFetch(url);
    });
    const sleep = vi.fn(async () => undefined);

    await expect(readNodeRegistration({
      url: new URL("https://soulstream.example/api/nodes"),
      token: "token",
      nodeId: "eiaserinnys",
      fetchImpl,
      attempts: 3,
      intervalMs: 0,
      sleep,
    })).resolves.toMatchObject({ connected: true, attempts: 2 });
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});
