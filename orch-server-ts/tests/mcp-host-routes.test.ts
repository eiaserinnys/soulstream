import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerMcpHostRoutes } from "../src/mcp/mcp_host_routes.js";


describe("MCP service host boundary", () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
  it.each([
    [undefined, "get_folder", { args: {}, context: { principal: "internal", caller_session_id: "session", node_id: "node" } }, 401],
    ["Bearer invalid", "get_folder", {}, 401],
    ["Bearer token", "unknown", { args: {}, context: { principal: "internal", caller_session_id: null, node_id: "node" } }, 404],
    ["Bearer token", "get_folder", { args: [] }, 422],
    ["Bearer token", "get_folder", { args: {}, context: { principal: "forged", caller_session_id: null, node_id: "node" } }, 422],
  ])("rejects invalid boundary input (%s %s)", async (authorization, tool, payload, status) => {
    const app = Fastify(); apps.push(app);
    const serviceProvider = vi.fn();
    registerMcpHostRoutes(app, { authBearerToken: "token", folders: { authBearerToken: "token", serviceProvider } });
    const response = await app.inject({ method: "POST", url: `/api/mcp/host/${tool}`,
      headers: authorization ? { authorization: String(authorization) } : {}, payload });
    expect(response.statusCode).toBe(status);
    expect(serviceProvider).not.toHaveBeenCalled();
  });
  it("returns schema errors as tool errors with HTTP 200", async () => {
    const app = Fastify(); apps.push(app);
    registerMcpHostRoutes(app, { authBearerToken: "token", folders: { authBearerToken: "token", serviceProvider: vi.fn() } });
    const response = await app.inject({ method: "POST", url: "/api/mcp/host/get_folder", headers: { authorization: "Bearer token" },
      payload: { args: {}, context: { principal: "internal", caller_session_id: null, node_id: "node" } } });
    expect(response.statusCode).toBe(200);
    expect(response.json().isError).toBe(true);
  });
});
