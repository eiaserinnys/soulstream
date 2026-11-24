import { describe, expect, it, vi } from "vitest";
import { createApp, parseOrchServerConfig, InMemoryNodeRegistry, NodeCommandTransportHub, SessionCommandTransportBridge, loadContractFixtures, type NodeRegistrationPayload } from "../src/index.js";
import { createMcpTestPreviewService } from "../src/mcp_central/test_preview_service.js";
import { McpCentralSyncService } from "../src/mcp_central/sync_service.js";

describe("central MCP test and preview routes", () => {
  it("routes authorized requests through the test and preview operations", async () => {
    const actions = { test: vi.fn(async () => ({ ok: false, error_stage: "connect" })),
      preview: vi.fn(async () => ({ applied_mode: "local", applied_revision: 0 })) };
    const app = createApp({ config: parseOrchServerConfig({ environment: "test", databaseUrl: "postgres://soulstream_test@localhost/soulstream_test", authBearerToken: "test-token" }),
      mcpCentralRoutes: { service: {} as never, actions, provider: { currentEmail: () => "admin@example.com", isAdminEmail: () => true } } });
    try {
      const headers = { authorization: "Bearer test-token" };
      const test = await app.inject({ method: "POST", url: "/api/mcp/servers/test", headers, payload: { node_id: "n", server_id: "s" } });
      expect(test.statusCode).toBe(200);
      expect(test.json()).toMatchObject({ ok: false, error_stage: "connect" });
      const preview = await app.inject({ method: "GET", url: "/api/mcp/agents/a/preview?node_id=n&mcp_profile_id=p", headers });
      expect(preview.statusCode).toBe(200);
      expect(actions.preview).toHaveBeenCalledWith("a", "n", "p");
    } finally { await app.close(); }
  });

  it.each([[null, 401], ["guest@example.com", 403]] as const)("requires an administrator", async (email, status) => {
    const actions = { test: vi.fn(), preview: vi.fn() };
    const app = createApp({ config: parseOrchServerConfig({ environment: "test", databaseUrl: "postgres://soulstream_test@localhost/soulstream_test", authBearerToken: "test-token" }),
      mcpCentralRoutes: { service: {} as never, actions, provider: { currentEmail: () => email, isAdminEmail: () => false } } });
    try {
      expect((await app.inject({ method: "POST", url: "/api/mcp/servers/test", payload: {} })).statusCode).toBe(status);
      expect((await app.inject({ method: "GET", url: "/api/mcp/agents/a/preview?node_id=n" })).statusCode).toBe(status);
      expect(actions.test).not.toHaveBeenCalled(); expect(actions.preview).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});

describe("MCP test and preview operations", () => {
  const config = { current_revision: 4, managed_nodes: [], secrets: [],
    servers: [{ id: "atom", name: "catalog", type: "streamable_http", config: { url: "https://example.test/?key={{secret:key}}" },
      node_scope: ["n"], node_overrides: { n: { type: "stdio", name: "override", config: { command: "node", env: { KEY: "{{secret:key}}" } } } }, icon: { kind: "symbol", name: "star", color: "blue" }, version: 1 },
    { id: "other", name: "other", type: "sse", config: { url: "https://example.test" }, node_scope: [], node_overrides: {}, icon: null, version: 1 }],
    profiles: [{ id: "p", name: null, description: null, mcp_servers: ["atom", "other"], hosted_tools: [], node_scope: ["n"], version: 1 }],
    bindings: [{ agent_id: "a", node_id: "n", mcp_profile_id: "p", version: 1 }] };
  it("applies node override, resolves values after gating and scrubs the result", async () => {
    const sent: unknown[] = [];
    const sql = vi.fn(async () => [{ name: "key", value: "fake-secret-value" }]);
    const sync = { sendAux: async (_node: string, build: () => Promise<unknown>, gate?: () => Promise<boolean>) => {
      if (gate && !await gate()) throw new Error("out of scope");
      sent.push(await build()); return { ok: false, error_message: "https://example.test/mcp?key=fake-secret-value" };
    } };
    const actions = createMcpTestPreviewService({ service: { getConfig: async () => config } as never, sync: sync as never, resolveSql: async () => sql as never });
    const result = await actions.test({ node_id: "n", server_id: "atom" });
    expect(sent[0]).toMatchObject({ type: "test_mcp_server", server: { name: "override", type: "stdio", config: { env: { KEY: "fake-secret-value" } } } });
    expect(JSON.stringify(sent)).not.toContain("icon");
    expect(JSON.stringify(result)).not.toContain("fake-secret-value");
    expect(JSON.stringify(result)).not.toContain("?key=");
    await expect(actions.test({ node_id: "n", server_id: "atom", inline_secrets: { "invalid key": "fake-inline-value" } })).rejects.toMatchObject({ statusCode: 400 });
    sql.mockClear();
    await expect(actions.test({ node_id: "n", server_id: "other" })).rejects.toThrow();
    expect(sql).not.toHaveBeenCalled();
  });

  it("joins icons and out-of-scope rows only for current central runnable previews", async () => {
    let mode = "central", revision = 4, runnable = true, duplicate = false;
    const sent: unknown[] = [];
    const sync = { sendAux: async (_node: string, build: () => Promise<unknown>) => {
      sent.push(await build());
      return { applied_mode: mode, applied_revision: revision, normal: { runnable, servers: [{ server_id: "atom", name: "catalog", type: "stdio", included: true }, ...(duplicate ? [{ server_id: "other", name: "other", type: "sse", included: false }] : [])] }, restricted: { runnable: false, servers: [] } };
    } };
    const actions = createMcpTestPreviewService({ service: { getConfig: async () => config } as never, sync: sync as never, resolveSql: async () => { throw new Error("unexpected secret read"); } });
    const current = await actions.preview("a", "n") as { normal: { servers: unknown[] } };
    expect(current.normal.servers).toEqual(expect.arrayContaining([expect.objectContaining({ server_id: "atom", node_override: true, icon: config.servers[0]!.icon }), expect.objectContaining({ server_id: "other", excluded_reason: "이 노드 미적용" })]));
    expect(JSON.stringify(sent)).not.toContain("icon");
    duplicate = true;
    const duplicated = await actions.preview("a", "n") as { normal: { servers: Array<{ server_id: string }> } };
    expect(duplicated.normal.servers.filter(row => row.server_id === "other")).toHaveLength(1); duplicate = false;
    const normalRows = async () => (await actions.preview("a", "n") as { normal: { servers: unknown[] } }).normal.servers;
    mode = "local"; expect(await normalRows()).toHaveLength(1);
    mode = "central"; revision = 3; expect(await normalRows()).toHaveLength(1);
    revision = 4; runnable = false; expect(await normalRows()).toHaveLength(1);
    await actions.preview("a", "n", "p");
    expect(sent.at(-1)).toMatchObject({ mcp_profile_id: "p", servers: [{ server_id: "atom", name: "override", type: "stdio" }] });
    await expect(actions.preview("a", "n", "missing")).rejects.toMatchObject({ code: "MCP_PROFILE_NOT_FOUND" });
  });

  it("blocks unmanaged, disconnected, unsupported, missing and out-of-scope nodes before secret reads", async () => {
    const registry = new InMemoryNodeRegistry();
    const registration = loadContractFixtures().fakeNodeReconnect.registration as NodeRegistrationPayload;
    const node = registry.registerNode({ ...registration, node_id: "n", capabilities: { central_mcp_config_v1: true } }).node;
    registry.registerNode({ ...registration, node_id: "unsupported", capabilities: {} });
    let managed = true;
    const sql = vi.fn(async () => [{ name: "key", value: "fake-secret-value" }]);
    const sync = new McpCentralSyncService({ registry, bridge: { sendPendingCommand: async () => { throw new Error("timeout"); } } as never,
      readGate: async () => ({ managed: managed ? { activated_at: null } : null, hasBindings: true }), buildSnapshot: async () => { throw new Error("unexpected"); },
      updateAck: async () => {}, listManagedNodes: async () => [], currentRevision: async () => 4 });
    const actions = createMcpTestPreviewService({ service: { getConfig: async () => config } as never, sync, resolveSql: async () => sql as never });
    managed = false; await expect(actions.test({ node_id: node.nodeId, server_id: "atom" })).rejects.toMatchObject({ statusCode: 403 });
    managed = true; await expect(actions.test({ node_id: "missing", server_id: "atom" })).rejects.toMatchObject({ statusCode: 503 });
    await expect(actions.test({ node_id: "unsupported", server_id: "atom" })).rejects.toMatchObject({ statusCode: 503,
      message: "이 노드는 중앙 MCP 설정을 받지 않습니다(무설치 실행기이거나 옛 판)." });
    await expect(actions.preview("a", "unsupported")).rejects.toMatchObject({ statusCode: 503,
      message: "이 노드는 중앙 MCP 설정을 받지 않습니다(무설치 실행기이거나 옛 판)." });
    await expect(actions.test({ node_id: "n", server_id: "missing" })).rejects.toMatchObject({ statusCode: 404 });
    await expect(actions.test({ node_id: "n", server_id: "other" })).rejects.toMatchObject({ statusCode: 403 });
    expect(sql).not.toHaveBeenCalled();
    await expect(actions.test({ node_id: "n", server_id: "atom" })).rejects.toMatchObject({ statusCode: 503 });
  });

  it("uses inline secrets for an unsaved draft without changing the revision", async () => {
    const sent: unknown[] = [];
    const sync = { sendAux: async (_node: string, build: () => Promise<unknown>) => { sent.push(await build()); return { ok: true }; } };
    const sql = vi.fn(async () => []);
    const actions = createMcpTestPreviewService({ service: { getConfig: async () => config } as never, sync: sync as never, resolveSql: async () => sql as never });
    await actions.test({ node_id: "n", draft_server: { id: "new", type: "stdio", config: { command: "node", env: { KEY: "{{secret:key}}" } }, node_scope: ["n"] }, inline_secrets: { key: "fake-inline-value" } });
    expect(sent[0]).toMatchObject({ server: { id: "new", config: { env: { KEY: "fake-inline-value" } } } });
    expect(sql).not.toHaveBeenCalled();
    expect(config.current_revision).toBe(4);
  });

  it("sends the bounded request through the node transport without icon data", async () => {
    const registry = new InMemoryNodeRegistry();
    const registration = loadContractFixtures().fakeNodeReconnect.registration as NodeRegistrationPayload;
    const node = registry.registerNode({ ...registration, node_id: "n", capabilities: { ...registration.capabilities, central_mcp_config_v1: true } }).node;
    const transports = new NodeCommandTransportHub();
    const sent: Record<string, unknown>[] = [];
    transports.attach({ nodeId: node.nodeId, connectionId: node.connectionId, transport: { send(data) {
      const message = JSON.parse(data) as Record<string, unknown>; sent.push(message);
      registry.receiveNodeMessage({ nodeId: node.nodeId, connectionId: node.connectionId }, { type: "test_mcp_server", requestId: message.requestId,
        success: true, data: { ok: true, latency_ms: 1, tool_count: 0, tools: [] } });
    } } });
    const bridge = new SessionCommandTransportBridge({ registry, transports });
    const sync = new McpCentralSyncService({ registry, bridge, readGate: async () => ({ managed: { activated_at: null }, hasBindings: true }),
      buildSnapshot: async () => { throw new Error("unexpected"); }, updateAck: async () => {}, listManagedNodes: async () => [], currentRevision: async () => 4 });
    const actions = createMcpTestPreviewService({ service: { getConfig: async () => config } as never, sync,
      resolveSql: async () => (async () => [{ name: "key", value: "fake-secret-value" }]) as never });
    expect(await actions.test({ node_id: "n", server_id: "atom" })).toMatchObject({ ok: true });
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent)).not.toContain("icon");
    expect(config.current_revision).toBe(4);
  });
});
