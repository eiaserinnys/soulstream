import { spawnSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SessionMutationRepository } from
  "../../../orch-server-ts/src/control_plane/repositories/session_mutation_repository.js";
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

  it("restores only receipt-free disconnect interruptions during node startup", async () => {
    const interruptedAt = new Date("2026-08-28T17:18:03.000Z");
    const startupAt = new Date("2026-08-28T22:08:37.947Z");
    await harness.sql`
      INSERT INTO sessions (
        session_id, node_id, session_type, status, agent_id,
        termination_reason, termination_detail, termination_event_id,
        last_event_id, was_running_at_shutdown, updated_at
      ) VALUES
        (
          'terminal-receipt-at-startup', 'node-startup', 'codex', 'interrupted', 'worker',
          'unknown',
          'owner-null running migration could not prove a stable runner identity',
          531, 531, TRUE, ${interruptedAt}
        ),
        (
          'disconnect-without-receipt', 'node-startup', 'codex', 'interrupted', 'worker',
          'killed', 'node_disconnect', NULL, NULL, TRUE, ${interruptedAt}
        )
    `;
    await harness.sql`
      INSERT INTO events (session_id, id, event_type, payload, created_at)
      VALUES (
        'terminal-receipt-at-startup', 531, 'session_ended',
        jsonb_build_object(
          'type', 'session_ended',
          'status', 'interrupted',
          'termination_reason', 'unknown',
          'termination_detail',
          'owner-null running migration could not prove a stable runner identity'
        ),
        ${interruptedAt}
      )
    `;

    const repository = new SessionMutationRepository(harness.sql as never);
    await expect(repository.reconcileNodeStartup(
      "node-startup",
      ["terminal-receipt-at-startup", "disconnect-without-receipt"],
      startupAt,
    )).resolves.toMatchObject({
      interrupted: 0,
      restored: 1,
      updates: [expect.objectContaining({
        sessionId: "disconnect-without-receipt",
        status: "running",
      })],
    });

    await expect(harness.sql`
      SELECT session_id, status, termination_reason, termination_detail,
             termination_event_id, was_running_at_shutdown
      FROM sessions
      WHERE session_id IN (
        'terminal-receipt-at-startup', 'disconnect-without-receipt'
      )
      ORDER BY session_id
    `).resolves.toEqual([
      {
        session_id: "disconnect-without-receipt",
        status: "running",
        termination_reason: null,
        termination_detail: null,
        termination_event_id: null,
        was_running_at_shutdown: false,
      },
      {
        session_id: "terminal-receipt-at-startup",
        status: "interrupted",
        termination_reason: "unknown",
        termination_detail:
          "owner-null running migration could not prove a stable runner identity",
        termination_event_id: 531,
        was_running_at_shutdown: true,
      },
    ]);
  });
});

function hasDockerBinary(): boolean {
  return spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
}
