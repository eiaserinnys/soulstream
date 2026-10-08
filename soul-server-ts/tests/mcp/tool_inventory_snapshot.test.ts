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
    expect(internal.find(tool => tool.name === "update_persistent_session_settings")).toMatchObject({
      inputSchema: {
        properties: {
          session_id: expect.any(Object),
          default_model: expect.any(Object),
          show_turn_usage: expect.any(Object),
          turn_usage_mode: expect.any(Object),
        },
      },
    });
    expect(internal.find(tool => tool.name === "request_session_generation_rollover")!).toMatchObject({
      description: "퍼시스턴트 세션의 다음 실행에서 새 세대(새 모델 세션)로 교체하도록 요청한다. 기본은 이전 세대의 체크포인트를 이어 받는다. reset_context=true면 체크포인트를 현재 상태와 keep_instructions 설정에 따른 지속 지시만으로 다시 구성해 이전 대화 문맥을 비운다.",
      inputSchema: {
        properties: {
          reset_context: {
            description: "true면 새 세대 체크포인트에서 이전 줄거리, 요약, 최근 원문을 제외한다. 현재 상태는 포함하며 지속 지시는 keep_instructions 값에 따른다. 기본 false.",
          },
          keep_instructions: {
            description: "reset_context=true일 때만 사용한다. false면 해당 세대 체크포인트에서 지속 지시를 빼며 저장된 지시는 삭제하지 않는다. 기본 true.",
          },
        },
      },
    });
    for(const name of ["set_card_items","add_card_item","report_card_item","update_card_now","add_card_note","list_card_notes"])
      expect(internal.find(tool=>tool.name===name)).toBeDefined();
    expect(internal).toHaveLength(124);
    await expect(serializeInventory(internal)).toMatchFileSnapshot("./fixtures/tool_inventory.internal.json");
  });
});
