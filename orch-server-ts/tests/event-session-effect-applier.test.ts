import { describe, expect, it } from "vitest";

import { applyEventSessionEffect } from "../src/node/event_session_effect_applier.js";
import type { EventIngressQuerySql } from "../src/node/event_ingress_repository.js";
import type { EventIngressEnvelope, EventSessionEffect } from "../src/node/event_ingress_types.js";

describe("applyEventSessionEffect", () => {
  it.each([
    ["last_message", "session_update_last_message"],
    ["set_backend_session_id", "session_set_claude_id"],
    ["rotate_backend_session_id", "session_rotate_claude_id"],
    ["running_transition", "session_apply_running_transition"],
    ["execution_registration", "session_record_execution_registration"],
    ["execution_acquire", "session_record_execution_registration"],
    ["terminal_transition", "session_apply_terminal_transition"],
    ["append_metadata", "session_apply_metadata_entry"],
  ] as const)("applies %s through its session stored procedure", async (kind, procedure) => {
    const statements: string[] = [];
    const sql = (async (strings: TemplateStringsArray) => {
      const statement = strings.join("?");
      statements.push(statement);
      return statement.includes("session_record_execution_registration")
        ? [canonicalRegistrationRow(true)]
        : statement.includes("session_apply_running_transition")
          || statement.includes("session_apply_terminal_transition")
          ? [canonicalRow(true)]
          : [];
    }) as EventIngressQuerySql;
    const sessionEffect = effect(kind);

    await applyEventSessionEffect(sql, {
      nodeId: "node-a",
      eventId: 41,
      envelope: envelope(sessionEffect),
      effect: sessionEffect,
    });

    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain(procedure);
  });

  it("returns the two-field canonical registration", async () => {
    const sql = Object.assign(async () => [canonicalRegistrationRow(true)], {
      json: (value: unknown) => value,
    }) as unknown as EventIngressQuerySql;
    const registration = effect("execution_registration");

    await expect(applyEventSessionEffect(sql, {
      nodeId: "node-a",
      eventId: 41,
      envelope: envelope(registration),
      effect: registration,
    })).resolves.toMatchObject({
      applied: true,
      canonicalExecutionRegistration: {
        registration_id: "registration-1",
        execution_command_id: "execute-1",
      },
    });
  });

  it("discards the terminal completion projection after a resumed delivery is consumed", async () => {
    const statements: string[] = [];
    const sql = (async (strings: TemplateStringsArray) => {
      const statement = strings.join("?");
      statements.push(statement);
      return statement.includes("session_apply_running_transition")
        ? [canonicalRow(true)]
        : [];
    }) as EventIngressQuerySql;
    const running = {
      ...effect("running_transition"),
      expected_terminal_event_id: 42,
    } as EventSessionEffect;

    await applyEventSessionEffect(sql, {
      nodeId: "node-a",
      eventId: 43,
      envelope: envelope(running),
      effect: running,
    });

    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("session_apply_running_transition");
    expect(statements[1]).toContain("UPDATE session_delivery_notification_outbox");
  });

  it("accepts one-release execution_acquire through the same writer", async () => {
    const statements: string[] = [];
    const sql = (async (strings: TemplateStringsArray) => {
      statements.push(strings.join("?"));
      return [canonicalRegistrationRow(true)];
    }) as EventIngressQuerySql;
    const legacyAcquire = effect("execution_acquire");

    await expect(applyEventSessionEffect(sql, {
      nodeId: "node-a",
      eventId: 41,
      envelope: envelope(legacyAcquire),
      effect: legacyAcquire,
    })).resolves.toMatchObject({
      canonicalExecutionRegistration: {
        registration_id: "registration-1",
        execution_command_id: "execute-1",
      },
      canonicalExecutionOwnership: {
        registration_id: "registration-1",
        execution_command_id: "execute-1",
        phase: "active",
      },
    });
    expect(statements).toEqual([
      expect.stringContaining("session_record_execution_registration"),
    ]);
  });

  it("returns the DB canonical registration when the write is rejected", async () => {
    const sql = Object.assign(async () => [canonicalRegistrationRow(false, {
      execution_registration_id: null,
      execution_command_id: null,
      status: "completed",
      termination_reason: "completed_ok",
      termination_event_id: 40,
    })], { json: (value: unknown) => value }) as unknown as EventIngressQuerySql;
    const registration = effect("execution_registration");

    await expect(applyEventSessionEffect(sql, {
      nodeId: "node-a",
      eventId: 41,
      envelope: envelope(registration),
      effect: registration,
    })).resolves.toMatchObject({
      applied: false,
      canonicalExecutionRegistration: null,
      canonicalSession: { status: "completed", termination_event_id: 40 },
    });
  });

  it("passes the terminal event id and clears canonical registration", async () => {
    const values: unknown[][] = [];
    const sql = (async (_strings: TemplateStringsArray, ...params: unknown[]) => {
      values.push(params);
      return [canonicalRow(true, { status: "completed", termination_event_id: 41 })];
    }) as EventIngressQuerySql;
    const terminal = effect("terminal_transition");

    await expect(applyEventSessionEffect(sql, {
      nodeId: "node-a",
      eventId: 41,
      envelope: envelope(terminal),
      effect: terminal,
    })).resolves.toMatchObject({ canonicalExecutionRegistration: null });
    expect(values[0]).toContain(41);
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

function canonicalRegistrationRow(
  applied: boolean,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...canonicalRow(applied),
    execution_registration_id: "registration-1",
    execution_command_id: "execute-1",
    ...overrides,
  };
}

function effect(kind: EventSessionEffect["kind"]): EventSessionEffect {
  if (kind === "last_message") return {
    kind,
    last_message: {
      type: "assistant_message",
      preview: "done",
      timestamp: "2026-08-06T00:00:00.000Z",
    },
    updated_at: "2026-08-06T00:00:00.000Z",
  };
  if (kind === "set_backend_session_id") return {
    kind,
    backend_session_id: "thread-1",
  };
  if (kind === "rotate_backend_session_id") return {
    kind,
    expected_backend_session_id: "thread-1",
    backend_session_id: "thread-2",
  };
  if (kind === "running_transition") return {
    kind,
    review_state: "not_required",
    updated_at: "2026-08-06T00:00:00.000Z",
  };
  if (kind === "execution_registration") return {
    kind,
    registration_id: "registration-1",
    execution_command_id: "execute-1",
    review_state: "not_required",
    updated_at: "2026-08-06T00:00:00.000Z",
  };
  if (kind === "execution_acquire") return {
    kind,
    owner_kind: "runner_process",
    manifest_id: "release-1",
    runtime_env_identity: "runtime-env-1",
    registration_id: "registration-1",
    pid: 123,
    start_identity: "start-1",
    execution_command_id: "execute-1",
    lease_expires_at: "2026-08-06T00:01:00.000Z",
    review_state: "not_required",
    updated_at: "2026-08-06T00:00:00.000Z",
  };
  if (kind === "terminal_transition") return {
    kind,
    status: "completed",
    termination_reason: "completed_ok",
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
