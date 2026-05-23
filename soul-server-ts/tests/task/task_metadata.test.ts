import { describe, expect, it } from "vitest";

import {
  buildCallerInfoMetadataEntry,
  extractAgentsRunStateFromMetadata,
  extractAgentsSessionItemsFromMetadata,
  extractCallerInfoFromMetadata,
} from "../../src/task/task_metadata.js";

describe("task metadata helpers", () => {
  it("builds caller_info metadata only for non-empty caller info", () => {
    expect(buildCallerInfoMetadataEntry(undefined)).toBeUndefined();
    expect(buildCallerInfoMetadataEntry({})).toBeUndefined();
    expect(buildCallerInfoMetadataEntry({ source: "slack" })).toEqual({
      type: "caller_info",
      value: { source: "slack" },
    });
  });

  it("extracts the last identity-bearing caller_info before falling back to last caller_info", () => {
    const metadata = [
      { type: "caller_info", value: { source: "browser", display_name: "Old" } },
      { type: "caller_info", value: { source: "slack", display_name: "Alice" } },
      { type: "caller_info", value: {} },
    ];

    expect(extractCallerInfoFromMetadata(metadata)).toEqual({
      source: "slack",
      display_name: "Alice",
    });
  });

  it("treats identity-bearing sources as identity even without display fields", () => {
    const metadata = [
      { type: "caller_info", value: { source: "agent", agent_id: "roselin" } },
      { type: "caller_info", value: { source: "browser" } },
    ];

    expect(extractCallerInfoFromMetadata(metadata)).toEqual({
      source: "agent",
      agent_id: "roselin",
    });
  });

  it("falls back to the last caller_info entry when no entry has identity", () => {
    expect(extractCallerInfoFromMetadata([
      { type: "caller_info", value: { source: "browser" } },
      { type: "caller_info", value: { legacy: true } },
    ])).toEqual({ legacy: true });
  });

  it("extracts latest OpenAI Agents run state and session items", () => {
    const metadata = [
      {
        type: "agents_run_state",
        value: {
          backend: "openai-agents",
          serialized: "state-old",
          pendingApprovalId: "old-approval",
        },
      },
      {
        type: "agents_session_items",
        value: { backend: "openai-agents", items: [{ role: "user", content: "old" }] },
      },
      {
        type: "agents_run_state",
        value: {
          backend: "openai-agents",
          serialized: "state-new",
          pendingApprovalId: "approval-1",
          previousResponseId: "resp-1",
          conversationId: "conv-1",
          schemaVersion: "1.11",
        },
      },
      {
        type: "agents_session_items",
        value: { backend: "openai-agents", items: [{ role: "user", content: "new" }] },
      },
    ];

    expect(extractAgentsRunStateFromMetadata(metadata)).toEqual({
      serialized: "state-new",
      pendingApprovalId: "approval-1",
      previousResponseId: "resp-1",
      conversationId: "conv-1",
      schemaVersion: "1.11",
    });
    expect(extractAgentsSessionItemsFromMetadata(metadata)).toEqual([
      { role: "user", content: "new" },
    ]);
  });

  it("ignores malformed and non-openai-agents metadata", () => {
    const metadata = [
      null,
      { type: "agents_run_state", value: { backend: "codex", serialized: "state" } },
      { type: "agents_session_items", value: { backend: "openai-agents", items: "bad" } },
    ];

    expect(extractCallerInfoFromMetadata(metadata)).toBeUndefined();
    expect(extractAgentsRunStateFromMetadata(metadata)).toBeUndefined();
    expect(extractAgentsSessionItemsFromMetadata(metadata)).toBeUndefined();
  });
});
