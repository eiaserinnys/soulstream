import { describe, expect, it, vi } from "vitest";

import { applyEventSessionEffect } from "../src/node/event_session_effect_applier.js";
import type { EventIngressQuerySql } from "../src/node/event_ingress_repository.js";
import type { EventIngressEnvelope, EventSessionEffect } from "../src/node/event_ingress_types.js";

describe("applyEventSessionEffect", () => {
  it.each([
    ["last_message", "session_update_last_message"],
    ["set_backend_session_id", "session_set_claude_id"],
    ["running_transition", "session_apply_running_transition"],
    ["terminal_transition", "session_apply_terminal_transition"],
    ["append_metadata", "session_apply_metadata_entry"],
  ] as const)("applies %s through its session stored procedure", async (kind, procedure) => {
    const statements: string[] = [];
    const sql = (async (strings: TemplateStringsArray) => {
      const statement = strings.join("?");
      statements.push(statement);
      return statement.includes("session_apply_running_transition")
        || statement.includes("session_apply_terminal_transition")
        ? [canonicalRow(true)]
        : [];
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

  it("persists the first terminal event id as the canonical receipt", async () => {
    const values: unknown[][] = [];
    const sql = (async (_strings: TemplateStringsArray, ...params: unknown[]) => {
      values.push(params);
      return [canonicalRow(true)];
    }) as EventIngressQuerySql;
    const terminal = effect("terminal_transition");

    await applyEventSessionEffect(sql, {
      nodeId: "node-a",
      eventId: 41,
      envelope: envelope(terminal),
      effect: terminal,
    });

    expect(values[0]).toContain(41);
    expect(values[0]).toContain("done");
  });

  it("marks terminal resumes with their expected canonical receipt", async () => {
    const statements: string[] = [];
    const values: unknown[][] = [];
    const sql = (async (strings: TemplateStringsArray, ...params: unknown[]) => {
      statements.push(strings.join("?"));
      values.push(params);
      return [canonicalRow(true)];
    }) as EventIngressQuerySql;
    const running = {
      ...effect("running_transition"),
      expected_terminal_event_id: 41,
    } as EventSessionEffect;

    await applyEventSessionEffect(sql, {
      nodeId: "node-a",
      eventId: 42,
      envelope: envelope(running),
      effect: running,
    });

    expect(statements[0]).toContain("session_apply_running_transition");
    expect(values[0]).toContain("session-a");
    expect(values[0]).toContain(41);
    expect(values[0]).toContain(true);
  });

  it("returns the canonical terminal row when running receipt CAS is rejected", async () => {
    const sql = (async () => [canonicalRow(false, {
      status: "completed",
      termination_reason: "completed_ok",
      termination_event_id: 41,
    })]) as EventIngressQuerySql;
    const running = {
      ...effect("running_transition"),
      expected_terminal_event_id: 999,
    } as EventSessionEffect;

    await expect(applyEventSessionEffect(sql, {
      nodeId: "node-a",
      eventId: 42,
      envelope: envelope(running),
      effect: running,
    })).resolves.toEqual({
      applied: false,
      canonicalSession: expect.objectContaining({
        status: "completed",
        termination_reason: "completed_ok",
        termination_event_id: 41,
      }),
    });
  });
});

function canonicalRow(
  applied: boolean,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    applied,
    status: "running",
    termination_reason: null,
    termination_detail: null,
    review_state: "not_required",
    last_assistant_text: null,
    termination_event_id: null,
    updated_at: new Date("2026-08-06T00:00:00.000Z"),
    last_event_id: 41,
    ...overrides,
  };
}

function effect(kind: EventSessionEffect["kind"]): EventSessionEffect {
  if (kind === "last_message") return {
    kind,
    last_message: { type: "assistant_message", preview: "done", timestamp: "2026-08-06T00:00:00.000Z" },
    updated_at: "2026-08-06T00:00:00.000Z",
  };
  if (kind === "set_backend_session_id") return { kind, backend_session_id: "thread-1" };
  if (kind === "running_transition") return {
    kind,
    review_state: "not_required",
    updated_at: "2026-08-06T00:00:00.000Z",
  };
  if (kind === "terminal_transition") return {
    kind,
    status: "completed",
    termination_reason: "completed",
    termination_detail: null,
    review_state: "not_required",
    last_assistant_text: "done",
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
