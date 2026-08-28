import { spawnSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createFullSchemaPostgresHarness,
  hasFullSchemaPostgresBackend,
  type FullSchemaPostgresHarness,
} from "./full_schema_postgres_harness.js";

const describePostgres =
  hasFullSchemaPostgresBackend || hasDockerBinary() ? describe : describe.skip;

describePostgres("terminal receipt running-transition fence", () => {
  let harness: FullSchemaPostgresHarness;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
  }, 45_000);

  afterAll(async () => {
    await harness.cleanup();
  });

  it("does not revive an interrupted session through a non-terminal resume", async () => {
    await harness.sql`
      INSERT INTO sessions (
        session_id,
        session_type,
        status,
        agent_id,
        termination_reason,
        termination_detail,
        termination_event_id,
        last_event_id
      ) VALUES (
        'interrupted-with-receipt',
        'codex',
        'interrupted',
        'worker',
        'unknown',
        'owner-null running migration could not prove a stable runner identity',
        531,
        531
      )
    `;

    const application = await harness.sql<Array<{
      applied: boolean;
      status: string;
      termination_reason: string | null;
      termination_detail: string | null;
      termination_event_id: number | null;
    }>>`
      SELECT * FROM session_apply_running_transition(
        'interrupted-with-receipt',
        'not_required',
        NULL,
        FALSE,
        NOW()
      )
    `;

    expect(application).toEqual([expect.objectContaining({
      applied: false,
      status: "interrupted",
      termination_reason: "unknown",
      termination_detail:
        "owner-null running migration could not prove a stable runner identity",
      termination_event_id: 531,
    })]);
  });
});

function hasDockerBinary(): boolean {
  return spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
}
