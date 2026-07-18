import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";

import type { McpRuntime } from "../../src/mcp/runtime.js";
import {
  MUTATION_MCP_TOOLS,
  createGuardedMcpServer,
  guardMcpToolExecution,
  isMutationMcpTool,
} from "../../src/mcp/tool_access.js";

function makeRuntime(profile: McpRuntime["mcpToolProfile"]): McpRuntime {
  return { mcpToolProfile: profile } as McpRuntime;
}

describe("MCP tool access profiles", () => {
  it("enumerates Supervisor-blocked mutation tools", () => {
    expect(MUTATION_MCP_TOOLS).toEqual(
      expect.arrayContaining([
        "send_message_to_session",
        "create_agent_session",
        "create_remote_agent_session",
        "update_agent_profile",
        "set_agent_mcp_profile",
        "create_markdown_document",
        "move_board_item_to_container",
        "update_markdown_document",
        "download_session_history",
        "delete_session",
        "background_claude_tasks",
        "set_runbook_item_status",
        "create_page",
        "batch_page_operations",
        "upsert_page_markdown",
        "get_daily_page",
      ]),
    );
    expect(isMutationMcpTool("list_sessions")).toBe(false);
  });

  it("hides mutation tools from supervisor_readonly registration", () => {
    const registered = new Map<string, unknown>();
    const registerTool = vi.fn((name: string, _config: unknown, handler: unknown) => {
      registered.set(name, handler);
    });
    const guarded = createGuardedMcpServer(
      { registerTool } as unknown as McpServer,
      makeRuntime("supervisor_readonly"),
    );

    guarded.registerTool("send_message_to_session", { inputSchema: {} }, vi.fn());
    guarded.registerTool("download_session_history", { inputSchema: {} }, vi.fn());
    guarded.registerTool("set_runbook_item_status", { inputSchema: {} }, vi.fn());
    guarded.registerTool("move_board_item_to_container", { inputSchema: {} }, vi.fn());
    guarded.registerTool("list_sessions", { inputSchema: {} }, vi.fn());

    expect(registerTool).toHaveBeenCalledTimes(1);
    expect(registered.has("send_message_to_session")).toBe(false);
    expect(registered.has("download_session_history")).toBe(false);
    expect(registered.has("set_runbook_item_status")).toBe(false);
    expect(registered.has("move_board_item_to_container")).toBe(false);
    expect(registered.has("list_sessions")).toBe(true);
  });

  it("blocks mutation execution when a readonly runtime reaches the guard", () => {
    const blocked = guardMcpToolExecution(
      makeRuntime("supervisor_readonly"),
      "send_message_to_session",
    );
    expect(blocked?.isError).toBe(true);
    expect(blocked?.structuredContent).toEqual({
      error:
        'MCP tool "send_message_to_session" is blocked by profile supervisor_readonly',
    });
    expect(
      guardMcpToolExecution(
        makeRuntime("supervisor_readonly"),
        "download_session_history",
      )?.isError,
    ).toBe(true);
    expect(guardMcpToolExecution(makeRuntime("default"), "send_message_to_session")).toBeUndefined();
  });
});
