import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { AgentRegistry } from "../../src/agent_registry.js";
import { withMcpRequestContext } from "../../src/mcp/request_context.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import { buildMcpServer } from "../../src/mcp/server.js";


function makeRuntime(): McpRuntime {
  // tests/mcp/external_events_wire.test.ts의 fake runtime 패턴.
  // Discovery only: no handler runs, and no service opens files or connects to a DB.
  return {
    nodeId: "test-node",
    agentsConfigPath: "/test/agents.yaml",
    db: {},
    taskManager: { listTasks: () => [] },
    taskExecutor: {},
    onResume: () => undefined,
    agentRegistry: new AgentRegistry([]),
    agentProfileSource: {},
    agentConfigService: {},
    mcpConfigService: {},
    catalogService: {},
    worktreeService: {},
    orch: { baseUrl: "https://orchestrator.example", headers: {} },
    logger: pino({ level: "silent" }),
  } as unknown as McpRuntime;
}

async function listTools(): Promise<Tool[]> {
  // Same SDK1 bridge and request context as external_events_transport.ts legacy().
  return withMcpRequestContext({}, async () => {
    const server = buildMcpServer(makeRuntime());
    const client = new Client({ name: "tool-inventory-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {});
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      return tools;
    } finally {
      await client.close();
      await server.close();
    }
  });
}

function serializeInventory(tools: Tool[]): string {
  return JSON.stringify(
    [...tools].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    (_key, value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
      : value,
    2,
  ) + "\n";
}

describe("advertised MCP tool inventory", () => {
  it("preserves the complete internal tools/list surface", async () => {
    const internal = await listTools();
    for (const name of ["list_worktrees", "create_worktree", "remove_worktree", "delete_worktree_branch"]) {
      expect(internal.find(tool => tool.name === name)!.inputSchema.properties).not.toHaveProperty("node_id");
    }
    expect(internal.find(tool => tool.name === "create_remote_agent_session")!.inputSchema.properties).not.toHaveProperty("worktree_id");
    expect(internal.find(tool => tool.name === "create_agent_session")!.inputSchema.properties).toHaveProperty("worktree_id");
    expect(internal.find(tool => tool.name === "create_card")!.inputSchema.properties).toHaveProperty("run");
    expect(internal.find(tool => tool.name === "run_card")).toBeDefined();
    expect(internal).toHaveLength(110);
    await expect(serializeInventory(internal)).toMatchFileSnapshot("./fixtures/tool_inventory.internal.json");
  });
});
