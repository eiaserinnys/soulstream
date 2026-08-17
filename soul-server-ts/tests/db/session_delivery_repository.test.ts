import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { SessionDeliveryRepository } from "../../../orch-server-ts/src/control_plane/repositories/session_delivery_repository.js";
import { compareRuntimeFollowupCandidates } from "../../../orch-server-ts/src/control_plane/repositories/session_delivery_relation_repository.js";
import type {
  SessionDeliveryRow,
  SqlClient,
} from "../../src/db/session_db_types.js";

type MockCall = { query: string; values: unknown[] };

function deliveryRow(
  overrides: Partial<SessionDeliveryRow> = {},
): SessionDeliveryRow {
  const now = new Date("2026-07-26T00:00:00Z");
  return {
    delivery_id: "00000000-0000-5000-8000-000000000001",
    target_session_id: "caller-1",
    source_session_id: "child-1",
    relation_key: "child:child-1:42",
    completion_id: "child:child-1:42",
    intent: "completion_notification",
    source: "completion_notifier",
    producer_kind: "child_session",
    producer_id: "child-1",
    producer_terminal_revision: "42",
    parent_delivery_id: null,
    caller_turn_id: null,
    payload_hash: "hash-1",
    payload: { text: "done" },
    state: "pending",
    created_at: now,
    updated_at: now,
    claimed_at: null,
    dispatching_at: null,
    queued_at: null,
    delivered_at: null,
    consumed_at: null,
    superseded_at: null,
    superseded_terminal_revision: null,
    ...overrides,
  };
}

function createMockSql(results: unknown[][]) {
  const calls: MockCall[] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ query: Array.from(strings).join("?"), values });
    return Promise.resolve(results.shift() ?? []);
  }) as unknown as SqlClient & {
    json(value: unknown): unknown;
  };
  sql.json = vi.fn((value: unknown) => value);
  sql.begin = vi.fn(async (callback: (transaction: typeof sql) => unknown) =>
    await callback(sql)) as never;
  return { sql, calls };
}

const registration = {
  deliveryId: "00000000-0000-5000-8000-000000000001",
  targetSessionId: "caller-1",
  sourceSessionId: "child-1",
  relationKey: "child:child-1:42",
  completionId: "child:child-1:42",
  intent: "completion_notification" as const,
  source: "completion_notifier",
  producerKind: "child_session",
  producerId: "child-1",
  producerTerminalRevision: "42",
  payloadHash: "hash-1",
  payload: { text: "done" },
  createdAt: new Date("2026-07-26T00:00:00Z"),
};

