import { describe, expect, it } from "vitest";
import { projectPersistentSessionHistoryEntry } from "../src/session/persistent_session_history_projection.js";
import type { PersistentSessionHistoryRow } from "../src/control_plane/repositories/persistent_session_history_query.js";

const createdAt = new Date("2026-10-05T14:00:00.123Z");

function row(event_type: string, payload: Record<string, unknown>, overrides: Partial<PersistentSessionHistoryRow> = {}): PersistentSessionHistoryRow {
  return {
    id: 7,
    session_id: "pas-1",
    event_type,
    payload,
    created_at: createdAt,
    parent_event_id: null,
    generation: 2,
    ...overrides,
  };
}

describe("projectPersistentSessionHistoryEntry", () => {
  it.each([
    ["slack", "human"],
    ["browser", "human"],
    ["soul-app", "human"],
    ["agent", "agent"],
    ["api", "system"],
    ["channel_observer", "system"],
    ["execute-proxy", "system"],
    ["llm", "system"],
    ["system", "system"],
    ["future-source", "unknown"],
  ] as const)("preserves source %s while assigning kind %s", (source, kind) => {
    const entry = projectPersistentSessionHistoryEntry(row("user_message", {
      text: "hello",
      caller_info: { source },
    }), 2000);
    expect(entry).toMatchObject({ event_type: "user_message", kind, source, text: "hello" });
  });

  it("uses caller_info and deduplicates canonical IDs and legacy attachment paths", () => {
    const entry = projectPersistentSessionHistoryEntry(row("user_message", {
      text: "image",
      input_id: "input-1",
      purpose: "cache_keepalive",
      caller_info: {
        source: "browser",
        display_name: "Caller",
        user_id: "user-1",
        agent_id: "agent-1",
        agent_name: "Agent",
        agent_node: "node-1",
        email: "private@example.com",
      },
      source: "agent",
      agent_id: "legacy-agent",
      attachment_ids: ["attachment-1", "attachment-2", "attachment-1", "", 17],
      attachments: ["/legacy/path-a", "/legacy/path-a", "/legacy/path-b", { path: "/hidden/object-path" }, "", " "],
      node_id: "source-worker",
      context: [{ text: "private context" }],
    }), 2000);

    expect(entry).toMatchObject({
      input_id: "input-1",
      source: "browser",
      sender: {
        display_name: "Caller", user_id: "user-1", agent_id: "agent-1",
        agent_name: "Agent", agent_node: "node-1",
      },
      purpose: "cache_keepalive",
      attachment_ids: ["attachment-1", "attachment-2"],
      attachments: ["/legacy/path-a", "/legacy/path-b", " "],
      attachment_count: 2,
      node_id: "source-worker",
    });
    expect(JSON.stringify(entry)).not.toContain("private@example.com");
    expect(JSON.stringify(entry)).not.toContain("/hidden/object-path");
    expect(JSON.stringify(entry)).not.toContain("private context");
  });

  it("keeps legacy top-level sender fields when caller_info is absent", () => {
    const entry = projectPersistentSessionHistoryEntry(row("intervention_sent", {
      text: "legacy",
      source: "agent",
      agent_id: "legacy-agent",
      agent_name: "Legacy Agent",
      agent_node: "legacy-node",
      user_id: "legacy-user",
    }), 2000);
    expect(entry).toMatchObject({
      kind: "agent", source: "agent",
      sender: { user_id: "legacy-user", agent_id: "legacy-agent", agent_name: "Legacy Agent", agent_node: "legacy-node" },
    });
  });

  it("keeps legacy-only attachment paths and rejects history objects", () => {
    const attachmentOnly = projectPersistentSessionHistoryEntry(row("user_message", {
      attachments: ["/legacy/only", "/legacy/only", { id: "must-not-infer" }, ""],
      caller_info: {},
    }), 100);
    expect(attachmentOnly).toMatchObject({
      kind: "unknown", text: "", text_chars: 0, truncated: false,
      attachment_ids: [], attachments: ["/legacy/only"], attachment_count: 1,
    });
    expect(attachmentOnly).not.toHaveProperty("node_id");
    expect(JSON.stringify(attachmentOnly)).not.toContain("must-not-infer");
  });

  it("keeps attachment-only messages and does not truncate attachment fields with text", () => {
    const truncated = projectPersistentSessionHistoryEntry(row("intervention_sent", {
      text: "A🧭BC",
      caller_info: { source: "agent" },
      attachment_ids: ["attachment-id"],
      attachments: ["/very/long/legacy/path"],
      node_id: "worker-original",
    }), 3);
    expect(truncated).toMatchObject({
      kind: "agent", text: "A🧭B", text_chars: 4, truncated: true,
      attachment_ids: ["attachment-id"], attachments: ["/very/long/legacy/path"],
      attachment_count: 1, node_id: "worker-original",
    });
  });

  it("keeps durable assistant messages distinct and preserves parent_event_id", () => {
    const entry = projectPersistentSessionHistoryEntry(row("assistant_message", {
      content: "same final",
      parent_event_id: "payload-parent",
      text_delta: "must not be merged",
      result: "must not be merged",
    }, { id: 19, parent_event_id: 5 }), 2000);
    expect(entry).toMatchObject({ kind: "assistant", text: "same final", parent_event_id: 5 });
    expect(entry).not.toHaveProperty("result");
    expect(entry).not.toHaveProperty("text_delta");
  });

  it("projects assistant output attachment IDs and markers even when content is empty", () => {
    const entry = projectPersistentSessionHistoryEntry(row("assistant_message", {
      content: "",
      attachment_ids: ["asset-1", "asset-2", "asset-1", "", 17],
      attachments: ["/legacy/path.png"],
      attachment_output: true,
      output_command_id: "command-1",
    }), 2000);

    expect(entry).toMatchObject({
      event_type: "assistant_message",
      kind: "assistant",
      text: "",
      text_chars: 0,
      truncated: false,
      attachment_ids: ["asset-1", "asset-2"],
      attachment_count: 2,
      attachment_output: true,
      output_command_id: "command-1",
    });
    expect(entry).not.toHaveProperty("attachments");
  });

  it("only forwards true output markers and string command IDs", () => {
    const entry = projectPersistentSessionHistoryEntry(row("assistant_message", {
      content: "answer",
      attachment_ids: ["asset-1", "asset-1"],
      attachment_output: false,
      output_command_id: 17,
    }), 2000);

    expect(entry).toMatchObject({ attachment_ids: ["asset-1"], attachment_count: 1 });
    expect(entry).not.toHaveProperty("attachment_output");
    expect(entry).not.toHaveProperty("output_command_id");
    expect(entry).not.toHaveProperty("attachments");
  });

  it.each(["legacy-parent", 23])("preserves payload-only assistant parent reference %s", (parentEventId) => {
    const entry = projectPersistentSessionHistoryEntry(row("assistant_message", {
      content: "nested final",
      parent_event_id: parentEventId,
    }), 2000);
    expect(entry).toMatchObject({ kind: "assistant", text: "nested final", parent_event_id: parentEventId });
  });

  it("projects notification identity and only the saved generation transition fields", () => {
    const notification = projectPersistentSessionHistoryEntry(row("session_notification", {
      source: "completion_notifier",
      delivery_id: "delivery-1",
      delivery_intent: "completion_notification",
      text: "finished",
      context: "private context",
    }), 2000);
    expect(notification).toMatchObject({
      kind: "system", source: "completion_notifier", delivery_id: "delivery-1",
      delivery_intent: "completion_notification", text: "finished",
    });
    expect(notification).not.toHaveProperty("context");

    const generation = projectPersistentSessionHistoryEntry(row("generation_started", {
      generation: 2,
      reason: "model_change",
      previous: { model_preset: "claude-opus", backend: "claude", model: "opus-4", backend_session_id: "private" },
      current: { model_preset: "codex-6.1-sol", backend: "codex", model: "gpt-6-sol", backend_session_id: "private" },
      context_reset: true,
      checkpoint: { private: true },
    }), 2000);
    expect(generation).toMatchObject({
      kind: "generation", generation: 2, text: "세대 2 시작", reason: "model_change",
      previous: { model_preset: "claude-opus", backend: "claude", model: "opus-4" },
      current: { model_preset: "codex-6.1-sol", backend: "codex", model: "gpt-6-sol" },
      context_reset: true,
    });
    expect(JSON.stringify(generation)).not.toContain("backend_session_id");
    expect(generation).not.toHaveProperty("checkpoint");
  });

  it("returns UTC and KST ISO timestamps and leaves missing generation explicit", () => {
    const entry = projectPersistentSessionHistoryEntry(row("user_message", { text: "old" }, {
      created_at: createdAt,
      generation: null,
    }), 2000);
    expect(entry).toMatchObject({
      event_id: 7,
      created_at: "2026-10-05T14:00:00.123Z",
      created_at_kst: "2026-10-05T23:00:00.123+09:00",
      generation: null,
    });
  });
});
