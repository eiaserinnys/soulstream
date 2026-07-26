import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { SessionDeliveryRepository } from "../../src/db/repositories/session_delivery_repository.js";
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
    supervisor_role: null,
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

  it("resolves and claims the current supervisor in one atomic statement", async () => {
    const claimed = deliveryRow({
      target_session_id: "supervisor-current",
      supervisor_role: "ariella",
      state: "claimed",
    });
    const { sql, calls } = createMockSql([
      [deliveryRow({ supervisor_role: "ariella" })],
      [{ active_session_id: "supervisor-current" }],
      [claimed],
    ]);
    const repository = new SessionDeliveryRepository(sql);

    await expect(repository.claimForCurrentSupervisor(
      claimed.delivery_id,
      "ariella",
    )).resolves.toEqual(claimed);

    expect(calls[0].query).toContain("FOR UPDATE");
    expect(calls[1].query).toContain("FROM supervisor_registry AS registry");
    expect(calls[1].query).toContain("registry.active_session_id");
    expect(calls[2].query).toContain("state = 'pending'");
  });

  it("uses claimed to dispatching as the exclusive dispatch CAS", async () => {
    const dispatching = deliveryRow({ state: "dispatching" });
    const { sql, calls } = createMockSql([[dispatching]]);
    const repository = new SessionDeliveryRepository(sql);

    await expect(repository.beginDispatch(dispatching.delivery_id))
      .resolves.toEqual(dispatching);

    expect(calls[0].query).toContain("state = 'dispatching'");
    expect(calls[0].query).toContain("state = 'claimed'");
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
});

describe("session_deliveries migration safety", () => {
  it("keeps the additive migration outside the deployment manifest until operator approval", () => {
    const manifest = readFileSync(
      new URL("../../../packages/db-schema/migration-manifest.json", import.meta.url),
      "utf8",
    );
    const pending = readFileSync(
      new URL(
        "../../../packages/db-schema/sql/pending/043_session_deliveries.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const backgroundPending = readFileSync(
      new URL(
        "../../../packages/db-schema/sql/pending/045_claude_background_tasks.sql",
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

    expect(manifest).not.toContain("043_session_deliveries.sql");
    expect(manifest).not.toContain("045_claude_background_tasks.sql");
    expect(existsSync(removedEpochMigration)).toBe(false);
    expect(pending).toContain("CREATE TABLE IF NOT EXISTS session_deliveries");
    expect(pending).toContain("ON DELETE SET NULL");
    expect(pending).toContain("ALTER COLUMN target_session_id DROP NOT NULL");
    expect(pending).toContain("ADD COLUMN IF NOT EXISTS supervisor_role TEXT");
    expect(pending).toContain("ADD COLUMN IF NOT EXISTS dispatching_at TIMESTAMPTZ");
    expect(pending).toContain("DROP CONSTRAINT IF EXISTS session_deliveries_state_check");
    expect(pending).toContain("'dispatching'");
    expect(pending).toContain("CREATE TABLE IF NOT EXISTS session_delivery_notification_outbox");
    expect(pending).not.toContain("supervisor_epoch");
    expect(backgroundPending).toContain(
      "CREATE TABLE IF NOT EXISTS claude_background_tasks",
    );
    expect(backgroundPending).not.toContain(
      "REFERENCES sessions(session_id)",
    );
    expect(schema).not.toContain(
      "CREATE TABLE IF NOT EXISTS claude_background_tasks",
    );
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS session_deliveries");
    expect(schema).toContain("ADD COLUMN IF NOT EXISTS supervisor_role TEXT");
    expect(schema).toContain("ADD COLUMN IF NOT EXISTS dispatching_at TIMESTAMPTZ");
    expect(schema).toContain("DROP CONSTRAINT IF EXISTS session_deliveries_state_check");
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS session_delivery_notification_outbox");
    expect(schema).not.toContain("supervisor_epoch");
    const supervisorUpsert = schema.slice(
      schema.indexOf("CREATE OR REPLACE FUNCTION supervisor_registry_upsert("),
      schema.indexOf("CREATE OR REPLACE FUNCTION supervisor_registry_get("),
    );
    expect(supervisorUpsert).not.toContain("supervisor target change requires epoch increase");
    expect(supervisorUpsert).not.toContain("pg_advisory_xact_lock");
  });
});
