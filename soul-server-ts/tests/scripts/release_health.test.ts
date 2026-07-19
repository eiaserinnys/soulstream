import { describe, expect, it, vi } from "vitest";

import {
  deriveOrchestratorHealthUrl,
  readNodeRegistration,
  verifyReleaseHealth,
} from "../../scripts/verify-release-health.mjs";

const env = {
  DATABASE_URL: "postgresql://release:secret@127.0.0.1:5432/release_test",
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
  it("derives the orchestrator HTTP endpoint from the upstream WebSocket URL", () => {
    expect(deriveOrchestratorHealthUrl(env.SOULSTREAM_UPSTREAM_URL).toString()).toBe(
      "https://soulstream.example/api/health",
    );
  });

  it("requires HTTP, MCP representative read, and canonical data together", async () => {
    const fetchImpl = vi.fn(healthyFetch);
    const mcpRead = vi.fn(async () => ({ ping: "ok", tool: "get_task" }));
    const dataRead = vi.fn(async () => ({ task_count: 68, document_count: 159 }));

    const report = await verifyReleaseHealth({
      taskId: "task-1",
      env: { ...env },
      fetchImpl,
      mcpRead,
      dataRead,
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
    expect(dataRead).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-1" }));
  });

  it("uses the generic Task read contract when no deployment-specific task is configured", async () => {
    const fetchImpl = vi.fn(healthyFetch);
    const mcpRead = vi.fn(async () => ({ ping: "ok", tool: "list_my_turn_items" }));
    const dataRead = vi.fn(async () => ({ task_count: 0, document_count: 0 }));

    const report = await verifyReleaseHealth({
      taskId: null,
      env: { ...env },
      fetchImpl,
      mcpRead,
      dataRead,
    });

    expect(report.status).toBe("ok");
    expect(mcpRead).toHaveBeenCalledWith(expect.objectContaining({ taskId: null }));
    expect(dataRead).toHaveBeenCalledWith(expect.objectContaining({ taskId: null }));
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
      taskId: "task-1",
      env: { ...env },
      fetchImpl,
      mcpRead: async () => ({ ping: "ok" }),
      dataRead: async () => ({ task_count: 1, document_count: 1 }),
    })).rejects.toThrow("returned HTTP 500");
  });

  it("fails when MCP is not explicitly enabled", async () => {
    await expect(verifyReleaseHealth({
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
      taskId: null,
      env: { ...env },
      fetchImpl,
      nodeRead: async (options) => await readNodeRegistration({
        ...options,
        attempts: 1,
        intervalMs: 0,
      }),
      mcpRead: async () => ({ ping: "ok" }),
      dataRead: async () => ({ task_count: 1, document_count: 1 }),
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
