import { describe, expect, it, vi } from "vitest";
import { createApp, parseOrchServerConfig } from "../src/index.js";
import { McpCentralError } from "../src/mcp_central/errors.js";

const config = parseOrchServerConfig({ environment: "test", databaseUrl: "postgres://soulstream_test@localhost/soulstream_test", authBearerToken: "test-token" });
const revision = { current_revision: 12 };
const server = { id: "s" };
const profile = { id: "p" };
const secret = { name: "key", updated_at: null, servers: [], profiles: [] };
const icon = { mime: "image/png", body: Buffer.from("icon"), content_hash: "hash" };
const fakeService = () => ({
  getConfig: vi.fn(async () => ({ current_revision: 12 })),
  addManagedNode: vi.fn(async () => ({ ...revision, result: undefined })),
  removeManagedNode: vi.fn(async () => ({ ...revision, result: undefined })),
  putServer: vi.fn(async () => ({ ...revision, result: server })),
  deleteServer: vi.fn(async () => ({ ...revision, result: undefined })),
  uploadServerIcon: vi.fn(async () => ({ ref: "icon" })),
  getServerIcon: vi.fn(async () => icon as typeof icon | null),
  putProfile: vi.fn(async () => ({ ...revision, result: profile })),
  deleteProfile: vi.fn(async () => ({ ...revision, result: undefined })),
  setAgentBindings: vi.fn(async () => ({ ...revision, result: [{ agent_id: "a" }] })),
  putSecret: vi.fn(async () => ({ ...revision, result: secret })),
  deleteSecret: vi.fn(async () => ({ ...revision, result: undefined })),
  listRevisions: vi.fn(async () => [{ id: 4 }]),
  rollback: vi.fn(async () => ({ ...revision, result: undefined })),
});
const cases = [
  { method: "GET", url: "/api/mcp/config", fn: "getConfig", args: [], response: { current_revision: 12 } },
  { method: "PUT", url: "/api/mcp/managed-nodes/n", payload: { expected_revision: 10 }, fn: "addManagedNode", args: ["n", { expectedRevision: 10 }], response: revision },
  { method: "DELETE", url: "/api/mcp/managed-nodes/n?expected_revision=10", fn: "removeManagedNode", args: ["n", { expectedRevision: 10 }], response: revision },
  { method: "PUT", url: "/api/mcp/servers/s", payload: { type: "stdio", config: { command: "run" }, node_scope: ["n"], expected_revision: 10, expected_version: 2 }, fn: "putServer", args: ["s", { type: "stdio", config: { command: "run" }, node_scope: ["n"] }, { expectedRevision: 10, expectedVersion: 2 }], response: { ...revision, server } },
  { method: "DELETE", url: "/api/mcp/servers/s?expected_revision=10&expected_version=2", fn: "deleteServer", args: ["s", { expectedRevision: 10, expectedVersion: 2 }], response: revision },
  { method: "POST", url: "/api/mcp/server-icons", payload: { data_base64: "a", sha256: "b" }, fn: "uploadServerIcon", args: [{ data_base64: "a", sha256: "b" }], response: { ref: "icon" } },
  { method: "GET", url: "/api/mcp/server-icons/ref", fn: "getServerIcon", args: ["ref"], response: null },
  { method: "PUT", url: "/api/mcp/profiles/p", payload: { name: "P", description: "D", mcp_servers: ["s"], hosted_tools: [], expected_revision: 10, expected_version: 2 }, fn: "putProfile", args: ["p", { name: "P", description: "D", mcp_servers: ["s"], hosted_tools: [] }, { expectedRevision: 10, expectedVersion: 2 }], response: { ...revision, profile } },
  { method: "DELETE", url: "/api/mcp/profiles/p?expected_revision=10&expected_version=2", fn: "deleteProfile", args: ["p", { expectedRevision: 10, expectedVersion: 2 }], response: revision },
  { method: "PUT", url: "/api/mcp/agents/a", payload: { node_ids: ["n"], mcp_profile_id: "p", fork: true, expected_revision: 10 }, fn: "setAgentBindings", args: ["a", { node_ids: ["n"], mcp_profile_id: "p", fork: true }, { expectedRevision: 10 }], response: { ...revision, bindings: [{ agent_id: "a" }] } },
  { method: "PUT", url: "/api/mcp/secrets/key", payload: { value: "fake-secret-value", expected_revision: 10 }, fn: "putSecret", args: ["key", "fake-secret-value", { expectedRevision: 10 }], response: { ...revision, secret } },
  { method: "DELETE", url: "/api/mcp/secrets/key?expected_revision=10", fn: "deleteSecret", args: ["key", { expectedRevision: 10 }], response: revision },
  { method: "GET", url: "/api/mcp/revisions?target=server&target_id=s", fn: "listRevisions", args: [{ target: "server", target_id: "s" }], response: { revisions: [{ id: 4 }] } },
  { method: "POST", url: "/api/mcp/revisions/4/rollback", payload: { expected_revision: 10 }, fn: "rollback", args: [4, { expectedRevision: 10 }], response: revision },
] as const;

