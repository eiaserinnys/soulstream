import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRegistry } from "../../src/agent_registry.js";
import { withMcpRequestContext } from "../../src/mcp/request_context.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import { buildMcpServer } from "../../src/mcp/server.js";

afterEach(() => vi.unstubAllGlobals());

describe("list_persistent_session_history MCP forwarding", () => {
  it("registers the internal tool and forwards the period with the authenticated caller session", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(
      JSON.stringify({
        content: [{ type: "text", text: "history" }],
        structuredContent: { session_id: "pas-1", entries: [], returned_count: 0, next_cursor: null },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetch);
    const runtime = {
      nodeId: "node-1", agentsConfigPath: "/test/agents.yaml", db: {}, taskManager: {}, taskExecutor: {},
      onResume: () => undefined, agentRegistry: new AgentRegistry([]), catalogService: {},
      logger: pino({ level: "silent" }), orch: { baseUrl: "https://orchestrator.example", headers: { authorization: "Bearer service-token" } },
    } as unknown as McpRuntime;

    await withMcpRequestContext({ callerSessionId: "caller-session" }, async () => {
      const server = buildMcpServer(runtime);
      const client = new Client({ name: "persistent-session-history-test", version: "1" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const listed = await client.listTools();
        expect(listed.tools.map((tool) => tool.name)).toContain("list_persistent_session_history");

        const result = await client.callTool({
          name: "list_persistent_session_history",
          arguments: {
            session_id: "pas-1",
            since: "2026-10-05T00:00:00+09:00",
            until: "2026-10-06T00:00:00+09:00",
            cursor: 4,
            limit: 10,
            max_text_chars: 1000,
          },
        });
        expect(result.isError).not.toBe(true);
        expect(fetch).toHaveBeenCalledOnce();
        const [url, request] = fetch.mock.calls[0]!;
        expect(String(url)).toBe("https://orchestrator.example/api/mcp/host/list_persistent_session_history");
        expect(JSON.parse(String(request?.body))).toEqual({
          args: {
            session_id: "pas-1", since: "2026-10-05T00:00:00+09:00", until: "2026-10-06T00:00:00+09:00",
            cursor: 4, limit: 10, max_text_chars: 1000,
          },
          context: { principal: "internal", caller_session_id: "caller-session", node_id: "node-1" },
        });
      } finally {
        await client.close();
        await server.close();
      }
    });
  });

  it("rejects user-selected identity fields before forwarding", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const runtime = {
      nodeId: "node-1", agentsConfigPath: "/test/agents.yaml", db: {}, taskManager: {}, taskExecutor: {},
      onResume: () => undefined, agentRegistry: new AgentRegistry([]), catalogService: {},
      logger: pino({ level: "silent" }), orch: { baseUrl: "https://orchestrator.example", headers: {} },
    } as unknown as McpRuntime;

    await withMcpRequestContext({ callerSessionId: "caller-session" }, async () => {
      const server = buildMcpServer(runtime);
      const client = new Client({ name: "persistent-session-history-identity-test", version: "1" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const result = await client.callTool({
          name: "list_persistent_session_history",
          arguments: { since: "2026-10-05T00:00:00+09:00", until: "2026-10-06T00:00:00+09:00", user_id: "forged" },
        });
        expect(result.isError).toBe(true);
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        await client.close();
        await server.close();
      }
    });
  });
});
