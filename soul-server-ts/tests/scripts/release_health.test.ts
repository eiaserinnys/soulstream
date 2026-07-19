import { describe, expect, it, vi } from "vitest";

import {
  deriveOrchestratorHealthUrl,
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
};

describe("release health contract", () => {
  it("derives the orchestrator HTTP endpoint from the upstream WebSocket URL", () => {
    expect(deriveOrchestratorHealthUrl(env.SOULSTREAM_UPSTREAM_URL).toString()).toBe(
      "https://soulstream.example/api/health",
    );
  });

  it("requires HTTP, MCP representative read, and canonical data together", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: "ok" }),
    }));
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
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(mcpRead).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-1" }));
    expect(dataRead).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-1" }));
  });

  it("uses the generic Task read contract when no deployment-specific task is configured", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: "ok" }),
    }));
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
    const fetchImpl = vi.fn(async (url: URL) => ({
      ok: !url.pathname.endsWith("/health") || url.hostname !== "127.0.0.1",
      status: 500,
      json: async () => ({ status: "error" }),
    }));

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
});
