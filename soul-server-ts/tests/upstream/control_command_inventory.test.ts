import { describe, expect, it } from "vitest";

import { createAgentConfigCommandFamily } from "../../src/upstream/agent_config_command_family.js";
import { createAttachmentCommandFamily } from "../../src/upstream/attachment_command_family.js";
import { createAuthCommandFamily } from "../../src/upstream/auth_command_family.js";
import { createClaudeRuntimeCommandFamily } from "../../src/upstream/claude_runtime_command_family.js";
import {
  CONTROL_COMMAND_INVENTORY,
  controlCommandPolicy,
} from "../../src/upstream/control_command_inventory.js";
import { createHealthCommandFamily } from "../../src/upstream/health_command_family.js";
import { createInterventionCommandFamily } from "../../src/upstream/intervention_command_family.js";
import { createRealtimeCommandFamily } from "../../src/upstream/realtime_command_family.js";
import { createReflectionCommandFamily } from "../../src/upstream/reflection_command_family.js";
import { createSessionCommandFamily } from "../../src/upstream/session_command_family.js";

describe("control command inventory", () => {
  it("covers every dispatcher command type exactly once", () => {
    const handlerTypes = Object.keys({
      ...createHealthCommandFamily({} as never),
      ...createSessionCommandFamily({} as never),
      ...createInterventionCommandFamily({} as never),
      ...createClaudeRuntimeCommandFamily({} as never),
      ...createRealtimeCommandFamily({} as never),
      ...createAttachmentCommandFamily({} as never),
      ...createAuthCommandFamily({} as never),
      ...createReflectionCommandFamily({} as never),
      ...createAgentConfigCommandFamily({} as never),
    }).sort();
    const inventoryTypes = CONTROL_COMMAND_INVENTORY.map(({ type }) => type).sort();

    expect(inventoryTypes).toHaveLength(38);
    expect(new Set(inventoryTypes).size).toBe(inventoryTypes.length);
    expect(inventoryTypes).toEqual(handlerTypes);
  });

  it("has the nine approved families and only one fire-and-forget command", () => {
    expect(new Set(CONTROL_COMMAND_INVENTORY.map(({ family }) => family))).toEqual(
      new Set([
        "health",
        "session",
        "intervention",
        "claude-runtime",
        "realtime",
        "attachment",
        "auth/provider-usage",
        "reflection",
        "agent-config",
      ]),
    );
    expect(
      CONTROL_COMMAND_INVENTORY.filter(({ policy }) => policy === "fire_and_forget"),
    ).toEqual([
      expect.objectContaining({ type: "subscribe_events", family: "realtime" }),
    ]);
  });

  it("locks the full nine-family policy decision table", () => {
    expect(CONTROL_COMMAND_INVENTORY).toEqual([
      { type: "health_check", family: "health", policy: "health" },
      { type: "create_session", family: "session", policy: "durable_mutation" },
      { type: "interrupt_session", family: "session", policy: "durable_mutation" },
      { type: "acknowledge_session_review", family: "session", policy: "durable_mutation" },
      { type: "subscribe_events", family: "realtime", policy: "fire_and_forget" },
      { type: "list_sessions", family: "session", policy: "bounded_result" },
      { type: "list_runner_inventory", family: "session", policy: "bounded_result" },
      { type: "respond", family: "intervention", policy: "durable_mutation" },
      { type: "approve_tool", family: "intervention", policy: "durable_mutation" },
      { type: "reject_tool", family: "intervention", policy: "durable_mutation" },
      { type: "intervene", family: "intervention", policy: "durable_mutation" },
      { type: "claude_runtime_list_tasks", family: "claude-runtime", policy: "bounded_result" },
      { type: "claude_runtime_task_output", family: "claude-runtime", policy: "bounded_result" },
      { type: "claude_runtime_stop_task", family: "claude-runtime", policy: "durable_mutation" },
      { type: "claude_runtime_background_tasks", family: "claude-runtime", policy: "bounded_result" },
      { type: "claude_runtime_list_schedules", family: "claude-runtime", policy: "bounded_result" },
      { type: "claude_runtime_delete_schedule", family: "claude-runtime", policy: "durable_mutation" },
      { type: "realtime_create_call", family: "realtime", policy: "durable_mutation" },
      { type: "realtime_event", family: "realtime", policy: "durable_mutation" },
      { type: "realtime_resolve_tool_approval", family: "realtime", policy: "durable_mutation" },
      { type: "upload_attachment", family: "attachment", policy: "durable_mutation" },
      { type: "upload_attachment_start", family: "attachment", policy: "durable_mutation" },
      { type: "upload_attachment_chunk", family: "attachment", policy: "durable_mutation" },
      { type: "upload_attachment_finish", family: "attachment", policy: "durable_mutation" },
      { type: "upload_attachment_abort", family: "attachment", policy: "durable_mutation" },
      { type: "delete_session_attachments", family: "attachment", policy: "durable_mutation" },
      { type: "download_attachment", family: "attachment", policy: "bounded_result" },
      { type: "claude_auth_status", family: "auth/provider-usage", policy: "bounded_result" },
      { type: "claude_auth_set_token", family: "auth/provider-usage", policy: "bounded_result" },
      { type: "claude_auth_delete_token", family: "auth/provider-usage", policy: "bounded_result" },
      { type: "claude_auth_get_usage", family: "auth/provider-usage", policy: "bounded_result" },
      { type: "claude_auth_get_profile", family: "auth/provider-usage", policy: "bounded_result" },
      { type: "provider_usage_get", family: "auth/provider-usage", policy: "bounded_result" },
      { type: "reflect_brief", family: "reflection", policy: "bounded_result" },
      { type: "plan_agent_profile_update", family: "agent-config", policy: "bounded_result" },
      { type: "apply_agent_profile_update", family: "agent-config", policy: "durable_mutation" },
      { type: "list_agents_config_snapshots", family: "agent-config", policy: "bounded_result" },
      { type: "rollback_agents_config", family: "agent-config", policy: "durable_mutation" },
    ]);
  });

  it("rejects command types that are absent from the decision table", () => {
    expect(() => controlCommandPolicy("unreviewed_command")).toThrow(
      /not present in the control command inventory/,
    );
  });
});
