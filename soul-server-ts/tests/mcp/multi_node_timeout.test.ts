import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerMultiNodeTools } from "../../src/mcp/tools/multi_node.js";

type ToolHandler = (input?: Record<string, unknown>) => Promise<unknown>;

const orch = {
  baseUrl: "http://orch.test",
  headers: {},
};

function captureTools(): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool: (
      name: string,
      _config: unknown,
      handler: ToolHandler,
    ) => handlers.set(name, handler),
  } as unknown as McpServer;
  const runtime = {
    orch,
    nodeId: "node-local",
    taskManager: { getTask: () => undefined },
    agentRegistry: { get: () => undefined },
    db: {},
    logger: { warn: vi.fn() },
  } as never;
  registerMultiNodeTools(server, runtime);
  return handlers;
}

async function invoke(
  handlers: Map<string, ToolHandler>,
  name: string,
  input?: Record<string, unknown>,
): Promise<void> {
  const handler = handlers.get(name);
  expect(handler, `${name} registered`).toBeTypeOf("function");
  await handler!(input);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("multi-node orch request timeouts", () => {
  it("allows node-command POSTs 35 seconds while GETs retain the 10-second default", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
    const handlers = captureTools();

    await invoke(handlers, "plan_remote_agent_profile_update", {
      node_id: "node-remote",
      profile: { id: "agent-a" },
    });
    await invoke(handlers, "apply_remote_agent_profile_update", {
      node_id: "node-remote",
      profile: { id: "agent-a" },
    });
    await invoke(handlers, "rollback_remote_agents_config", {
      node_id: "node-remote",
      snapshot_id: "snapshot-a",
    });
    await invoke(handlers, "create_remote_agent_session", {
      node_id: "node-remote",
      prompt: "hello",
      caller_session_id: "caller-session",
      folder_id: null,
    });
    await invoke(handlers, "list_nodes");

    expect(timeout.mock.calls.map(([timeoutMs]) => timeoutMs)).toEqual([
      35_000,
      35_000,
      35_000,
      35_000,
      10_000,
    ]);
  });
});