describe("SessionDeliveryRepository", () => {
  it("orders runtime follow-ups by attempt, createdAt, then enqueue sequence", () => {
    expect(compareRuntimeFollowupCandidates(
      { followupAttempt: 2, createdAt: new Date("2026-08-18T00:00:00Z"), enqueueSequence: 1n },
      { followupAttempt: 1, createdAt: new Date("2026-08-18T01:00:00Z"), enqueueSequence: 2n },
    )).toBeGreaterThan(0);
    expect(compareRuntimeFollowupCandidates(
      { followupAttempt: 2, createdAt: new Date("2026-08-18T02:00:00Z"), enqueueSequence: 1n },
      { followupAttempt: 2, createdAt: new Date("2026-08-18T01:00:00Z"), enqueueSequence: 2n },
    )).toBeGreaterThan(0);
    expect(compareRuntimeFollowupCandidates(
      { followupAttempt: 2, createdAt: new Date("2026-08-18T02:00:00Z"), enqueueSequence: 3n },
      { followupAttempt: 2, createdAt: new Date("2026-08-18T02:00:00Z"), enqueueSequence: 2n },
    )).toBeGreaterThan(0);
  });

  it("atomically supersedes only older pending runtime follow-ups", async () => {
    const createdAt = new Date("2026-08-18T02:00:00Z");
    const candidate = deliveryRow({
      delivery_id: "00000000-0000-5000-8000-000000000020",
      relation_key: "runtime:fallback:2",
      completion_id: "runtime:fallback:2",
      intent: "runtime_followup",
      source: "claude_runtime_task_followup",
      payload_hash: "runtime-hash-2",
      payload: { followup_key: "session:task", followup_attempt: 2 },
      created_at: createdAt,
      updated_at: createdAt,
    });
    const older = deliveryRow({
      delivery_id: "00000000-0000-5000-8000-000000000010",
      relation_key: "runtime:fallback:1",
      completion_id: "runtime:fallback:1",
      intent: "runtime_followup",
      source: "claude_runtime_task_followup",
      payload: { followup_key: "session:task", followup_attempt: 1 },
      created_at: new Date("2026-08-18T01:00:00Z"),
    });
    const { sql, calls } = createMockSql([[], [], [older], [candidate], []]);

    await expect(new SessionDeliveryRepository(sql).register({
      deliveryId: candidate.delivery_id,
      targetSessionId: "caller-1",
      relationKey: candidate.relation_key,
      completionId: candidate.completion_id,
      intent: "runtime_followup",
      source: candidate.source,
      payloadHash: candidate.payload_hash,
      payload: candidate.payload,
      createdAt,
    })).resolves.toEqual({ row: candidate, inserted: true, conflict: false });

    expect(calls[0].query).toContain("pg_advisory_xact_lock");
    expect(calls[2].query).toContain("state = 'pending'");
    expect(calls[2].query).toContain("followup_attempt");
    expect(calls[4].query).toContain("state = 'superseded'");
    expect(calls[4].query).toContain("state = 'pending'");
  });
  it("registers a new delivery with an atomic conflict boundary", async () => {
    const row = deliveryRow();
    const { sql, calls } = createMockSql([[row]]);

    const result = await new SessionDeliveryRepository(sql).register(registration);

    expect(result).toEqual({ row, inserted: true, conflict: false });
    expect(calls[0].query).toContain("INSERT INTO session_deliveries");
    expect(calls[0].query).toContain("ON CONFLICT DO NOTHING");
  });

  it("converges an identical retry on the existing ledger row", async () => {
    const row = deliveryRow();
    const { sql, calls } = createMockSql([[], [row]]);

    const result = await new SessionDeliveryRepository(sql).register(registration);

    expect(result).toEqual({ row, inserted: false, conflict: false });
    expect(calls).toHaveLength(2);
    expect(calls[1].query).toContain("relation_key");
  });

  it("marks payload/relation identity conflicts uncertain instead of dispatching", async () => {
    const conflicting = deliveryRow({ payload_hash: "other-hash" });
    const uncertain = deliveryRow({ payload_hash: "other-hash", state: "uncertain" });
    const { sql, calls } = createMockSql([[], [conflicting], [uncertain]]);

    const result = await new SessionDeliveryRepository(sql).register(registration);

    expect(result).toEqual({ row: uncertain, inserted: false, conflict: true });
    expect(calls[2].query).toContain("state = 'uncertain'");
  });

  it("preserves a superseded audit row when a conflicting retry arrives", async () => {
    const superseded = deliveryRow({
      payload_hash: "other-hash",
      state: "superseded",
      superseded_terminal_revision: "42",
    });
    const { sql, calls } = createMockSql([[], [superseded], []]);

    const result = await new SessionDeliveryRepository(sql).register(registration);

    expect(result).toEqual({ row: superseded, inserted: false, conflict: true });
    expect(calls[2].query).toContain("state NOT IN ('consumed', 'superseded')");
  });

  it("defers retargeting until the atomic claim boundary", async () => {
    const original = deliveryRow({ target_session_id: "caller-original" });
    const { sql, calls } = createMockSql([[], [original]]);

    const result = await new SessionDeliveryRepository(sql).register({
      ...registration,
      targetSessionId: "caller-replacement",
    });

    expect(result).toEqual({ row: original, inserted: false, conflict: false });
    expect(calls).toHaveLength(2);
  });

  it("retargets and claims a pending delivery in one atomic update", async () => {
    const claimed = deliveryRow({
      target_session_id: "caller-replacement",
      state: "claimed",
    });
    const { sql, calls } = createMockSql([[claimed]]);
    const repository = new SessionDeliveryRepository(sql);

    await expect(repository.claimForTarget(
      claimed.delivery_id,
      "caller-replacement",
    )).resolves.toEqual(claimed);

    expect(calls[0].query).toContain("target_session_id");
    expect(calls[0].query).toContain("state = 'claimed'");
    expect(calls[0].query).toContain("state = 'pending'");
  });

  it("uses claimed to dispatching as the exclusive dispatch CAS", async () => {
    const dispatching = deliveryRow({ state: "dispatching" });
    const { sql, calls } = createMockSql([[dispatching]]);
    const repository = new SessionDeliveryRepository(sql);

    await expect(repository.beginDispatch(dispatching.delivery_id))
      .resolves.toEqual(dispatching);

    expect(calls[0].query).toContain("state = 'dispatching'");
    expect(calls[0].query).toContain("state = 'claimed'");
    expect(calls[0].query).toContain("termination_event_id::text");
    expect(calls[0].query).toContain("producer_terminal_revision");
  });

  it("keeps the original target once a semantic completion has already been queued", async () => {
    const queued = deliveryRow({
      target_session_id: "caller-original",
      state: "queued",
    });
    const { sql, calls } = createMockSql([[], [queued]]);

    const result = await new SessionDeliveryRepository(sql).register({
      ...registration,
      targetSessionId: "caller-replacement",
    });

    expect(result).toEqual({ row: queued, inserted: false, conflict: false });
    expect(calls).toHaveLength(2);
  });

  it("claims only pending rows and records explicit queued/delivered/consumed edges", async () => {
    const row = deliveryRow();
    const { sql, calls } = createMockSql([
      [{ ...row, state: "claimed" }],
      [{ ...row, state: "dispatching" }],
      [{ ...row, state: "queued" }],
      [{ ...row, state: "delivered", caller_turn_id: "turn-9" }],
      [{ ...row, state: "consumed", caller_turn_id: "turn-9" }],
    ]);
    const repository = new SessionDeliveryRepository(sql);

    await repository.claim(row.delivery_id);
    await repository.beginDispatch(row.delivery_id);
    await repository.markQueued(row.delivery_id);
    await repository.markDelivered(row.delivery_id, "turn-9");
    await repository.markConsumed(row.delivery_id, "turn-9");

    expect(calls[0].query).toContain("state = 'pending'");
    expect(calls[1].query).toContain("state = 'claimed'");
    expect(calls[2].query).toContain("'dispatching'");
    expect(calls[3].query).toContain("'dispatching'");
    expect(calls[4].query).toContain("'consumed'");
  });

  it("marks consumed by relation and completion identity", async () => {
    const consumed = deliveryRow({ state: "consumed", caller_turn_id: "turn-inline" });
    const { sql, calls } = createMockSql([[consumed]]);
    const repository = new SessionDeliveryRepository(sql);

    await expect(repository.markConsumedByRelation(
      consumed.relation_key,
      consumed.completion_id!,
      "turn-inline",
    )).resolves.toEqual(consumed);

    expect(calls[0].query).toContain("relation_key");
    expect(calls[0].query).toContain("completion_id");
    expect(calls[0].query).toContain("state = 'consumed'");
    expect(calls[0].query).toContain("'pending', 'claimed'");
    expect(calls[0].query).not.toContain("'queued'");
    expect(calls[0].query).not.toContain("'delivered'");
  });

  it("supersedes only a pending delivery", async () => {
    const superseded = deliveryRow({ state: "superseded" });
    const { sql, calls } = createMockSql([[superseded]]);
    const repository = new SessionDeliveryRepository(sql);

    await expect(repository.markPendingSuperseded(
      superseded.delivery_id,
      "user_message",
    )).resolves.toEqual(superseded);

    expect(calls[0].query).toContain("state = 'superseded'");
    expect(calls[0].query).toContain("state = 'pending'");
    expect(calls[0].values).toContain("user_message");
  });
});

