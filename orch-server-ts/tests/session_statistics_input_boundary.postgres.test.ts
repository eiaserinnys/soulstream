import { spawnSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

import { createCanonicalSessionStatisticsFacts } from "../src/usage/session_statistics_canonical_sql.js";
import type { EventIngressQuerySql } from "../src/node/event_ingress_repository.js";
import {
  createFullSchemaPostgresHarness,
  type FullSchemaPostgresHarness,
} from "./board_yjs_postgres_harness.js";

const hasDocker = spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
const hasTestDatabase = Boolean(process.env.TEST_DATABASE_URL?.trim());
const describePostgres = hasDocker || hasTestDatabase ? describe : describe.skip;
const RECORDED_AT = "2026-10-19T00:00:00.000Z";
const AS_OF = "2026-10-20T00:12:09.086Z";

describePostgres("session statistics input boundary mapping", () => {
  let harness: FullSchemaPostgresHarness;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
    sql = harness.sql;
  }, 60_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  it("analyzes indexed temporary facts and recreates them within the same transaction", async () => {
    const sessionId = "input-boundary-temporary-facts";
    await seedSession(sessionId);
    await seedBoundary(sessionId, 1, "temporary-input");
    await seedUsage(sessionId, 2, {
      candidateType: "complete", accountingKey: "temporary-command", inputId: "temporary-input",
    });
    await sql.begin(async (transaction) => {
      const read = () => createCanonicalSessionStatisticsFacts(
        transaction as unknown as EventIngressQuerySql,
        [sessionId, sessionId],
        undefined,
        { asOf: AS_OF, readPurpose: { kind: "overview" } },
      );
      const first = await read();
      expect(first.some((row) => row.state === "owned" && row.fact?.total_tokens === 15)).toBe(true);
      const relations = await transaction`
        SELECT relname, reltuples::int AS rows,
          (SELECT count(*)::int FROM pg_index WHERE indrelid = relation.oid) AS indexes
        FROM pg_class AS relation
        WHERE relnamespace = pg_my_temp_schema()
          AND relname IN ('authorized_sessions', 'day_material_seed_facts', 'scoped_facts')
        ORDER BY relname
      `;
      expect(relations).toEqual([
        { relname: "authorized_sessions", rows: 1, indexes: 1 },
        { relname: "day_material_seed_facts", rows: 0, indexes: 0 },
        { relname: "scoped_facts", rows: 2, indexes: 3 },
      ]);
      expect(await read()).toEqual(first);
      const readDay = () => createCanonicalSessionStatisticsFacts(
        transaction as unknown as EventIngressQuerySql,
        [sessionId],
        undefined,
        { asOf: AS_OF, readPurpose: {
          kind: "day", recordedAtFrom: RECORDED_AT, recordedAtBefore: AS_OF,
        } },
      );
      const day = await readDay();
      expect(day).toEqual(first);
      const dayRelations = await transaction`
        SELECT relname, reltuples::int AS rows,
          (SELECT count(*)::int FROM pg_index WHERE indrelid = relation.oid) AS indexes
        FROM pg_class AS relation
        WHERE relnamespace = pg_my_temp_schema()
          AND relname IN ('labeled_usage_selections', 'material_scope_facts')
        ORDER BY relname
      `;
      expect(dayRelations).toEqual([
        { relname: "labeled_usage_selections", rows: 1, indexes: 0 },
        { relname: "material_scope_facts", rows: 2, indexes: 3 },
      ]);
      expect(await readDay()).toEqual(day);
    });
    const [temporary] = await sql`
      SELECT to_regclass('pg_temp.scoped_facts') AS relation,
        to_regclass('pg_temp.labeled_usage_selections') AS selections,
        to_regclass('pg_temp.material_scope_facts') AS material
    `;
    expect(temporary?.relation).toBeNull();
    expect(temporary?.selections).toBeNull();
    expect(temporary?.material).toBeNull();
  });

  it("keeps exact input boundaries ahead of their position", async () => {
    const sessionId = "input-boundary-exact-future";
    await seedSession(sessionId);
    await seedBoundary(sessionId, 50, "i-a");
    await seedUsage(sessionId, 100, {
      candidateType: "complete",
      accountingKey: "cmd-x",
      inputId: "i-b",
    });
    await seedBoundary(sessionId, 200, "i-b");

    const rows = await readRows(sessionId);
    expect(rows.filter((row) => row.row_kind === "usage" && row.candidate_type !== null))
      .toHaveLength(1);
    expect(rows.filter((row) => row.row_kind === "usage" && row.fact === null && row.missing_identity !== null)
      .map((row) => row.missing_identity)).toEqual(["input:i-a"]);
  });

  it("maps a selection to an input boundary at the same event", async () => {
    const sessionId = "input-boundary-tie";
    await seedSession(sessionId);
    await seedBoundary(sessionId, 50, null);
    await seedBoundary(sessionId, 100, "i-c");
    await seedUsage(sessionId, 100, {
      candidateType: "complete",
      accountingKey: "cmd-y",
      inputId: "i-c",
    });

    const rows = await readRows(sessionId);
    expect(rows.filter((row) => row.row_kind === "usage" && row.fact === null && row.missing_identity !== null)
      .map((row) => row.missing_identity)).toEqual(["user_event:50"]);
  });

  it("falls back to the closest input boundary at or before the selection", async () => {
    const sessionId = "input-boundary-fallback";
    await seedSession(sessionId);
    await seedBoundary(sessionId, 150, "i-old");
    await seedUsage(sessionId, 200, {
      candidateType: "success_result",
      accountingKey: "cmd-z",
      inputId: null,
    });
    await seedBoundary(sessionId, 300, "i-later");

    const rows = await readRows(sessionId);
    const pending = rows.find((row) => row.candidate_type !== null);
    expect(pending?.missing_identity).toBe("user_event:150");
    expect(rows.filter((row) => row.row_kind === "usage" && row.fact === null && row.missing_identity !== null)
      .map((row) => row.missing_identity)).toEqual(["input:i-later", "user_event:150"]);
  });

  it("does not attach a future input boundary without an exact input id", async () => {
    const sessionId = "input-boundary-none";
    await seedSession(sessionId);
    await seedUsage(sessionId, 10, {
      candidateType: "success_result",
      accountingKey: "cmd-w",
      inputId: null,
    });
    await seedBoundary(sessionId, 500, "i-future");

    const rows = await readRows(sessionId);
    const pending = rows.find((row) => row.candidate_type !== null);
    expect(pending?.missing_identity).toBe("command:cmd-w");
    expect(rows.some((row) => row.missing_identity === "input:i-future")).toBe(true);
  });

  async function readRows(sessionId: string) {
    return await sql.begin(async (transaction) => createCanonicalSessionStatisticsFacts(
      transaction as unknown as EventIngressQuerySql,
      [sessionId],
      undefined,
      { asOf: AS_OF, readPurpose: { kind: "overview" } },
    ));
  }

  async function seedSession(sessionId: string): Promise<void> {
    await sql`
      INSERT INTO sessions (session_id, status, session_type)
      VALUES (${sessionId}, 'idle', 'claude')
      ON CONFLICT (session_id) DO NOTHING
    `;
  }

  async function seedBoundary(
    sessionId: string,
    eventId: number,
    inputId: string | null,
  ): Promise<void> {
    await seedEvent(sessionId, eventId);
    await sql`
      INSERT INTO session_statistics_facts (
        session_id, event_id, part_key, fact_kind, recorded_at, source_event_type,
        normalization_version, provider, quality, input_id, boundary_type
      ) VALUES (
        ${sessionId}, ${eventId}, 'boundary', 'boundary', ${RECORDED_AT}, 'user_message',
        1, 'codex', '[]'::jsonb, ${inputId}, 'input'
      )
    `;
  }

  async function seedUsage(
    sessionId: string,
    eventId: number,
    fields: {
      candidateType: "complete" | "success_result";
      accountingKey: string;
      inputId: string | null;
    },
  ): Promise<void> {
    const eventType = fields.candidateType === "complete" ? "complete" : "result";
    await seedEvent(sessionId, eventId, eventType);
    await sql`
      INSERT INTO session_statistics_facts (
        session_id, event_id, part_key, fact_kind, recorded_at, source_event_type,
        normalization_version, accounting_key, input_id, candidate_type, provider,
        quality, representation, input_total, output_total, total_tokens
      ) VALUES (
        ${sessionId}, ${eventId}, 'usage:aggregate', 'usage', ${RECORDED_AT}, ${eventType},
        1, ${fields.accountingKey}, ${fields.inputId}, ${fields.candidateType}, 'codex',
        '[]'::jsonb, 'aggregate', 10, 5, 15
      )
    `;
  }

  async function seedEvent(
    sessionId: string,
    eventId: number,
    eventType = "user_message",
  ): Promise<void> {
    await sql`
      INSERT INTO events (session_id, id, event_type, payload, created_at)
      VALUES (
        ${sessionId}, ${eventId}, ${eventType},
        ${sql.json({ type: eventType })}::jsonb, ${RECORDED_AT}
      )
      ON CONFLICT (session_id, id) DO NOTHING
    `;
  }
});