function harness(email: string | null = "admin@example.com", admin = true) {
  const service = fakeService();
  const app = createApp({ config, mcpCentralRoutes: { service: service as never, provider: { currentEmail: () => email, isAdminEmail: () => admin } } });
  return { app, service };
}

describe("MCP central admin routes", () => {
  it("requires an administrator for every route before calling the service", async () => {
    for (const [email, admin, status] of [[null, false, 401], ["user@example.com", false, 403]] as const) {
      const { app, service } = harness(email, admin);
      try {
        for (const item of cases) {
          const response = await app.inject({ method: item.method, url: item.url, payload: "payload" in item ? item.payload : undefined });
          expect(response.statusCode, `${item.method} ${item.url}`).toBe(status);
        }
        for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
      } finally { await app.close(); }
    }
  });

  it("passes each route's inputs and revision conditions to its service", async () => {
    const { app, service } = harness();
    try {
      for (const item of cases) {
        const response = await app.inject({ method: item.method, url: item.url, payload: "payload" in item ? item.payload : undefined });
        expect(response.statusCode, `${item.method} ${item.url}`).toBe(200);
        expect(service[item.fn]).toHaveBeenCalledWith(...item.args);
        if (item.response !== null) expect(response.json()).toEqual(item.response);
        if (item.fn === "putSecret") expect(response.body).not.toContain("fake-secret-value");
      }
    } finally { await app.close(); }
  });

  it("rejects noninteger revision and version conditions", async () => {
    const { app, service } = harness();
    try {
      for (const [method, url, payload] of [
        ["PUT", "/api/mcp/managed-nodes/n", { expected_revision: 1.5 }],
        ["DELETE", "/api/mcp/servers/s?expected_version=1.5", undefined],
        ["DELETE", "/api/mcp/servers/s?expected_revision=abc", undefined],
      ] as const) {
        expect((await app.inject({ method, url, payload })).statusCode).toBe(400);
      }
      expect(service.addManagedNode).not.toHaveBeenCalled();
      expect(service.deleteServer).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it("returns known errors and hides unexpected error messages", async () => {
    const { app, service } = harness();
    try {
      for (const status of [400, 404, 409]) {
        service.getConfig.mockRejectedValueOnce(new McpCentralError("MCP_TEST", status, "known error"));
        const response = await app.inject({ method: "GET", url: "/api/mcp/config" });
        expect(response.statusCode).toBe(status);
        expect(response.json()).toEqual({ code: "MCP_TEST", message: "known error" });
      }
      service.getConfig.mockRejectedValueOnce(new Error("fake-secret-error"));
      const response = await app.inject({ method: "GET", url: "/api/mcp/config" });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ code: "MCP_INTERNAL_ERROR", message: "internal error" });
      expect(response.body).not.toContain("fake-secret-error");
    } finally { await app.close(); }
  });

  it("serves icons with cache headers, conditional responses and 404", async () => {
    const { app, service } = harness();
    try {
      const response = await app.inject({ method: "GET", url: "/api/mcp/server-icons/ref" });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe("icon");
      expect(response.headers).toMatchObject({ "content-type": "image/png", "x-content-type-options": "nosniff", etag: '"hash"', "cache-control": "private, max-age=31536000, immutable" });
      const cached = await app.inject({ method: "GET", url: "/api/mcp/server-icons/ref", headers: { "if-none-match": '"hash"' } });
      expect(cached.statusCode).toBe(304);
      expect(cached.body).toBe("");
      service.getServerIcon.mockResolvedValueOnce(null);
      expect((await app.inject({ method: "GET", url: "/api/mcp/server-icons/ref" })).statusCode).toBe(404);
    } finally { await app.close(); }
  });

  it("rejects icon uploads larger than 512 KiB", async () => {
    const { app, service } = harness();
    try {
      const response = await app.inject({ method: "POST", url: "/api/mcp/server-icons", payload: { data_base64: "x".repeat(524288) } });
      expect(response.statusCode).toBe(413);
      expect(service.uploadServerIcon).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
