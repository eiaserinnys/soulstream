import { describe, expect, it, vi } from "vitest";

const mcpClient = vi.hoisted(() => ({
  connect: vi.fn(async () => undefined),
  ping: vi.fn(async () => undefined),
  listTools: vi.fn(async () => ({ tools: [
    { name: "get_folder" },
    { name: "list_cards" },
  ] })),
  callTool: vi.fn(async () => ({ isError: false })),
  close: vi.fn(async () => undefined),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = mcpClient.connect;
    ping = mcpClient.ping;
    listTools = mcpClient.listTools;
    callTool = mcpClient.callTool;
    close = mcpClient.close;
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {},
}));

import {
  deriveOrchestratorHealthUrl,
  readMcpHealth,
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
  it("reads the current folder MCP contract when a folder is supplied", async () => {
    mcpClient.callTool.mockClear();

    await expect(readMcpHealth({
      url: new URL("http://127.0.0.1:4205/mcp"),
      token: "token",
      folderId: "folder-1",
    })).resolves.toEqual({ ping: "ok", tool: "get_folder", folder_id: "folder-1" });
    expect(mcpClient.callTool).toHaveBeenCalledWith({
      name: "get_folder",
      arguments: { folder_id: "folder-1", view: "outline" },
    });
  });

  it("reads turn items when no folder is supplied", async () => {
    mcpClient.callTool.mockClear();

    await expect(readMcpHealth({
      url: new URL("http://127.0.0.1:4205/mcp"),
      token: "token",
      folderId: null,
    })).resolves.toEqual({ ping: "ok", tool: "list_cards", folder_id: null });
    expect(mcpClient.callTool).toHaveBeenCalledWith({
      name: "list_cards",
      arguments: {},
    });
  });

  it("requires an explicit standalone or cluster scope", async () => {
    await expect(verifyReleaseHealth({
      folderId: null,
      env: { ...env },
      fetchImpl: healthyFetch,
      mcpRead: async () => ({ ping: "ok" }),
    })).rejects.toThrow("scope must be standalone or cluster");
  });

  it("keeps standalone health local and does not require upstream registration", async () => {
    const fetchImpl = vi.fn(healthyFetch);
    const nodeRead = vi.fn();
    const mcpRead = vi.fn(async () => ({ ping: "ok", tool: "list_cards" }));
    const standaloneEnv = { ...env };
    delete (standaloneEnv as Partial<typeof env>).SOULSTREAM_UPSTREAM_URL;
    delete (standaloneEnv as Partial<typeof env>).SOULSTREAM_NODE_ID;

    const report = await verifyReleaseHealth({
      scope: "standalone",
      folderId: null,
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
    const mcpRead = vi.fn(async () => ({ ping: "ok", tool: "get_folder" }));

    const report = await verifyReleaseHealth({
      scope: "cluster",
      folderId: "folder-1",
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
    expect(mcpRead).toHaveBeenCalledWith(expect.objectContaining({ folderId: "folder-1" }));
    expect(report).not.toHaveProperty("data");
  });

  it("uses the turn-item read when no deployment-specific folder is configured", async () => {
    const fetchImpl = vi.fn(healthyFetch);
    const mcpRead = vi.fn(async () => ({ ping: "ok", tool: "list_cards" }));

    const report = await verifyReleaseHealth({
      scope: "cluster",
      folderId: null,
      env: { ...env },
      fetchImpl,
      mcpRead,
    });

    expect(report.status).toBe("ok");
    expect(mcpRead).toHaveBeenCalledWith(expect.objectContaining({ folderId: null }));
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
      folderId: "folder-1",
      env: { ...env },
      fetchImpl,
      mcpRead: async () => ({ ping: "ok" }),
    })).rejects.toThrow("returned HTTP 500");
  });

  it("fails when MCP is not explicitly enabled", async () => {
    await expect(verifyReleaseHealth({
      scope: "cluster",
      folderId: "folder-1",
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
      folderId: null,
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
