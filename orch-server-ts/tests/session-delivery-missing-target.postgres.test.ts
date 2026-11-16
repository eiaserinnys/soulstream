/**
 * card #1353 — 대상 세션이 지워진 pending 배달 줄은 회수 쿼리가 세션과
 * 조인하므로 아무도 집어 가지 않고, 재시도 예산도 호출이 없으면 계산되지 않아
 * 영원히 pending으로 남는다. CompletionDeliveryRecoveryWorker가 5초마다 부르는
 * expireStaleDeliveryAttempts가 24시간 지난 줄만 dead_letter로 닫는다.
 */
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { SqlClient } from "../src/control_plane/control_plane_types.js";
import { SessionDeliveryRepository } from
  "../src/control_plane/repositories/session_delivery_repository.js";
import { createPagePostgresHarness, type PagePostgresHarness } from
  "./page/page_postgres_harness.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("session deliveries whose target session is gone", () => {
  let harness: PagePostgresHarness;
  let repository: SessionDeliveryRepository;

  beforeAll(async () => {
    harness = await createPagePostgresHarness();
    const schemaSql = await readFile(
      new URL("../../packages/db-schema/sql/schema.sql", import.meta.url),
      "utf8",
    );
    await harness.sql.unsafe(
      schemaSql.match(
        /CREATE TABLE IF NOT EXISTS session_deliveries \([\s\S]*?\n\);/,
      )![0],
    );
    await harness.sql.unsafe(
      schemaSql.match(
        /ALTER TABLE session_deliveries\n    ADD COLUMN IF NOT EXISTS aggregate_state[\s\S]*?;/,
      )![0],
    );
    await harness.sql.unsafe(
      schemaSql.match(
        /ALTER TABLE session_deliveries\n    ADD CONSTRAINT session_deliveries_aggregate_state_check[\s\S]*?;/,
      )![0],
    );
    await harness.sql.unsafe(
      schemaSql.match(
        /CREATE TABLE IF NOT EXISTS session_delivery_attempts \([\s\S]*?\n\);/,
      )![0],
    );
    await harness.sql.unsafe(
      schemaSql.match(
        /CREATE TABLE IF NOT EXISTS session_delivery_relation_consumptions \([\s\S]*?\n\);/,
      )![0],
    );
    repository = new SessionDeliveryRepository(harness.sql as unknown as SqlClient);
  }, 60_000);

  beforeEach(async () => {
    await harness.sql`DELETE FROM session_delivery_attempts`;
    await harness.sql`DELETE FROM session_delivery_relation_consumptions`;
    await harness.sql`DELETE FROM session_deliveries`;
    await harness.sql`DELETE FROM sessions`;
    await harness.sql`
      INSERT INTO sessions (session_id, status) VALUES ('live-target', 'running')
    `;
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  async function insertDelivery(input: {
    id: string;
    targetSessionId: string | null;
    ageMs: number;
    state?: string;
    aggregateState?: string;
  }): Promise<void> {
    const updatedAt = new Date(Date.now() - input.ageMs);
    await harness.sql`
      INSERT INTO session_deliveries (
        delivery_id, target_session_id, relation_key, intent, source,
        payload_hash, payload, state, aggregate_state, updated_at
      ) VALUES (
        ${input.id}, ${input.targetSessionId}, ${input.id}, 'human_live_steer',
        'browser', ${`hash-${input.id}`}, ${harness.sql.json({})},
        ${input.state ?? "pending"}, ${input.aggregateState ?? "pending"}, ${updatedAt}
      )
    `;
  }

  it("closes only target-less pending deliveries older than 24 hours", async () => {
    await insertDelivery({ id: "orphan-old", targetSessionId: null, ageMs: DAY_MS + 60_000 });
    await insertDelivery({ id: "orphan-fresh", targetSessionId: null, ageMs: DAY_MS - 60_000 });
    await insertDelivery({ id: "targeted-old", targetSessionId: "live-target", ageMs: DAY_MS + 60_000 });
    await insertDelivery({
      id: "orphan-delivered",
      targetSessionId: null,
      ageMs: DAY_MS + 60_000,
      state: "delivered",
      aggregateState: "delivered",
    });
    // 운영의 모양: 세션 삭제가 FK ON DELETE SET NULL로 target을 비운 pending 줄.
    await harness.sql`INSERT INTO sessions (session_id, status) VALUES ('gone-target', 'running')`;
    await insertDelivery({
      id: "orphan-via-delete",
      targetSessionId: "gone-target",
      ageMs: DAY_MS + 60_000,
    });
    await harness.sql`DELETE FROM sessions WHERE session_id = 'gone-target'`;

    await repository.expireStaleDeliveryAttempts();

    const rows = await harness.sql<Array<{
      delivery_id: string;
      state: string;
      aggregate_state: string;
      last_error: string | null;
      dead_letter_reason: string | null;
      attempt_count: number;
      dead_lettered_at: Date | null;
    }>>`
      SELECT delivery_id, state, aggregate_state, last_error, dead_letter_reason,
             attempt_count, dead_lettered_at
      FROM session_deliveries
      ORDER BY delivery_id
    `;
    expect(rows).toMatchObject([
      {
        delivery_id: "orphan-delivered",
        state: "delivered",
        aggregate_state: "delivered",
        last_error: null,
        attempt_count: 0,
      },
      {
        delivery_id: "orphan-fresh",
        state: "pending",
        aggregate_state: "pending",
        last_error: null,
        attempt_count: 0,
      },
      {
        delivery_id: "orphan-old",
        state: "uncertain",
        aggregate_state: "dead_letter",
        last_error: "target_session_missing",
        dead_letter_reason: "target_session_missing",
        attempt_count: 1,
      },
      {
        delivery_id: "orphan-via-delete",
        state: "uncertain",
        aggregate_state: "dead_letter",
        last_error: "target_session_missing",
        dead_letter_reason: "target_session_missing",
        attempt_count: 1,
      },
      {
        delivery_id: "targeted-old",
        state: "pending",
        aggregate_state: "pending",
        last_error: null,
        attempt_count: 0,
      },
    ]);
    expect(rows.find((row) => row.delivery_id === "orphan-old")?.dead_lettered_at)
      .toBeInstanceOf(Date);

    const attempts = await harness.sql<Array<{
      delivery_id: string;
      attempt_number: number;
      outcome: string;
      reason: string | null;
    }>>`
      SELECT delivery_id, attempt_number, outcome, reason
      FROM session_delivery_attempts
      ORDER BY delivery_id, attempt_number
    `;
    expect(attempts).toEqual([
      {
        delivery_id: "orphan-old",
        attempt_number: 1,
        outcome: "rejected",
        reason: "target_session_missing",
      },
      {
        delivery_id: "orphan-via-delete",
        attempt_number: 1,
        outcome: "rejected",
        reason: "target_session_missing",
      },
    ]);

    // 5초 주기 스위퍼가 다시 돌아도 닫힌 줄을 다시 닫지 않는다.
    await repository.expireStaleDeliveryAttempts();
    const attemptsAfterSecondScan = await harness.sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count FROM session_delivery_attempts
    `;
    expect(attemptsAfterSecondScan[0]?.count).toBe(2);
  });
});
