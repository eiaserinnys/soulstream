import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { AgentRegistry } from "../../src/agent_registry.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import { buildMcpServer } from "../../src/mcp/server.js";
import {
  INTERNAL_MCP_PRINCIPAL,
  withMcpRequestContext,
  type McpCallerPrincipal,
} from "../../src/mcp/request_context.js";

const excludedExternalToolNames = [
  "delete_folder",
  "delete_markdown_document",
  "delete_session",
  "delete_worktree_branch",
  "update_agent_profile",
  "set_agent_mcp_profile",
  "rollback_agents_config",
  "apply_remote_agent_profile_update",
  "rollback_remote_agents_config",
  "set_agent_atom_contexts",
  "set_folder_system_prompt",
  "create_worktree",
  "remove_worktree",
  "list_external_llm_recipients",
  "send_to_external_llm",
];

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
    folderService: {},
    customViewService: {},
    pageHostClient: {},
    worktreeService: {},
    externalEvents: {},
    orch: { baseUrl: "https://orchestrator.example", headers: {} },
    logger: pino({ level: "silent" }),
  } as unknown as McpRuntime;
}

async function listTools(principal: McpCallerPrincipal): Promise<Tool[]> {
  // Same SDK1 bridge and request context as external_events_transport.ts legacy().
  return withMcpRequestContext({ principal }, async () => {
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
  it("preserves both complete tools/list surfaces and their exact difference", async () => {
    const internal = await listTools(INTERNAL_MCP_PRINCIPAL);
    const external = await listTools({
      authority: "external", source: "external-llm", displayName: "External LLM",
    });
    expect(internal).toHaveLength(106);
    expect(external).toHaveLength(91);
    const externalNames = new Set(external.map(tool => tool.name));
    const difference = internal.map(tool => tool.name).filter(name => !externalNames.has(name));
    expect(difference.sort()).toEqual([...excludedExternalToolNames].sort());
    await expect(serializeInventory(internal)).toMatchFileSnapshot("./fixtures/tool_inventory.internal.json");
    await expect(serializeInventory(external)).toMatchFileSnapshot("./fixtures/tool_inventory.external.json");
  });
});
