import { describe, expect, it, vi } from "vitest";

import { applyEventSessionEffect } from "../src/node/event_session_effect_applier.js";
import type { EventIngressQuerySql } from "../src/node/event_ingress_repository.js";
import type { EventIngressEnvelope, EventSessionEffect } from "../src/node/event_ingress_types.js";

describe("applyEventSessionEffect", () => {
  it.each([
    ["last_message", "session_update_last_message"],
    ["set_backend_session_id", "session_set_claude_id"],
    ["rotate_backend_session_id", "session_rotate_claude_id"],
    ["running_transition", "session_apply_running_transition"],
    ["execution_reserve", "session_reserve_execution_ownership"],
    ["execution_prove", "session_prove_execution_ownership"],
    ["execution_adopt_reserve", "session_reserve_execution_adoption"],
    ["execution_activate", "session_activate_execution_ownership"],
    ["execution_fail", "session_fail_execution_ownership"],
    ["execution_expire_dead_owner", "session_expire_dead_execution_owner"],
    ["execution_orphaned_spawn", "session_mark_execution_orphaned_spawn"],
    ["execution_backfill", "session_backfill_execution_ownership"],
    ["runner_terminal_fact", "session_project_runner_terminal_fact"],
    ["recovered_runner_terminal_fact", "session_project_recovered_runner_terminal_fact"],
    ["terminal_transition", "session_apply_terminal_transition"],
    ["append_metadata", "session_apply_metadata_entry"],
  ] as const)("applies %s through its session stored procedure", async (kind, procedure) => {
    const statements: string[] = [];
    const sql = (async (strings: TemplateStringsArray) => {
      const statement = strings.join("?");
      statements.push(statement);
      if (statement.includes("FROM session_execution_ownerships")) {
        return [canonicalOwnershipRow()];
      }
      return statement.includes("session_apply_running_transition")
        || statement.includes("session_apply_terminal_transition")
        || statement.includes("execution_ownership")
        || statement.includes("expire_dead_execution_owner")
        || statement.includes("execution_adoption")
        || statement.includes("execution_orphaned_spawn")
        || statement.includes("runner_terminal_fact")
        ? [canonicalRow(true)]
        : [];
    }) as EventIngressQuerySql;

    await applyEventSessionEffect(sql, {
      nodeId: "node-a",
      eventId: 41,
      envelope: envelope(effect(kind)),
      effect: effect(kind),
    });

    const ownershipEffect = kind.startsWith("execution_")
      && kind !== "execution_backfill";
    expect(statements).toHaveLength(ownershipEffect ? 2 : 1);
    expect(statements[0]).toContain(procedure);
    if (
      kind !== "execution_prove"
      && kind !== "execution_fail"
      && kind !== "execution_expire_dead_owner"
      && kind !== "execution_orphaned_spawn"
      && kind !== "execution_backfill"
    ) {
      expect(statements[0]).not.toContain("last_event_id");
    }
  });

  it.each([
    ["execution_reserve", "session_reserve_execution_ownership_v2"],
    ["execution_adopt_reserve", "session_reserve_execution_adoption_v2"],
    ["execution_backfill", "session_backfill_execution_ownership_v2"],
  ] as const)("routes %s with runtime identity through the v2 procedure", async (kind, procedure) => {
    const statements: string[] = [];
    const values: unknown[][] = [];
    const sql = (async (strings: TemplateStringsArray, ...params: unknown[]) => {
      const statement = strings.join("?");
      statements.push(statement);
      values.push(params);
      if (statement.includes("FROM session_execution_ownerships")) {
        return [canonicalOwnershipRow({ runtime_env_identity: "runtime-env-1" })];
      }
      return [canonicalRow(true)];
    }) as EventIngressQuerySql;
    const legacy = effect(kind);
    const releaseEffect = kind === "execution_backfill"
      ? {
          ...legacy,
          first_runtime_env_identity: "runtime-env-1",
          second_runtime_env_identity: "runtime-env-1",
        }
      : { ...legacy, runtime_env_identity: "runtime-env-1" };

    const result = await applyEventSessionEffect(sql, {
      nodeId: "node-a",
      eventId: 41,
      envelope: envelope(releaseEffect),
      effect: releaseEffect,
    });

    expect(statements[0]).toContain(procedure);
    expect(values[0]).toContain("runtime-env-1");
    if (kind !== "execution_backfill") {
      expect(result.canonicalExecutionOwnership).toMatchObject({
        runtime_env_identity: "runtime-env-1",
      });
    }
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
    const sql = Object.assign(async () => [canonicalRow(false, {
      status: "completed",
      termination_reason: "completed_ok",
      termination_event_id: 41,
    })], { json: (value: unknown) => value }) as unknown as EventIngressQuerySql;
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

  it("returns the canonical owner when an execution generation CAS is idempotently rejected", async () => {
    const sql = (async (strings: TemplateStringsArray) => {
      const statement = strings.join("?");
      return statement.includes("FROM session_execution_ownerships")
        ? [canonicalOwnershipRow({ phase: "active" })]
        : [canonicalRow(false)];
    }) as EventIngressQuerySql;
    const activation = effect("execution_activate");

    await expect(applyEventSessionEffect(sql, {
      nodeId: "node-a",
      eventId: 42,
      envelope: envelope(activation),
      effect: activation,
    })).resolves.toMatchObject({
      applied: false,
      canonicalExecutionOwnership: {
        ownership_generation: 1,
        owner_kind: "runner_process",
        manifest_id: "release-1",
        phase: "active",
      },
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

function canonicalOwnershipRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ownership_generation: 1,
    owner_kind: "runner_process",
    manifest_id: "release-1",
    runtime_env_identity: null,
    registration_id: "registration-1",
    pid: 123,
    start_identity: "start-1",
    execution_command_id: "execute-1",
    phase: "active",
    failure_reason: null,
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
  if (kind === "execution_reserve") return {
    kind,
    ownership_generation: 1,
    owner_kind: "runner_process",
    manifest_id: "release-1",
    updated_at: "2026-08-06T00:00:00.000Z",
  };
  if (kind === "execution_adopt_reserve") return {
    kind,
    ownership_generation: 2,
    manifest_id: "release-1",
    previous_registration_id: "registration-1",
    pid: 123,
    start_identity: "start-1",
    execution_command_id: "execute-1",
    updated_at: "2026-08-06T00:00:00.000Z",
  };
  if (kind === "execution_prove") return {
    kind,
    ownership_generation: 1,
    registration_id: "registration-1",
    pid: 123,
    start_identity: "start-1",
    execution_command_id: "execute-1",
    updated_at: "2026-08-06T00:00:00.000Z",
  };
  if (kind === "execution_activate") return {
    kind,
    ownership_generation: 1,
    review_state: "not_required",
    updated_at: "2026-08-06T00:00:00.000Z",
  };
  if (kind === "execution_fail") return {
    kind,
    ownership_generation: 1,
    failure_reason: "spawn failed",
    updated_at: "2026-08-06T00:00:00.000Z",
  };
  if (kind === "execution_expire_dead_owner") return {
    kind,
    ownership_generation: 1,
    pid: 123,
    start_identity: "start-1",
    failure_reason: "owner process is gone",
    updated_at: "2026-08-06T00:00:00.000Z",
  };
  if (kind === "execution_orphaned_spawn") return {
    kind,
    ownership_generation: 1,
    registration_id: "registration-1",
    pid: 123,
    start_identity: "start-1",
    execution_command_id: "execute-1",
    updated_at: "2026-08-06T00:00:00.000Z",
  };
  if (kind === "execution_backfill") return {
    kind,
    first_manifest_id: "release-1",
    first_registration_id: "registration-1",
    first_pid: 123,
    first_start_identity: "start-1",
    first_execution_command_id: "execute-1",
    first_observed_at: "2026-08-06T00:00:00.000Z",
    second_manifest_id: "release-1",
    second_registration_id: "registration-1",
    second_pid: 123,
    second_start_identity: "start-1",
    second_execution_command_id: "execute-1",
    second_observed_at: "2026-08-06T00:00:15.000Z",
    evidence_hash: "a".repeat(64),
    minimum_lease_interval_ms: 15_000,
    probe_only: false,
    updated_at: "2026-08-06T00:00:15.000Z",
  };
  if (kind === "runner_terminal_fact") return {
    kind,
    ownership_generation: 1,
    execution_command_id: "execute-1",
    runner_fact: "completed",
    termination_detail: null,
    review_state: "not_required",
    last_assistant_text: "done",
    updated_at: "2026-08-06T00:00:00.000Z",
  };
  if (kind === "recovered_runner_terminal_fact") return {
    kind,
    manifest_id: "release-1",
    registration_id: "registration-1",
    pid: 123,
    start_identity: "start-1",
    execution_command_id: "execute-1",
    runner_fact: "reaped",
    termination_detail: "runner exited",
    review_state: "not_required",
    last_assistant_text: null,
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
