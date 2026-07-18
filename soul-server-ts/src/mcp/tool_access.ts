import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { errorResult } from "./result.js";
import type { McpRuntime } from "./runtime.js";

export type McpToolProfile = "default" | "supervisor_readonly";

export const MUTATION_MCP_TOOLS = [
  "create_agent_session",
  "send_message_to_session",
  "set_session_name",
  "stop_claude_background_task",
  "background_claude_tasks",
  "create_folder",
  "rename_folder",
  "move_folder",
  "delete_folder",
  "move_sessions_to_folder",
  "update_board_item_position",
  "move_board_item_to_container",
  "create_markdown_document",
  "update_markdown_document",
  "delete_markdown_document",
  "set_folder_system_prompt",
  "delete_session",
  "download_session_history",
  "update_agent_profile",
  "set_agent_mcp_profile",
  "set_agent_atom_contexts",
  "rollback_agents_config",
  "apply_remote_agent_profile_update",
  "rollback_remote_agents_config",
  "create_remote_agent_session",
  "create_runbook",
  "update_runbook",
  "set_runbook_status",
  "archive_runbook",
  "unarchive_runbook",
  "create_runbook_section",
  "update_runbook_section",
  "set_runbook_section_assignee",
  "archive_runbook_section",
  "unarchive_runbook_section",
  "move_runbook_section",
  "create_runbook_item",
  "update_runbook_item",
  "set_runbook_item_assignee",
  "archive_runbook_item",
  "unarchive_runbook_item",
  "move_runbook_item",
  "set_runbook_item_status",
  "create_custom_view",
  "patch_custom_view",
  "create_page",
  "batch_page_operations",
  "upsert_page_markdown",
  "get_daily_page",
] as const;

const MUTATION_TOOL_SET = new Set<string>(MUTATION_MCP_TOOLS);

export function isMutationMcpTool(toolName: string): boolean {
  return MUTATION_TOOL_SET.has(toolName);
}

export function isMcpToolAllowed(runtime: McpRuntime, toolName: string): boolean {
  const profile = runtime.mcpToolProfile ?? "default";
  return profile !== "supervisor_readonly" || !isMutationMcpTool(toolName);
}

export function guardMcpToolExecution(
  runtime: McpRuntime,
  toolName: string,
): CallToolResult | undefined {
  if (isMcpToolAllowed(runtime, toolName)) return undefined;
  return errorResult(
    `MCP tool "${toolName}" is blocked by profile supervisor_readonly`,
  );
}

export function createGuardedMcpServer(
  server: McpServer,
  runtime: McpRuntime,
): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop !== "registerTool") {
        return Reflect.get(target, prop, receiver);
      }
      return (name: string, config: unknown, handler: (...args: unknown[]) => unknown) => {
        if (!isMcpToolAllowed(runtime, name)) return undefined;
        const wrappedHandler = async (...args: unknown[]) => {
          const blocked = guardMcpToolExecution(runtime, name);
          if (blocked) return blocked;
          return await handler(...args);
        };
        const registerTool = Reflect.get(target, prop, target) as (
          toolName: string,
          toolConfig: unknown,
          toolHandler: (...args: unknown[]) => unknown,
        ) => unknown;
        return registerTool.call(target, name, config, wrappedHandler);
      };
    },
  }) as McpServer;
}
