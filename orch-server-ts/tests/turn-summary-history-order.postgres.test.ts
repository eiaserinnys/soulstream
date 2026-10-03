import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

import { startPostgresTestContainer } from
  "../../packages/db-schema/scripts/postgres-test-container.mjs";
import type {
  LiveDbSqlResolver,
  LivePostgresSql,
} from "../src/runtime/live_db_sql.js";
import { TurnSummaryRepository } from
  "../src/turn-summary/turn_summary_repository.js";

const hasDocker = spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
const describePostgres = hasDocker ? describe : describe.skip;

const SESSION = "history-order-session";

// Turn layout. `summaryId` is the event id the turn_summary row itself occupies.
// The backfilled turns (10/20/30) were written AFTER the live turn (40), so their
// summary event ids are HIGHER than the live one even though they are older turns.
// This is exactly the state the turn-summary backfill produces.
const TURNS = [
  { turnStart: 10, finalResponse: 11, summaryId: 201, content: "turn-10" },
  { turnStart: 20, finalResponse: 21, summaryId: 202, content: "turn-20" },
  { turnStart: 30, finalResponse: 31, summaryId: 203, content: "turn-30" },
  { turnStart: 40, finalResponse: 41, summaryId: 100, content: "turn-40-live" },
] as const;

describePostgres("turn summary history ordering after backfill", () => {
  let sql: ReturnType<typeof postgres>;
  let cleanup: () => Promise<void>;
  let repository: TurnSummaryRepository;

  beforeAll(async () => {
    ({ sql, cleanup } = await createHarness());
    repository = new TurnSummaryRepository(resolverFor(sql));
    await seed(sql);
  }, 90_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("orders history by turn position, not by summary event id", async () => {
    // The two most recent turns are 30 and 40. Turn 40's summary has the LOWEST
    // event id, so an id-ordered query silently drops it and returns 20/30.
    await expect(
      repository.loadPreviousSummaries(SESSION, 2, Number.MAX_SAFE_INTEGER),
    ).resolves.toEqual(["turn-30", "turn-40-live"]);
  });

  it("excludes summaries at or after the target turn", async () => {
    // Backfilling turn 30 must not read turn 30's own summary nor the later
    // live turn 40 as "previous" history.
    await expect(
      repository.loadPreviousSummaries(SESSION, 5, 30),
    ).resolves.toEqual(["turn-10", "turn-20"]);
  });

  it("returns full history in chronological order when nothing precedes the cutoff", async () => {
    await expect(
      repository.loadPreviousSummaries(SESSION, 10, Number.MAX_SAFE_INTEGER),
    ).resolves.toEqual(["turn-10", "turn-20", "turn-30", "turn-40-live"]);
  });

  it("returns nothing before the first turn", async () => {
    await expect(
      repository.loadPreviousSummaries(SESSION, 5, 10),
    ).resolves.toEqual([]);
  });

  it("falls back to the event id for a legacy summary without a turn marker", async () => {
    // Pre-contract rows carry no turn_start_event_id. They must still sort and
    // filter, using their own event id as the turn position.
    await sql`
      INSERT INTO events (session_id, id, event_type, payload, created_at)
      VALUES (
        ${SESSION}, 25, 'turn_summary',
        ${sql.json({ type: "turn_summary", content: "legacy-25" })}::jsonb,
        NOW()
      )
    `;
    try {
      await expect(
        repository.loadPreviousSummaries(SESSION, 10, Number.MAX_SAFE_INTEGER),
      ).resolves.toEqual([
        "turn-10",
        "turn-20",
        "legacy-25",
        "turn-30",
        "turn-40-live",
      ]);
      await expect(
        repository.loadPreviousSummaries(SESSION, 10, 25),
      ).resolves.toEqual(["turn-10", "turn-20"]);
    } finally {
      await sql`DELETE FROM events WHERE session_id = ${SESSION} AND id = 25`;
    }
  });
});

async function seed(sql: ReturnType<typeof postgres>): Promise<void> {
  await sql`
    INSERT INTO sessions (session_id, status, session_type, created_at, updated_at)
    VALUES (${SESSION}, 'idle', 'claude', NOW(), NOW())
  `;
  for (const turn of TURNS) {
    await sql`
      INSERT INTO events (session_id, id, event_type, payload, created_at)
      VALUES (
        ${SESSION}, ${turn.turnStart}, 'user_message',
        ${sql.json({ type: "user_message", text: "q" })}::jsonb, NOW()
      ), (
        ${SESSION}, ${turn.finalResponse}, 'assistant_message',
        ${sql.json({ type: "assistant_message", content: "a" })}::jsonb, NOW()
      )
    `;
  }
  // Insert summaries in ascending summary-event-id order so the physical write
  // order matches what the DB would actually have seen.
  for (const turn of [...TURNS].sort((a, b) => a.summaryId - b.summaryId)) {
    await sql`
      INSERT INTO events (session_id, id, event_type, payload, created_at)
      VALUES (
        ${SESSION}, ${turn.summaryId}, 'turn_summary',
        ${sql.json({
          type: "turn_summary",
          content: turn.content,
          turn_start_event_id: turn.turnStart,
          final_response_event_id: turn.finalResponse,
        })}::jsonb,
        NOW()
      )
    `;
  }
}

function resolverFor(sql: ReturnType<typeof postgres>): LiveDbSqlResolver {
  return {
    resolveSql: async () => sql as unknown as LivePostgresSql,
    close: async () => undefined,
  };
}

async function createHarness(): Promise<{
  sql: ReturnType<typeof postgres>;
  cleanup: () => Promise<void>;
}> {
  const container = startPostgresTestContainer({
    user: "turn_summary_history_test",
    password: "turn_summary_history_test",
    database: "turn_summary_history_test_db",
  });
  const url =
    `postgres://turn_summary_history_test:turn_summary_history_test@127.0.0.1:${container.port}/turn_summary_history_test_db`;
  const bootstrap = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await waitForPostgres(bootstrap);
    const schema = readFileSync(fileURLToPath(new URL(
      "../../packages/db-schema/sql/schema.sql",
      import.meta.url,
    )), "utf8");
    await bootstrap.unsafe(schema);
  } catch (error) {
    await bootstrap.end({ timeout: 2 }).catch(() => undefined);
    container.stop();
    throw error;
  }
  return {
    sql: bootstrap,
    cleanup: async () => {
      await bootstrap.end({ timeout: 2 });
      container.stop();
    },
  };
}

async function waitForPostgres(sql: ReturnType<typeof postgres>): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await sql`SELECT 1`;
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
