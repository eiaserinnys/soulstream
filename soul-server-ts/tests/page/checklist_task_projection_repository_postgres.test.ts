import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ChecklistTaskProjectionRepository } from "../../src/page/checklist_task_projection_repository.js";
import {
  createTaskPostgresHarness,
  hasTaskPostgresBackend,
  resetTaskData,
  type TaskPostgresHarness,
} from "../work-task/task_postgres_harness.js";

const describePostgres = hasTaskPostgresBackend ? describe : describe.skip;

describePostgres("ChecklistTaskProjectionRepository PostgreSQL integration", () => {
  let harness: TaskPostgresHarness | undefined;

  beforeAll(async () => {
    harness = await createTaskPostgresHarness();
  }, 45_000);

  beforeEach(async () => {
    await resetTaskData(harness!.sql);
    await harness!.sql`
      INSERT INTO pages (id, title, version)
      VALUES ('page-1', 'Page', 1)
    `;
  });

  afterAll(async () => {
    await harness?.cleanup();
  }, 15_000);

  it("retains a failed lease across repository restart and replays exactly once", async () => {
    await insertPending("block-1", "source-1");
    let now = new Date("2030-07-13T00:00:00.000Z");
    const firstProcess = new ChecklistTaskProjectionRepository(
      harness!.sql,
      () => now,
    );

    const [claimed] = await firstProcess.claimDue("node-1");
    expect(claimed).toMatchObject({
      block_id: "block-1",
      source_hash: "source-1",
      routing_session_id: "sess-actor",
      attempts: 0,
    });
    await firstProcess.markFailure(claimed!, "node-1", "temporary failure");
    const [failed] = await harness!.sql<Array<{
      attempts: number;
      last_error: string | null;
      processed_hash: string | null;
      lease_owner_node_id: string | null;
    }>>`
      SELECT attempts, last_error, processed_hash, lease_owner_node_id
      FROM checklist_task_projection_outbox
      WHERE block_id = 'block-1'
    `;
    expect(failed).toEqual({
      attempts: 1,
      last_error: "temporary failure",
      processed_hash: null,
      lease_owner_node_id: null,
    });

    now = new Date("2030-07-13T00:00:03.000Z");
    const restartedProcess = new ChecklistTaskProjectionRepository(
      harness!.sql,
      () => now,
    );
    const [replayed] = await restartedProcess.claimDue("node-1");
    expect(replayed).toMatchObject({ block_id: "block-1", attempts: 1 });
    await expect(restartedProcess.markSuccess(replayed!, "node-1")).resolves.toBe(true);
    await expect(restartedProcess.claimDue("node-1")).resolves.toEqual([]);
  });

  it("uses SKIP LOCKED leases and rejects stale success after newer page input", async () => {
    await insertPending("block-concurrent", "source-old");
    const now = new Date("2030-07-13T00:00:00.000Z");
    const left = new ChecklistTaskProjectionRepository(harness!.sql, () => now);
    const right = new ChecklistTaskProjectionRepository(harness!.sql, () => now);

    const [leftRows, rightRows] = await Promise.all([
      left.claimDue("node-1"),
      right.claimDue("node-1"),
    ]);
    expect([...leftRows, ...rightRows]).toHaveLength(1);
    const claimed = [...leftRows, ...rightRows][0]!;

    await harness!.sql`
      UPDATE checklist_task_projection_outbox
      SET source_hash = 'source-new',
          lease_owner_node_id = NULL,
          lease_expires_at = NULL,
          updated_at = NOW()
      WHERE block_id = 'block-concurrent'
    `;
    await expect(left.markSuccess(claimed, "node-1")).resolves.toBe(false);
    const [pending] = await harness!.sql<Array<{
      source_hash: string;
      processed_hash: string | null;
    }>>`
      SELECT source_hash, processed_hash
      FROM checklist_task_projection_outbox
      WHERE block_id = 'block-concurrent'
    `;
    expect(pending).toEqual({ source_hash: "source-new", processed_hash: null });
  });

  async function insertPending(blockId: string, sourceHash: string): Promise<void> {
    await harness!.sql`
      INSERT INTO checklist_task_projection_outbox (
        block_id, page_id, source_hash,
        actor_kind, actor_session_id, next_retry_at
      ) VALUES (
        ${blockId}, 'page-1', ${sourceHash},
        'agent', 'sess-actor', NOW()
      )
    `;
  }
});
