import {
  CONTROL_COMMAND_TYPES,
  type ControlCommandType,
} from "@soulstream/wire-schema";

export type ControlCommandFamily =
  | "health"
  | "session"
  | "intervention"
  | "claude-runtime"
  | "realtime"
  | "attachment"
  | "auth/provider-usage"
  | "reflection"
  | "agent-config"
  | "worktree";

export type ControlCommandPolicy =
  | "health"
  | "durable_mutation"
  | "bounded_result"
  | "fire_and_forget";

export type ControlCommandInventoryEntry = {
  type: ControlCommandType;
  family: ControlCommandFamily;
  policy: ControlCommandPolicy;
};

export const CONTROL_COMMAND_INVENTORY = [
  entry("health_check", "health", "health"),
  entry("create_session", "session", "durable_mutation"),
  entry("interrupt_session", "session", "durable_mutation"),
  entry("acknowledge_session_review", "session", "durable_mutation"),
  entry("subscribe_events", "realtime", "fire_and_forget"),
  entry("list_sessions", "session", "bounded_result"),
  entry("list_runner_inventory", "session", "bounded_result"),
  entry("respond", "intervention", "durable_mutation"),
  entry("approve_tool", "intervention", "durable_mutation"),
  entry("reject_tool", "intervention", "durable_mutation"),
  entry("intervene", "intervention", "durable_mutation"),
  entry("claude_runtime_list_tasks", "claude-runtime", "bounded_result"),
  entry("claude_runtime_task_output", "claude-runtime", "bounded_result"),
  entry("claude_runtime_stop_task", "claude-runtime", "durable_mutation"),
  entry("claude_runtime_background_tasks", "claude-runtime", "bounded_result"),
  entry("claude_runtime_list_schedules", "claude-runtime", "bounded_result"),
  entry("claude_runtime_delete_schedule", "claude-runtime", "durable_mutation"),
  entry("realtime_create_call", "realtime", "durable_mutation"),
  entry("realtime_event", "realtime", "durable_mutation"),
  entry("realtime_resolve_tool_approval", "realtime", "durable_mutation"),
  entry("upload_attachment", "attachment", "durable_mutation"),
  entry("upload_attachment_start", "attachment", "durable_mutation"),
  entry("upload_attachment_chunk", "attachment", "durable_mutation"),
  entry("upload_attachment_finish", "attachment", "durable_mutation"),
  entry("upload_attachment_abort", "attachment", "durable_mutation"),
  entry("delete_session_attachments", "attachment", "durable_mutation"),
  entry("download_attachment", "attachment", "bounded_result"),
  entry("claude_auth_status", "auth/provider-usage", "bounded_result"),
  entry("claude_auth_set_token", "auth/provider-usage", "bounded_result"),
  entry("claude_auth_delete_token", "auth/provider-usage", "bounded_result"),
  entry("claude_auth_get_usage", "auth/provider-usage", "bounded_result"),
  entry("claude_auth_get_profile", "auth/provider-usage", "bounded_result"),
  entry("provider_usage_get", "auth/provider-usage", "bounded_result"),
  entry("reflect_brief", "reflection", "bounded_result"),
  entry("plan_agent_profile_update", "agent-config", "bounded_result"),
  entry("apply_agent_profile_update", "agent-config", "durable_mutation"),
  entry("list_agents_config_snapshots", "agent-config", "bounded_result"),
  entry("rollback_agents_config", "agent-config", "durable_mutation"),
  entry("worktree_list", "worktree", "bounded_result"),
  entry("worktree_create", "worktree", "durable_mutation"),
  entry("worktree_remove", "worktree", "durable_mutation"),
  entry("worktree_delete_branch", "worktree", "durable_mutation"),
] as const satisfies readonly ControlCommandInventoryEntry[];

export { CONTROL_COMMAND_TYPES };

const INVENTORY_BY_TYPE = new Map<string, ControlCommandInventoryEntry>(
  CONTROL_COMMAND_INVENTORY.map((item) => [item.type, item]),
);

export function controlCommandPolicy(commandType: string): ControlCommandInventoryEntry {
  const inventory = INVENTORY_BY_TYPE.get(commandType);
  if (!inventory) {
    throw new Error(
      `Command type is not present in the control command inventory: ${commandType}`,
    );
  }
  return inventory;
}

export function boundedResultTimeoutMs(commandType: string, fallbackMs: number): number {
  switch (commandType) {
    case "worktree_list":
      return 130_000;
    case "provider_usage_get":
    case "claude_auth_get_usage":
    case "claude_auth_get_profile":
      // Usage work can consume its 14s internal budget, and profile is in the
      // same external HTTP family. Stay below orch's 15s command limit.
      return 14_500;
    default:
      return fallbackMs;
  }
}

function entry(
  type: ControlCommandType,
  family: ControlCommandFamily,
  policy: ControlCommandPolicy,
): ControlCommandInventoryEntry {
  return { type, family, policy };
}
