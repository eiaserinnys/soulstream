import { describe, expect, it, vi } from "vitest";

import { applyEventSessionEffect } from "../src/node/event_session_effect_applier.js";
import type { EventIngressQuerySql } from "../src/node/event_ingress_repository.js";
import type { EventIngressEnvelope, EventSessionEffect } from "../src/node/event_ingress_types.js";

describe("applyEventSessionEffect", () => {
  it.each([
    ["last_message", "session_update_last_message"],
    ["set_backend_session_id", "session_set_claude_id"],
    ["terminal_transition", "session_update"],
    ["append_metadata", "session_apply_metadata_entry"],
  ] as const)("applies %s through its session stored procedure", async (kind, procedure) => {
    const statements: string[] = [];
    const sql = (async (strings: TemplateStringsArray) => {
      statements.push(strings.join("?"));
      return [];
    }) as EventIngressQuerySql;

    await applyEventSessionEffect(sql, {
      nodeId: "node-a",
      eventId: 41,
      envelope: envelope(effect(kind)),
      effect: effect(kind),
    });

    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain(procedure);
    expect(statements[0]).not.toContain("last_event_id");
  });
});

function effect(kind: EventSessionEffect["kind"]): EventSessionEffect {
  if (kind === "last_message") return {
    kind,
    last_message: { type: "assistant_message", preview: "done", timestamp: "2026-08-06T00:00:00.000Z" },
    updated_at: "2026-08-06T00:00:00.000Z",
  };
  if (kind === "set_backend_session_id") return { kind, backend_session_id: "thread-1" };
  if (kind === "terminal_transition") return {
    kind,
    status: "completed",
    termination_reason: "completed",
    termination_detail: null,
    review_state: "not_required",
    updated_at: "2026-08-06T00:00:00.000Z",
  };
  return {
    kind,
    entry: { type: "caller_info", source: "agent" },
    updated_at: "2026-08-06T00:00:00.000Z",
    replace_existing_type: "caller_info",
  };
}

function envelope(sessionEffect: EventSessionEffect): EventIngressEnvelope {
  return {
    stream_id: "018f47b7-c6de-7d64-9c8d-0b62cbbb2e10",
    source_seq: 1,
    session_id: "session-a",
    event_type: "assistant_message",
    payload: { type: "assistant_message", content: "done" },
    searchable_text: "done",
    created_at: "2026-08-06T00:00:00.000Z",
    semantic_dedupe_key: null,
    session_effect: sessionEffect,
    payload_hash: "a".repeat(64),
  };
}