describe("session_deliveries migration safety", () => {
  it("keeps promoted additive migrations aligned with canonical fresh-install schema", () => {
    const manifest = readFileSync(
      new URL("../../../packages/db-schema/migration-manifest.json", import.meta.url),
      "utf8",
    );
    const deliveryMigration = readFileSync(
      new URL(
        "../../../packages/db-schema/sql/migrations/045_session_deliveries.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const backgroundMigration = readFileSync(
      new URL(
        "../../../packages/db-schema/sql/migrations/046_claude_background_tasks.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const relationConsumptionMigration = readFileSync(
      new URL(
        "../../../packages/db-schema/sql/migrations/047_session_delivery_relation_consumptions.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const retirementMigration = readFileSync(
      new URL(
        "../../../packages/db-schema/sql/migrations/053_retire_supervisor.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const terminalRevisionMigration = readFileSync(
      new URL(
        "../../../packages/db-schema/sql/migrations/065_completion_terminal_revision_fence.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const enqueueSequenceMigration = readFileSync(
      new URL(
        "../../../packages/db-schema/sql/migrations/066_session_delivery_enqueue_sequence.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const schema = readFileSync(
      new URL("../../../packages/db-schema/sql/schema.sql", import.meta.url),
      "utf8",
    );
    const removedEpochMigration = new URL(
      "../../../packages/db-schema/sql/pending/044_supervisor_registry_epoch_monotonic.sql",
      import.meta.url,
    );

    expect(manifest).toContain("045_session_deliveries.sql");
    expect(manifest).toContain("046_claude_background_tasks.sql");
    expect(manifest).toContain(
      "047_session_delivery_relation_consumptions.sql",
    );
    expect(manifest).toContain("053_retire_supervisor.sql");
    expect(manifest).toContain("065_completion_terminal_revision_fence.sql");
    expect(manifest).toContain("066_session_delivery_enqueue_sequence.sql");
    expect(existsSync(removedEpochMigration)).toBe(false);
    expect(deliveryMigration).toContain("CREATE TABLE IF NOT EXISTS session_deliveries");
    expect(deliveryMigration).toContain("ON DELETE SET NULL");
    expect(deliveryMigration).toContain("ALTER COLUMN target_session_id DROP NOT NULL");
    expect(deliveryMigration).toContain("ADD COLUMN IF NOT EXISTS supervisor_role TEXT");
    expect(deliveryMigration).toContain("ADD COLUMN IF NOT EXISTS dispatching_at TIMESTAMPTZ");
    expect(deliveryMigration).toContain("DROP CONSTRAINT IF EXISTS session_deliveries_state_check");
    expect(deliveryMigration).toContain("'dispatching'");
    expect(deliveryMigration).toContain("CREATE TABLE IF NOT EXISTS session_delivery_notification_outbox");
    expect(deliveryMigration).not.toContain("supervisor_epoch");
    expect(backgroundMigration).toContain(
      "CREATE TABLE IF NOT EXISTS claude_background_tasks",
    );
    expect(backgroundMigration).not.toContain(
      "REFERENCES sessions(session_id)",
    );
    expect(relationConsumptionMigration).toContain(
      "CREATE TABLE IF NOT EXISTS session_delivery_relation_consumptions",
    );
    expect(relationConsumptionMigration).not.toContain("REFERENCES sessions");
    expect(retirementMigration).toContain(
      "DELETE FROM session_deliveries\nWHERE supervisor_role IS NOT NULL",
    );
    expect(retirementMigration).toContain("DROP COLUMN IF EXISTS supervisor_role");
    expect(retirementMigration).toContain("DROP TABLE IF EXISTS supervisor_registry");
    expect(retirementMigration).toContain(
      "DROP FUNCTION IF EXISTS supervisor_event_append",
    );
    expect(schema).toContain(
      "CREATE TABLE IF NOT EXISTS claude_background_tasks",
    );
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS session_deliveries");
    for (const sql of [enqueueSequenceMigration, schema]) {
      expect(sql).toContain(
        "enqueue_sequence BIGINT GENERATED ALWAYS AS IDENTITY",
      );
      expect(sql).toContain(
        "idx_session_deliveries_runtime_followup_latest",
      );
    }
    expect(schema).toContain(
      "CREATE TABLE IF NOT EXISTS session_delivery_relation_consumptions",
    );
    expect(schema).not.toContain("supervisor_role");
    expect(schema).toContain("ADD COLUMN IF NOT EXISTS dispatching_at TIMESTAMPTZ");
    expect(schema).toContain("DROP CONSTRAINT IF EXISTS session_deliveries_state_check");
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS session_delivery_notification_outbox");
    expect(schema).not.toContain("supervisor_");
    for (const sql of [terminalRevisionMigration, schema]) {
      expect(sql).toContain("'superseded'");
      expect(sql).toContain("superseded_at TIMESTAMPTZ");
      expect(sql).toContain("superseded_terminal_revision TEXT");
      expect(sql).toContain("producer_terminal_revision = p_expected_terminal_event_id::text");
      expect(sql).toContain("state IN ('pending', 'claimed', 'dispatching')");
    }
  });
});
