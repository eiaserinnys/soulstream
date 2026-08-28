import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
    const migration = readFileSync(fileURLToPath(new URL(
      "../../../packages/db-schema/sql/migrations/079_terminal_status_single_canon.sql",
      import.meta.url,
    )), "utf8");
    await harness.sql.unsafe(migration);
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

  it("projects a runner terminal fact through the sessions-row owner", async () => {
    await harness.sql`
      INSERT INTO sessions (
        session_id,
        session_type,
        status,
        agent_id,
        execution_generation,
        execution_manifest_id,
        execution_runtime_env_identity,
        execution_registration_id,
        execution_pid,
        execution_start_identity,
        execution_command_id,
        execution_lease_expires_at
      ) VALUES (
        'sessions-row-owner',
        'codex',
        'running',
        'worker',
        1,
        'manifest-1',
        'runtime-1',
        'registration-1',
        123,
        'start-1',
        'command-1',
        NOW() + INTERVAL '1 minute'
      )
    `;

    const application = await harness.sql<Array<{
      applied: boolean;
      status: string;
      termination_event_id: number | null;
    }>>`
      SELECT * FROM session_project_runner_terminal_fact(
        'sessions-row-owner',
        1,
        'command-1',
        'closed',
        'runner closed',
        'not_required',
        NULL,
        532,
        NOW()
      )
    `;

    expect(application).toEqual([expect.objectContaining({
      applied: true,
      status: "interrupted",
      termination_event_id: 532,
    })]);
    await expect(harness.sql`
      SELECT execution_manifest_id,
             execution_runtime_env_identity,
             execution_registration_id,
             execution_pid,
             execution_start_identity,
             execution_command_id,
             execution_lease_expires_at
      FROM sessions
      WHERE session_id = 'sessions-row-owner'
    `).resolves.toEqual([{
      execution_manifest_id: null,
      execution_runtime_env_identity: null,
      execution_registration_id: null,
      execution_pid: null,
      execution_start_identity: null,
      execution_command_id: null,
      execution_lease_expires_at: null,
    }]);
  });
});

function hasDockerBinary(): boolean {
  return spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
}
