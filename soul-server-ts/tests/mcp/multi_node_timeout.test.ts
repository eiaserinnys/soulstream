import { clusterTools } from "@soulstream/mcp-contract";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerOrchestratorTools } from "../../src/mcp/orchestrator_tools.js";
import { registerMultiNodeTools } from "../../src/mcp/tools/multi_node.js";
import { boardTools } from "../../../packages/mcp-contract/src/board_tools.js";
import { sessionTools } from "../../../packages/mcp-contract/src/session_tools.js";

type ToolHandler = (input?: Record<string, unknown>, request?: unknown) => Promise<unknown>;

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
  registerOrchestratorTools(server, runtime, [
    sessionTools.list_sessions,
    sessionTools.list_user_messages,
    boardTools.create_markdown_document,
    boardTools.get_markdown_document,
    boardTools.update_markdown_document,
    boardTools.delete_markdown_document,
  ]);
  return handlers;
}

async function invoke(
  handlers: Map<string, ToolHandler>,
  name: string,
  input?: Record<string, unknown>,
): Promise<void> {
  const handler = handlers.get(name);
  expect(handler, `${name} registered`).toBeTypeOf("function");
  await handler!(input, {});
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("multi-node common forwarding deadlines", () => {
  it("allows command tools 35 seconds, remote create 45, while query tools retain the 10-second default", async () => {
    expect(sessionTools.list_sessions.timeoutMs).toBe(35_000);
    expect(sessionTools.list_user_messages.timeoutMs).toBe(35_000);
    for (const name of ["plan_remote_agent_profile_update", "apply_remote_agent_profile_update", "rollback_remote_agents_config"] as const) {
      expect(clusterTools[name].timeoutMs).toBe(35_000);
    }
    // Remote create waits for the node command, the reconcile window and the
    // durable outcome lookup before the caller gives up (card #1326).
    expect(clusterTools.create_remote_agent_session.timeoutMs).toBe(45_000);
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
    await invoke(handlers, "list_sessions", {
      since: "2026-10-26T18:00:00Z",
      until: "2026-10-27T18:00:00Z",
      cursor: 0,
      limit: 100,
    });
    await invoke(handlers, "list_user_messages", {
      since: "2026-10-26T18:00:00Z",
      until: "2026-10-27T18:00:00Z",
      cursor: 0,
      limit: 100,
    });
    await invoke(handlers, "list_nodes");

    expect(timeout.mock.calls.map(([timeoutMs]) => timeoutMs)).toEqual([
      35_000,
      35_000,
      35_000,
      45_000,
      35_000,
      35_000,
      10_000,
    ]);
  });

  it("gives document writes a 60-second forwarding deadline while document reads keep the default", async () => {
    expect(boardTools.create_markdown_document.timeoutMs).toBe(60_000);
    expect(boardTools.update_markdown_document.timeoutMs).toBe(60_000);
    expect(boardTools.delete_markdown_document.timeoutMs).toBe(60_000);
    expect("timeoutMs" in boardTools.get_markdown_document).toBe(false);

    const timeout = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
    const handlers = captureTools();

    await invoke(handlers, "create_markdown_document", {
      folder_id: "folder-1",
      title: "문서",
      body: "",
    });
    await invoke(handlers, "update_markdown_document", {
      document_id: "doc-1",
      expected_version: 1,
      body: "본문",
    });
    await invoke(handlers, "delete_markdown_document", { document_id: "doc-1" });
    await invoke(handlers, "get_markdown_document", { document_id: "doc-1" });

    expect(timeout.mock.calls.map(([timeoutMs]) => timeoutMs)).toEqual([
      60_000,
      60_000,
      60_000,
      10_000,
    ]);
  });
});
