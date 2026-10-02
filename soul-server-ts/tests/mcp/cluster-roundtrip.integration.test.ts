import { mcpToolDefinitions } from "@soulstream/mcp-contract";
import { describe, expect, it } from "vitest";

const clusterToolNames = [
  "list_recurring_jobs", "get_recurring_job", "preview_recurring_schedule", "create_recurring_job",
  "update_recurring_job", "run_recurring_job", "archive_recurring_job", "list_recurring_job_runs",
  "get_card_orchestration_settings", "update_card_orchestration_settings",
  "list_nodes", "list_node_agents", "list_node_model_presets", "reflect_cluster_brief",
  "plan_remote_agent_profile_update", "apply_remote_agent_profile_update",
  "list_remote_agents_config_snapshots", "rollback_remote_agents_config", "create_remote_agent_session",
] as const;

describe("cluster MCP contract availability", () => {
  it.each(clusterToolNames)("makes %s executable through the common contract", name => {
    expect(mcpToolDefinitions.find(tool => tool.name === name)).toBeDefined();
  });
});
