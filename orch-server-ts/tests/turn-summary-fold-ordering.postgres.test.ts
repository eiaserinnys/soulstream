import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";

import { startPostgresTestContainer } from
  "../../packages/db-schema/scripts/postgres-test-container.mjs";
import type {
  LiveDbSqlResolver,
  LivePostgresSql,
} from "../src/runtime/live_db_sql.js";
import { SessionStoryRepository } from
  "../src/turn-summary/session_story_repository.js";

const hasDocker = spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
const describePostgres = hasDocker ? describe : describe.skip;

describePostgres("turn summary fold ordering and watermark", () => {
  let sql: ReturnType<typeof postgres>;
  let cleanup: () => Promise<void>;
  let repository: SessionStoryRepository;

  beforeAll(async () => {
    ({ sql, cleanup } = await createHarness());
    repository = new SessionStoryRepository(resolverFor(sql));
  }, 90_000);

  afterAll(async () => {
    await cleanup?.();
  });

  beforeEach(async () => {
    await sql`DELETE FROM session_digests`;
    await sql`DELETE FROM events`;
    await sql`DELETE FROM sessions`;
  });

  // Root's counterexample: an ingestion batch may hold rows whose turn order is
  // scrambled. Selecting the batch by turn order would commit a watermark that
  // jumps over an unprocessed row and orphan it forever.
  it("selects a contiguous ingestion run so a scrambled batch orphans nothing", async () => {
    await seedSession("orphan");
    await insertSummary("orphan", { rowId: 101, turnStart: 40 });
    await insertSummary("orphan", { rowId: 102, turnStart: 50 });
    await insertSummary("orphan", { rowId: 103, turnStart: 15 });

    const batch = await repository.loadUnfoldedSummaries("orphan", 100, 2);

    // Ingestion-contiguous: rows 101 and 102, never 103 first.
    expect(batch.map((summary) => summary.eventId)).toEqual([101, 102]);

    // The fold commits the last row of the batch as the new watermark, so the
    // remainder must still be visible on the next pass.
    const committedWatermark = batch[batch.length - 1]?.eventId ?? 0;
    expect(committedWatermark).toBe(102);
    await expect(
      repository.countUnfoldedSummaries("orphan", committedWatermark),
    ).resolves.toBe(1);
    await expect(
      repository.loadUnfoldedSummaries("orphan", committedWatermark, 10),
    ).resolves.toMatchObject([{ eventId: 103 }]);
  });

  it("keeps rows inserted during a fold pending for the next fold", async () => {
    await seedSession("concurrent");
    await insertSummary("concurrent", { rowId: 201, turnStart: 10 });
    await insertSummary("concurrent", { rowId: 202, turnStart: 20 });

    const batch = await repository.loadUnfoldedSummaries("concurrent", 0, 2);
    // A live turn lands while the model call for the batch above is in flight.
    await insertSummary("concurrent", { rowId: 203, turnStart: 30 });

    const committedWatermark = batch[batch.length - 1]?.eventId ?? 0;
    await expect(
      repository.countUnfoldedSummaries("concurrent", committedWatermark),
    ).resolves.toBe(1);
  });

  // Root's late-arrival case: a past turn summarised after the narrative was
  // already folded must still be detected as unfolded, exactly once.
  it("detects a late past summary as unfolded without duplicating folded rows", async () => {
    await seedSession("late");
    await insertSummary("late", { rowId: 301, turnStart: 10 });
    await insertSummary("late", { rowId: 302, turnStart: 20 });
    await insertSummary("late", { rowId: 303, turnStart: 30 });
    await sql`
      INSERT INTO session_digests (
        session_id, narrative, highlight, narrative_through_event_id,
        fold_count, version, created_at, updated_at
      ) VALUES ('late', '[T1] a [T2] b [T3] c', 'h', 303, 1, 1, NOW(), NOW())
    `;
    // Backfilled afterwards, so it carries the highest row id.
    await insertSummary("late", { rowId: 304, turnStart: 15 });

    await expect(repository.countUnfoldedSummaries("late", 303)).resolves.toBe(1);
    const unfolded = await repository.loadUnfoldedSummaries("late", 303, 10);
    expect(unfolded.map((summary) => summary.eventId)).toEqual([304]);

    const counts = await repository.countTurnSummaries("late");
    expect(counts).toEqual({
      totalCount: 4,
      digestedCount: 3,
      undigestedCount: 1,
    });
  });

  // A turn's number is its position in the conversation, so it must not depend
  // on whether the session has been folded yet.
  it("numbers a turn by conversation position, unchanged by folding", async () => {
    await seedSession("stable");
    await insertSummary("stable", { rowId: 401, turnStart: 10 });
    await insertSummary("stable", { rowId: 402, turnStart: 20 });
    await insertSummary("stable", { rowId: 403, turnStart: 30 });

    const beforeFold = await repository.loadUnfoldedSummaries("stable", 0, 10);
    expect(numbering(beforeFold)).toEqual([[401, 1], [402, 2], [403, 3]]);

    // First fold covers rows 401-402.
    await sql`
      INSERT INTO session_digests (
        session_id, narrative, highlight, narrative_through_event_id,
        fold_count, version, created_at, updated_at
      ) VALUES ('stable', '[T1] a [T2] b', 'h', 402, 1, 1, NOW(), NOW())
    `;
    const afterFold = await repository.loadUnfoldedSummaries("stable", 402, 10);
    // T3 still means row 403, both before and after the digest exists.
    expect(numbering(afterFold)).toEqual([[403, 3]]);

    // A live turn arrives and is folded again.
    await insertSummary("stable", { rowId: 404, turnStart: 40 });
    const afterLiveTurn = await repository.loadUnfoldedSummaries("stable", 402, 10);
    expect(numbering(afterLiveTurn)).toEqual([[403, 3], [404, 4]]);

    await sql`
      UPDATE session_digests
      SET narrative = '[T1] a [T2] b [T3] c [T4] d',
          narrative_through_event_id = 404, fold_count = 2, version = 2
      WHERE session_id = 'stable'
    `;
    // Second fold changes nothing about what T1..T4 refer to.
    const settled = await repository.loadTurnSummaryRange("stable", 1, null, 10);
    expect(numbering(settled)).toEqual([
      [401, 1],
      [402, 2],
      [403, 3],
      [404, 4],
    ]);
  });

  // Why sessions holding a newer summary are excluded from the backfill: a
  // logically earlier insert renumbers everything after it, which would change
  // what the markers already written into a narrative refer to.
  it("renumbers later turns when an earlier turn is inserted late", async () => {
    await seedSession("renumber");
    await insertSummary("renumber", { rowId: 501, turnStart: 10 });
    await insertSummary("renumber", { rowId: 502, turnStart: 30 });
    await expect(
      repository.loadTurnSummaryRange("renumber", 1, null, 10).then(numbering),
    ).resolves.toEqual([[501, 1], [502, 2]]);

    await insertSummary("renumber", { rowId: 503, turnStart: 20 });
    await expect(
      repository.loadTurnSummaryRange("renumber", 1, null, 10).then(numbering),
    ).resolves.toEqual([[501, 1], [503, 2], [502, 3]]);
  });

  async function seedSession(sessionId: string): Promise<void> {
    await sql`
      INSERT INTO sessions (session_id, status, session_type, created_at, updated_at)
      VALUES (${sessionId}, 'idle', 'claude', NOW(), NOW())
    `;
  }

  async function insertSummary(
    sessionId: string,
    turn: { rowId: number; turnStart: number },
  ): Promise<void> {
    await sql`
      INSERT INTO events (session_id, id, event_type, payload, created_at)
      VALUES (
        ${sessionId}, ${turn.rowId}, 'turn_summary',
        ${sql.json({
          type: "turn_summary",
          content: `summary-for-turn-${turn.turnStart}`,
          turn_start_event_id: turn.turnStart,
          final_response_event_id: turn.turnStart + 1,
        })}::jsonb,
        NOW()
      )
    `;
  }
});

function numbering(
  summaries: ReadonlyArray<{ eventId: number; turnNumber: number }>,
): Array<[number, number]> {
  return summaries.map((summary) => [summary.eventId, summary.turnNumber]);
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
    user: "fold_ordering_test",
    password: "fold_ordering_test",
    database: "fold_ordering_test_db",
  });
  const url =
    `postgres://fold_ordering_test:fold_ordering_test@127.0.0.1:${container.port}/fold_ordering_test_db`;
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
