import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { SessionMutationRepository } from
  "../../../orch-server-ts/src/control_plane/repositories/session_mutation_repository.js";
import { updateSessionReviewPolicy } from
  "../../../orch-server-ts/src/system/session_review_policy.js";
import {
  createFullSchemaPostgresHarness,
  hasFullSchemaPostgresBackend,
  type FullSchemaPostgresHarness,
} from "./full_schema_postgres_harness.js";

const describePostgres = hasFullSchemaPostgresBackend ? describe : describe.skip;

describePostgres("session review policy PostgreSQL ordering", () => {
  let harness: FullSchemaPostgresHarness | undefined;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
  }, 45_000);

  afterAll(async () => {
    await harness?.cleanup();
  }, 15_000);

  it("serializes a CAS update after an in-flight registration and replays the first decision", async () => {
    const sql = harness!.sql;
    const registerSql = harness!.createPeer();
    const updateSql = harness!.createPeer();
    const observerSql = harness!.createPeer();
    const lockId = 9_140_091;

    await sql`DELETE FROM session_mutation_receipts`;
    await sql`DELETE FROM sessions`;
    await sql`
      UPDATE system_settings
      SET value = '{"source_allowlist":["external-llm"]}'::JSONB,
          version = 1,
          updated_at = NOW(),
          updated_by = 'test'
      WHERE setting_key = 'session_review_policy'
    `;
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION test_hold_session_insert()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(${lockId});
        RETURN NEW;
      END;
      $$;
      DROP TRIGGER IF EXISTS test_hold_session_insert ON sessions;
      CREATE TRIGGER test_hold_session_insert
      BEFORE INSERT ON sessions
      FOR EACH ROW EXECUTE FUNCTION test_hold_session_insert();
    `);
    await sql`SELECT pg_advisory_lock(${lockId})`;

    const repository = new SessionMutationRepository(registerSql as never);
    const firstRegistration = repository.registerSession(input(
      "session-before-cas",
      "register-before-cas",
      new Date("2026-09-14T00:00:00.000Z"),
    ));
    await waitForQuery(observerSql, "session_register_with_model_preset", "advisory");

    const concurrentUpdate = updateSessionReviewPolicy(updateSql as never, {
      sourceAllowlist: [],
      expectedVersion: 1,
      updatedBy: "admin@example.com",
    });
    await waitForQuery(observerSql, "UPDATE system_settings", "transactionid");

    await sql`SELECT pg_advisory_unlock(${lockId})`;
    const [registered, updated] = await Promise.all([
      firstRegistration,
      concurrentUpdate,
    ]);
    expect(registered).toMatchObject({
      reviewRequired: true,
      reviewDecision: "central_policy",
      policyVersion: 1,
    });
    expect(updated).toMatchObject({ version: 2, sourceAllowlist: [] });

    await sql`DROP TRIGGER test_hold_session_insert ON sessions`;
    const afterUpdate = await repository.registerSession(input(
      "session-after-cas",
      "register-after-cas",
      new Date("2026-09-14T00:00:01.000Z"),
    ));
    expect(afterUpdate).toMatchObject({
      reviewRequired: false,
      policyVersion: 2,
    });

    const retry = await repository.registerSession(input(
      "session-before-cas",
      "register-before-cas",
      new Date("2026-09-14T00:00:02.000Z"),
    ));
    expect(retry).toEqual(registered);
    const rows = await sql<Array<{
      session_id: string;
      review_required: boolean;
    }>>`
      SELECT session_id, review_required
      FROM sessions
      ORDER BY session_id
    `;
    expect(rows).toEqual([
      { session_id: "session-after-cas", review_required: false },
      { session_id: "session-before-cas", review_required: true },
    ]);
  }, 45_000);

  it("does not overwrite an existing policy when migration 091 is reapplied", async () => {
    const sql = harness!.sql;
    await sql`
      UPDATE system_settings
      SET value = '{"source_allowlist":["custom-source"]}'::JSONB,
          version = 41,
          updated_by = 'admin@example.com'
      WHERE setting_key = 'session_review_policy'
    `;
    const migration = readFileSync(
      new URL("../../../packages/db-schema/sql/migrations/091_system_settings.sql", import.meta.url),
      "utf8",
    );
    await sql.unsafe(migration);
    const rows = await sql<Array<{ value: { source_allowlist: string[] }; version: string | number }>>`
      SELECT value, version
      FROM system_settings
      WHERE setting_key = 'session_review_policy'
    `;
    expect(rows[0]?.value).toEqual({ source_allowlist: ["custom-source"] });
    expect(Number(rows[0]?.version)).toBe(41);
  });
});

function input(sessionId: string, idempotencyKey: string, now: Date) {
  return {
    idempotencyKey,
    sessionId,
    nodeId: "node-test",
    agentId: null,
    claudeSessionId: null,
    sessionType: "claude",
    prompt: "inspect",
    clientId: null,
    status: "initializing",
    createdAt: now,
    updatedAt: now,
    callerSessionId: null,
    predecessorSessionId: null,
    callerInfo: { source: "external-llm", display_name: "External LLM" },
    reviewRequired: false,
    reviewState: "not_required",
  };
}

async function waitForQuery(
  sql: FullSchemaPostgresHarness["sql"],
  queryFragment: string,
  waitEvent: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await sql<Array<{ found: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE pid <> pg_backend_pid()
          AND query LIKE ${`%${queryFragment}%`}
          AND lower(COALESCE(wait_event, '')) LIKE ${`%${waitEvent.toLowerCase()}%`}
      ) AS found
    `;
    if (rows[0]?.found) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${queryFragment} on ${waitEvent}`);
}
