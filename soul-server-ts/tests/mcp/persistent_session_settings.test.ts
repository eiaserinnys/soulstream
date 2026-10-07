import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRegistry } from "../../src/agent_registry.js";
import { withMcpRequestContext } from "../../src/mcp/request_context.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import { buildMcpServer } from "../../src/mcp/server.js";

afterEach(() => vi.unstubAllGlobals());

describe("update_persistent_session_settings MCP forwarding", () => {
  it("forwards settings and the authenticated caller session to the orchestrator", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Response(
      JSON.stringify({ content: [{ type: "text", text: "saved" }], structuredContent: { show_turn_usage: false } }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetch);
    const runtime = {
      nodeId: "node-1",
      agentsConfigPath: "/test/agents.yaml",
      db: {},
      taskManager: {},
      taskExecutor: {},
      onResume: () => undefined,
      agentRegistry: new AgentRegistry([]),
      catalogService: {},
      logger: pino({ level: "silent" }),
      orch: { baseUrl: "https://orchestrator.example", headers: { authorization: "Bearer service-token" } },
    } as unknown as McpRuntime;

    await withMcpRequestContext({ callerSessionId: "caller-session" }, async () => {
      const server = buildMcpServer(runtime);
      const client = new Client({ name: "persistent-settings-test", version: "1" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);

        const result = await client.callTool({
          name: "update_persistent_session_settings",
          arguments: { session_id: "target-session", show_turn_usage: false },
        });

        expect(result.isError).not.toBe(true);
        expect(fetch).toHaveBeenCalledOnce();
        const [url, request] = fetch.mock.calls[0]!;
        expect(String(url)).toBe("https://orchestrator.example/api/mcp/host/update_persistent_session_settings");
        expect(JSON.parse(String(request?.body))).toEqual({
          args: { session_id: "target-session", show_turn_usage: false },
          context: { principal: "internal", caller_session_id: "caller-session", node_id: "node-1" },
        });
      } finally {
        await client.close();
        await server.close();
      }
    });
  });

  it("rejects unknown fields before forwarding", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const runtime = {
      nodeId: "node-1", agentsConfigPath: "/test/agents.yaml", db: {}, taskManager: {}, taskExecutor: {},
      onResume: () => undefined, agentRegistry: new AgentRegistry([]), catalogService: {},
      logger: pino({ level: "silent" }), orch: { baseUrl: "https://orchestrator.example", headers: {} },
    } as unknown as McpRuntime;

    await withMcpRequestContext({ callerSessionId: "caller-session" }, async () => {
      const server = buildMcpServer(runtime);
      const client = new Client({ name: "persistent-settings-unknown-field-test", version: "1" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const result = await client.callTool({
          name: "update_persistent_session_settings",
          arguments: { session_id: "target-session", unrecognized: true },
        });
        expect(result.isError).toBe(true);

        const defaultModelResult = await client.callTool({
          name: "update_persistent_session_settings",
          arguments: {
            session_id: "target-session",
            default_model: { model_preset: "codex-6.1-sol", unrecognized: true },
          },
        });
        expect(defaultModelResult.isError).toBe(true);

        const fallbackModelResult = await client.callTool({
          name: "update_persistent_session_settings",
          arguments: {
            session_id: "target-session",
            fallback_model: { model_preset: "codex-6.1-sol", unrecognized: true },
          },
        });
        expect(fallbackModelResult.isError).toBe(true);
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        await client.close();
        await server.close();
      }
    });
  });
});
