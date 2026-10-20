import { spawnSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

import {
  createCanonicalSessionStatisticsFacts,
} from "../src/usage/session_statistics_canonical_sql.js";
import {
  backfillSessionStatisticsProjection,
  SESSION_STATISTICS_PROJECTION_SETTING_KEY,
} from "../src/usage/session_statistics_backfill.js";
import {
  applySessionStatisticsProjection,
  insertSessionStatisticsFacts,
} from "../src/usage/session_statistics_projection.js";
import {
  normalizeSessionStatisticsEvent,
  selectCanonicalInputMaterialFacts,
  selectCanonicalUsageCandidates,
  type FactDraft,
  type SessionStatisticsEventInput,
} from "../src/usage/session_statistics_normalizer.js";
import type { EventIngressQuerySql, EventIngressSql } from "../src/node/event_ingress_repository.js";
import type { EventIngressEnvelope } from "../src/node/event_ingress_types.js";
import {
  canonicalOwnershipEvents,
  claudeModelBreakdownEvents,
  keylessSystemMaterialEvents,
  unverifiedClaudeModelBreakdownEvent,
} from "./fixtures/session_statistics_normalizer.fixtures.js";
import {
  createFullSchemaPostgresHarness,
  type FullSchemaPostgresHarness,
} from "./board_yjs_postgres_harness.js";

const hasDocker = spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
const hasTestDatabase = Boolean(process.env.TEST_DATABASE_URL?.trim());
const describePostgres = hasDocker || hasTestDatabase ? describe : describe.skip;

describePostgres("session statistics facts projection", () => {
  let harness: FullSchemaPostgresHarness;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
    sql = harness.sql;
  }, 60_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  it("resumes a cutoff keyset backfill, tolerates live overlap, and matches the pure selectors", async () => {
    const backfillSession = "statistics-projection-backfill";
    const sourceEvents: SessionStatisticsEventInput[] = [
      {
        sessionId: backfillSession,
        eventId: 1_000_001,
        eventType: "user_message",
        createdAt: "2026-10-19T00:00:00.000Z",
        payload: { type: "user_message", input_id: "input-a", text: "safe prompt" },
      },
      {
        sessionId: backfillSession,
        eventId: 1_000_002,
        eventType: "result",
        createdAt: "2026-10-19T00:00:01.000Z",
        payload: {
          type: "result",
          success: true,
          output_command_id: "pending-command",
          input_id: "input-a",
          usage_snapshot: usageSnapshot(),
          usage: { input_tokens: 12, output_tokens: 2 },
        },
      },
      {
        sessionId: backfillSession,
        eventId: 1_000_003,
        eventType: "session_ended",
        createdAt: "2026-10-19T00:00:02.000Z",
        payload: { type: "session_ended" },
      },
    ];
    await seedSourceEvents(sql, sourceEvents);
    const expectedBackfillFacts = sourceEvents.flatMap((event) => normalizeSessionStatisticsEvent(event).facts);

    const first = await backfillSessionStatisticsProjection(sql as unknown as EventIngressSql, { batchSize: 1 });
    expect(first).toMatchObject({
      state: "backfilling",
      backfill_cutoff_event_id: 1_000_003,
      last_session_id: backfillSession,
      last_event_id: 1_000_001,
    });

    const eventTwo = sourceEvents[1]!;
    await sql.begin(async (transaction) => {
      await applySessionStatisticsProjection(transaction as unknown as EventIngressQuerySql, {
        eventId: Number(eventTwo.eventId),
        envelope: asEnvelope(eventTwo),
      });
    });
    const pendingBeforeBoundary = await sql.begin(async (transaction) => createCanonicalSessionStatisticsFacts(
      transaction as unknown as EventIngressQuerySql,
      [backfillSession],
    ));
    expect(pendingBeforeBoundary.some((row) => row.row_kind === "usage"
      && String(row.candidate_event_id) === "1000002"
      && row.state === "pending"
      && row.fact === null)).toBe(true);

    const lateLiveEvent = zeroUsageEvent(backfillSession, 1_000_004, "live-command");
    await seedSourceEvents(sql, [lateLiveEvent]);
    await sql.begin(async (transaction) => {
      await applySessionStatisticsProjection(transaction as unknown as EventIngressQuerySql, {
        eventId: Number(lateLiveEvent.eventId),
        envelope: asEnvelope(lateLiveEvent),
      });
    });

    const second = await backfillSessionStatisticsProjection(sql as unknown as EventIngressSql, { batchSize: 1 });
    expect(second).toMatchObject({ state: "backfilling", last_event_id: 1_000_002 });
    const third = await backfillSessionStatisticsProjection(sql as unknown as EventIngressSql, { batchSize: 1 });
    expect(third).toMatchObject({ state: "backfilling", last_event_id: 1_000_003 });
    const finished = await backfillSessionStatisticsProjection(sql as unknown as EventIngressSql, { batchSize: 1 });
    expect(finished).toMatchObject({
      state: "ready",
      backfill_cutoff_event_id: 1_000_003,
      last_event_id: 1_000_003,
      covered_since: "2026-10-19T00:00:00.000Z",
    });

    const finalRows = await sql.begin(async (transaction) => createCanonicalSessionStatisticsFacts(
      transaction as unknown as EventIngressQuerySql,
      [backfillSession],
    ));
    expect(finalRows.some((row) => row.row_kind === "usage"
      && String(row.candidate_event_id) === "1000002"
      && row.state === "missing"
      && row.fact === null)).toBe(true);
    expect(finalRows.some((row) => row.row_kind === "usage"
      && String(row.owner_event_id) === "1000004"
      && row.state === "owned"
      && row.fact?.input_total === 0
      && row.fact.output_total === 0
      && row.fact.total_tokens === 0)).toBe(true);
    const [eventTwoCount] = await sql<readonly { count: number }[]>`
      SELECT count(*)::int AS count
      FROM session_statistics_facts
      WHERE session_id = ${backfillSession} AND event_id = 1_000_002
    `;
    expect(eventTwoCount?.count).toBe(expectedBackfillFacts.filter((fact) => fact.event_id === 1_000_002).length);
    const [checkpoint] = await sql<readonly { version: number; value: Record<string, unknown> }[]>`
      SELECT version, value FROM system_settings
      WHERE setting_key = ${SESSION_STATISTICS_PROJECTION_SETTING_KEY}
    `;
    expect(checkpoint?.value).toMatchObject({ state: "ready", backfill_cutoff_event_id: 1_000_003 });
    const staleCas = await sql<readonly { version: number }[]>`
      UPDATE system_settings
      SET value = ${sql.json({ state: "backfilling" })}, version = version + 1
      WHERE setting_key = ${SESSION_STATISTICS_PROJECTION_SETTING_KEY}
        AND version = ${Number(checkpoint?.version) - 1}
      RETURNING version
    `;
    expect(staleCas).toEqual([]);

    const malformed = {
      sessionId: backfillSession,
      eventId: 1_000_005,
      eventType: "complete",
      createdAt: "2026-10-19T00:00:04.000Z",
      payload: { type: "complete", output_command_id: "malformed-command", usage: "unknown-shape" },
    } satisfies SessionStatisticsEventInput;
    await seedSourceEvents(sql, [malformed]);
    await sql.begin(async (transaction) => {
      await applySessionStatisticsProjection(transaction as unknown as EventIngressQuerySql, {
        eventId: Number(malformed.eventId),
        envelope: asEnvelope(malformed),
      });
      await transaction`
        INSERT INTO event_ingress_receipts (
          node_id, stream_id, source_seq, session_id, payload_hash, event_id
        ) VALUES (
          'projection-test', '018f47b7-c6de-7d64-9c8d-0b62cbbb2e10', 5,
          ${backfillSession}, ${"a".repeat(64)}, 1_000_005
        )
      `;
    });
    const [malformedFact] = await sql<readonly { input_total: number | null; quality: string[] }[]>`
      SELECT input_total, quality FROM session_statistics_facts
      WHERE session_id = ${backfillSession} AND event_id = 1_000_005 AND fact_kind = 'usage'
    `;
    expect(malformedFact).toMatchObject({ input_total: null, quality: expect.arrayContaining(["normalization_error"]) });

    const rollback = async () => await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO events (session_id, id, event_type, payload, created_at)
        VALUES (
          ${backfillSession}, 1_000_006, 'complete',
          ${transaction.json({ type: "complete", output_command_id: "rollback-command", usage: { input_tokens: 1, output_tokens: 1 } })}::jsonb,
          '2026-10-19T00:00:05.000Z'
        )
      `;
      const rolledBackEvent: SessionStatisticsEventInput = {
        sessionId: backfillSession,
        eventId: 1_000_006,
        eventType: "complete",
        createdAt: "2026-10-19T00:00:05.000Z",
        payload: { type: "complete", output_command_id: "rollback-command", usage: { input_tokens: 1, output_tokens: 1 } },
      };
      await applySessionStatisticsProjection(transaction as unknown as EventIngressQuerySql, {
        eventId: 1_000_006,
        envelope: asEnvelope(rolledBackEvent),
      });
      await transaction`
        INSERT INTO event_ingress_receipts (
          node_id, stream_id, source_seq, session_id, payload_hash, event_id
        ) VALUES (
          'projection-test', '018f47b7-c6de-7d64-9c8d-0b62cbbb2e10', 6,
          ${backfillSession}, ${"b".repeat(64)}, 1_000_006
        )
      `;
      throw new Error("rollback projection test transaction");
    });
    await expect(rollback()).rejects.toThrow("rollback projection test transaction");
    const [rollbackCounts] = await sql<readonly { events: number; facts: number; receipts: number }[]>`
      SELECT
        (SELECT count(*)::int FROM events WHERE session_id = ${backfillSession} AND id = 1_000_006) AS events,
        (SELECT count(*)::int FROM session_statistics_facts WHERE session_id = ${backfillSession} AND event_id = 1_000_006) AS facts,
        (SELECT count(*)::int FROM event_ingress_receipts WHERE session_id = ${backfillSession} AND event_id = 1_000_006) AS receipts
    `;
    expect(rollbackCounts).toEqual({ events: 0, facts: 0, receipts: 0 });

    const fixtureEvents: SessionStatisticsEventInput[] = [
      ...canonicalOwnershipEvents,
      ...claudeModelBreakdownEvents,
      unverifiedClaudeModelBreakdownEvent,
      ...keylessSystemMaterialEvents,
      {
        sessionId: "statistics-projection-range",
        eventId: 2_000_001,
        eventType: "result",
        createdAt: "2026-10-19T12:00:00.000Z",
        payload: {
          type: "result",
          success: false,
          output_command_id: "range-command",
          usage_snapshot: usageSnapshot(),
          usage: { input_tokens: 9, output_tokens: 2 },
        },
      },
      {
        ...zeroUsageEvent("statistics-projection-range", 2_000_002, "range-command"),
        createdAt: "2026-10-20T00:00:01.000Z",
      },
    ];
    await seedSourceEvents(sql, fixtureEvents);
    const fixtureFacts = fixtureEvents.flatMap((event) => normalizeSessionStatisticsEvent(event).facts);
    await insertSessionStatisticsFacts(sql as unknown as EventIngressQuerySql, fixtureFacts);
    const authorizedSessions = [...new Set([
      backfillSession,
      ...fixtureEvents.map((event) => event.sessionId),
    ])];
    const canonicalRows = await sql.begin(async (transaction) => createCanonicalSessionStatisticsFacts(
      transaction as unknown as EventIngressQuerySql,
      authorizedSessions,
    ));
    const allFacts = [...expectedBackfillFacts, ...normalizeSessionStatisticsEvent(lateLiveEvent).facts,
      ...normalizeSessionStatisticsEvent(malformed).facts, ...fixtureFacts];
    expect(describeSqlUsage(canonicalRows)).toEqual(describePureUsage(allFacts));
    expect(canonicalRows.some((row) => row.row_kind === "usage"
      && row.accounting_key === "missing-complete-wins"
      && row.state === "missing"
      && row.missing_identity === "command:missing-complete-wins"
      && row.fact === null)).toBe(true);
    expect(describeSqlMaterial(canonicalRows)).toEqual(describePureMaterial(allFacts));

    const rangeRows = await sql.begin(async (transaction) => createCanonicalSessionStatisticsFacts(
      transaction as unknown as EventIngressQuerySql,
      ["statistics-projection-range"],
      {
        recordedAtFrom: "2026-10-19T00:00:00.000Z",
        recordedAtBefore: "2026-10-20T00:00:00.000Z",
      },
    ));
    expect(describeSqlUsage(rangeRows)).toEqual(describePureUsage(
      fixtureFacts.filter((fact) => fact.session_id === "statistics-projection-range"),
    ));
    expect(rangeRows.filter((row) => row.row_kind === "usage")).toHaveLength(1);
    expect(String(rangeRows.find((row) => row.row_kind === "usage")?.owner_event_id)).toBe("2000002");
    expect(Date.parse(String(rangeRows.find((row) => row.row_kind === "usage")?.owner_recorded_at)))
      .toBeGreaterThanOrEqual(Date.parse("2026-10-20T00:00:00.000Z"));
  }, 60_000);

  it("returns pending and missing coverage for input boundaries without usage candidates", async () => {
    const events: SessionStatisticsEventInput[] = [
      {
        sessionId: "statistics-projection-closed-empty-input",
        eventId: 3_000_001,
        eventType: "user_message",
        createdAt: "2026-10-19T00:00:00.000Z",
        payload: { type: "user_message", input_id: "empty-input", text: "no usage" },
      },
      {
        sessionId: "statistics-projection-closed-empty-input",
        eventId: 3_000_002,
        eventType: "session_ended",
        createdAt: "2026-10-19T00:00:01.000Z",
        payload: { type: "session_ended" },
      },
      {
        sessionId: "statistics-projection-open-empty-input",
        eventId: 3_000_003,
        eventType: "user_message",
        createdAt: "2026-10-19T00:00:02.000Z",
        payload: { type: "user_message", input_id: "open-input", text: "still running" },
      },
      {
        sessionId: "statistics-projection-incomplete-owner",
        eventId: 3_000_004,
        eventType: "user_message",
        createdAt: "2026-10-19T00:00:03.000Z",
        payload: { type: "user_message", input_id: "incomplete-input", text: "known input" },
      },
      {
        sessionId: "statistics-projection-incomplete-owner",
        eventId: 3_000_005,
        eventType: "complete",
        createdAt: "2026-10-19T00:00:04.000Z",
        payload: { type: "complete", input_id: "incomplete-input", output_command_id: "incomplete-command" },
      },
    ];
    await seedSourceEvents(sql, events);
    await insertSessionStatisticsFacts(
      sql as unknown as EventIngressQuerySql,
      events.flatMap((event) => normalizeSessionStatisticsEvent(event).facts),
    );

    const rows = await sql.begin(async (transaction) => createCanonicalSessionStatisticsFacts(
      transaction as unknown as EventIngressQuerySql,
      events.map((event) => event.sessionId),
    ));
    const coverage = rows.filter((row) => row.row_kind === "usage" && row.fact === null);
    expect(coverage.map((row) => ({
      session_id: row.session_id,
      candidate_event_id: String(row.candidate_event_id),
      state: row.state,
    })).sort((left, right) => left.session_id.localeCompare(right.session_id))).toEqual([
      {
        session_id: "statistics-projection-closed-empty-input",
        candidate_event_id: "3000001",
        state: "missing",
      },
      {
        session_id: "statistics-projection-incomplete-owner",
        candidate_event_id: "3000004",
        state: "missing",
      },
      {
        session_id: "statistics-projection-open-empty-input",
        candidate_event_id: "3000003",
        state: "pending",
      },
    ]);
  }, 60_000);

  it("preserves command subtotals and one missing identity for mixed same-input owners", async () => {
    const sessionId = "statistics-projection-mixed-input";
    const inputId = "mixed-input";
    const boundary: SessionStatisticsEventInput = {
      sessionId, eventId: 3_050_001, eventType: "user_message",
      createdAt: "2026-10-19T00:00:00.000Z",
      payload: { type: "user_message", input_id: inputId, text: "multiple commands" },
    };
    const known: SessionStatisticsEventInput = {
      sessionId, eventId: 3_050_002, eventType: "complete",
      createdAt: "2026-10-19T00:00:01.000Z",
      payload: {
        type: "complete", input_id: inputId, output_command_id: "known-a",
        usage_snapshot: usageSnapshot(), usage: { input_tokens: 12, output_tokens: 3 },
      },
    };
    const incomplete: SessionStatisticsEventInput = {
      sessionId, eventId: 3_050_003, eventType: "complete",
      createdAt: "2026-10-19T00:00:02.000Z",
      payload: { type: "complete", input_id: inputId, output_command_id: "missing-b" },
    };
    const append = async (events: readonly SessionStatisticsEventInput[]) => {
      await seedSourceEvents(sql, events);
      await insertSessionStatisticsFacts(
        sql as unknown as EventIngressQuerySql,
        events.flatMap((event) => normalizeSessionStatisticsEvent(event).facts),
      );
      return await sql.begin(async (transaction) => createCanonicalSessionStatisticsFacts(
        transaction as unknown as EventIngressQuerySql, [sessionId],
      ));
    };
    const subtotal = (rows: Awaited<ReturnType<typeof append>>) => rows
      .filter((row) => row.row_kind === "usage" && row.state === "owned")
      .reduce((sum, row) => sum + (row.fact?.total_tokens ?? 0), 0);
    const missing = (rows: Awaited<ReturnType<typeof append>>) => rows
      .filter((row) => row.row_kind === "usage" && row.state === "missing");

    // A pending sibling preserves known A without claiming missing usage.
    const pendingRows = await append([boundary, known, {
      ...incomplete, eventType: "result",
      payload: { type: "result", success: true, input_id: inputId, output_command_id: "missing-b" },
    }]);
    expect(subtotal(pendingRows)).toBe(15);
    expect(missing(pendingRows)).toHaveLength(0);
    expect(pendingRows.some((row) => row.row_kind === "usage" && row.state === "pending")).toBe(true);

    // Exactly two commands: known A and incomplete B (result + complete).
    const twoCommandRows = await append([{ ...incomplete, eventId: 3_050_004 }]);
    expect(subtotal(twoCommandRows)).toBe(15);
    expect(missing(twoCommandRows)).toHaveLength(1);
    expect(missing(twoCommandRows)[0]).toMatchObject({ input_id: inputId, missing_identity: `input:${inputId}`, fact: null });

    // Two known commands remain additive; multiple incomplete commands share one input identity.
    const mixedRows = await append([
      { ...incomplete, eventId: 3_050_005, payload: { ...incomplete.payload as object, output_command_id: "missing-c" } },
      { ...known, eventId: 3_050_006, payload: { ...known.payload as object, output_command_id: "known-d", usage: { input_tokens: 7, output_tokens: 2 } } },
    ]);
    expect(subtotal(mixedRows)).toBe(24);
    expect(mixedRows.filter((row) => row.row_kind === "usage" && row.state === "owned" && row.fact !== null && row.fact.total_tokens !== null)
      .map((row) => row.accounting_key).sort()).toEqual(["known-a", "known-d"]);
    expect(missing(mixedRows)).toHaveLength(1);
    expect(missing(mixedRows)[0]?.missing_identity).toBe(`input:${inputId}`);
  }, 60_000);

  it("keeps backfill out of ready when persisted source facts differ from normalization", async () => {
    const event: SessionStatisticsEventInput = {
      sessionId: "zzzz-statistics-projection-reconciliation",
      eventId: 3_100_001,
      eventType: "user_message",
      createdAt: "2026-10-19T00:00:00.000Z",
      payload: { type: "user_message", input_id: "reconcile-input", text: "source text" },
    };
    await seedSourceEvents(sql, [event]);
    const expectedFacts = normalizeSessionStatisticsEvent(event).facts;
    await insertSessionStatisticsFacts(
      sql as unknown as EventIngressQuerySql,
      expectedFacts.map((fact) => fact.fact_kind === "input_material"
        ? { ...fact, approximate_tokens: 777 }
        : fact),
    );
    await sql`
      UPDATE system_settings
      SET value = ${sql.json({
        state: "backfilling",
        normalization_version: 1,
        covered_since: event.createdAt,
        backfill_cutoff_event_id: Number(event.eventId),
        last_session_id: event.sessionId,
        last_event_id: Number(event.eventId) - 1,
      })},
          version = version + 1
      WHERE setting_key = ${SESSION_STATISTICS_PROJECTION_SETTING_KEY}
    `;

    await expect(backfillSessionStatisticsProjection(sql as unknown as EventIngressSql, { batchSize: 1 }))
      .rejects.toThrow("session statistics projection facts do not match normalized source events");
    const [checkpoint] = await sql<readonly { value: Record<string, unknown> }[]>`
      SELECT value FROM system_settings
      WHERE setting_key = ${SESSION_STATISTICS_PROJECTION_SETTING_KEY}
    `;
    expect(checkpoint?.value).toMatchObject({
      state: "backfilling",
      covered_since: event.createdAt,
      backfill_cutoff_event_id: Number(event.eventId),
      last_session_id: event.sessionId,
      last_event_id: Number(event.eventId) - 1,
    });
  }, 60_000);
});

async function seedSourceEvents(
  sql: ReturnType<typeof postgres>,
  events: readonly SessionStatisticsEventInput[],
): Promise<void> {
  const sessions = [...new Set(events.map((event) => event.sessionId))];
  for (const sessionId of sessions) {
    await sql`
      INSERT INTO sessions (session_id, status, session_type)
      VALUES (${sessionId}, 'idle', 'claude')
      ON CONFLICT (session_id) DO NOTHING
    `;
  }
  for (const event of events) {
    await sql`
      INSERT INTO events (session_id, id, event_type, payload, created_at)
      VALUES (
        ${event.sessionId}, ${Number(event.eventId)}, ${event.eventType},
        ${sql.json(event.payload as Parameters<typeof sql.json>[0])}::jsonb, ${event.createdAt}
      )
      ON CONFLICT (session_id, id) DO NOTHING
    `;
  }
}

function zeroUsageEvent(
  sessionId: string,
  eventId: number,
  accountingKey: string,
): SessionStatisticsEventInput {
  return {
    sessionId,
    eventId,
    eventType: "complete",
    createdAt: "2026-10-19T00:00:03.000Z",
    payload: {
      type: "complete",
      output_command_id: accountingKey,
      usage_snapshot: usageSnapshot(),
      usage: {
        input_tokens: 0,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
      },
    },
  };
}

function usageSnapshot() {
  return {
    schema_version: 1,
    backend: "codex",
    provider: "codex",
    preset_id: null,
    requested_model: "gpt-6-luna",
    provider_attribution: "configured_alias",
  };
}

function asEnvelope(event: SessionStatisticsEventInput): EventIngressEnvelope {
  return {
    session_id: event.sessionId,
    event_type: event.eventType,
    created_at: event.createdAt,
    payload: event.payload,
  } as unknown as EventIngressEnvelope;
}

function describePureUsage(facts: readonly FactDraft[]) {
  return selectCanonicalUsageCandidates(facts).map((selection) => ({
    session_id: selection.sessionId,
    accounting_key: selection.accountingKey,
    owner_event_id: nullableId(selection.ownerEventId),
    candidate_event_id: nullableId(selection.candidateEventId),
    candidate_type: selection.candidateType,
    representation: selection.representation,
    state: selection.state,
    selection_quality: selection.quality,
    fact_keys: selection.facts.map((fact) => `${fact.event_id}/${fact.part_key}`).sort(),
    facts: selection.facts.map(describeFact).sort(byPartKey),
  })).sort(byDescriptor);
}

function describeSqlUsage(rows: Awaited<ReturnType<typeof createCanonicalSessionStatisticsFacts>>) {
  const groups = new Map<string, typeof rows[number][]>();
  for (const row of rows.filter((item) => item.row_kind === "usage"
    && !(item.fact === null && item.candidate_type === null && item.missing_identity !== null))) {
    const key = `${row.session_id}\u0000${row.selection_event_id}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()].map((group) => {
    const row = group[0]!;
    const facts = group.flatMap((item) => item.fact === null ? [] : [item.fact]);
    return {
      session_id: row.session_id,
      accounting_key: row.accounting_key,
      owner_event_id: nullableId(row.owner_event_id),
      candidate_event_id: nullableId(row.candidate_event_id),
      candidate_type: row.candidate_type,
      representation: row.representation,
      state: row.state,
      selection_quality: row.selection_quality,
      fact_keys: facts.map((fact) => `${fact.event_id}/${fact.part_key}`).sort(),
      facts: facts.map(describeFact).sort(byPartKey),
    };
  }).sort(byDescriptor);
}

function describePureMaterial(facts: readonly FactDraft[]) {
  return selectCanonicalInputMaterialFacts(facts).map(describeMaterial).sort(byDescriptor);
}

function describeSqlMaterial(rows: Awaited<ReturnType<typeof createCanonicalSessionStatisticsFacts>>) {
  return rows
    .filter((row) => row.row_kind === "input_material" && row.fact !== null)
    .map((row) => describeMaterial(row.fact!))
    .sort(byDescriptor);
}

function describeFact(fact: FactDraft) {
  return {
    event_id: String(fact.event_id),
    part_key: fact.part_key,
    fact_kind: fact.fact_kind,
    accounting_key: fact.accounting_key,
    input_id: fact.input_id,
    candidate_type: fact.candidate_type,
    provider: fact.provider,
    backend: fact.backend,
    model: fact.model,
    representation: fact.representation,
    input_total: fact.input_total,
    output_total: fact.output_total,
    total_tokens: fact.total_tokens,
    cache_read: fact.cache_read,
    cache_write: fact.cache_write,
    reasoning_output: fact.reasoning_output,
    known_cost_usd: fact.known_cost_usd,
    priced_tokens: fact.priced_tokens,
    unpriced_tokens: fact.unpriced_tokens,
    pricing_complete: fact.pricing_complete,
    pricing_version: fact.pricing_version,
    quality: [...fact.quality].sort(),
    raw_numeric: fact.raw_numeric,
  };
}

function describeMaterial(fact: FactDraft) {
  return {
    session_id: fact.session_id,
    event_id: String(fact.event_id),
    part_key: fact.part_key,
    category: fact.category,
    source_key: fact.source_key,
    estimate_source: fact.estimate_source,
    raw_chars_utf16: fact.raw_chars_utf16,
    approximate_tokens: fact.approximate_tokens,
    quality: [...fact.quality].sort(),
  };
}

function nullableId(value: number | string | null): string | null {
  return value === null ? null : String(value);
}

function byPartKey(left: { part_key: string }, right: { part_key: string }): number {
  return left.part_key.localeCompare(right.part_key);
}

function byDescriptor(left: unknown, right: unknown): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}
