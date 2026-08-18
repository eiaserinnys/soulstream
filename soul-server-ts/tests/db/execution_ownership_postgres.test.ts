import { spawnSync } from "node:child_process";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFullSchemaPostgresHarness,
  hasFullSchemaPostgresBackend,
  type FullSchemaPostgresHarness,
} from "./full_schema_postgres_harness.js";

const describePostgres = hasFullSchemaPostgresBackend || hasDockerBinary()
  ? describe
  : describe.skip;

describePostgres("execution ownership PostgreSQL contract", () => {
  let harness: FullSchemaPostgresHarness;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
  }, 45_000);

  beforeEach(async () => {
    await harness.sql`DELETE FROM session_execution_ownership_migration_audit`;
    await harness.sql`DELETE FROM session_execution_ownerships`;
    await harness.sql`DELETE FROM sessions`;
  });

  afterAll(async () => await harness.cleanup());

  it("activates initial, auto-resume, and adopt only after identity proof", async () => {
    await insertSession("initial", "initializing");
    expect((await reserve("initial", 1, "runner_process", "release-1"))[0]?.applied)
      .toBe(true);
    expect((await activate("initial", 1))[0]?.applied).toBe(false);
    expect(await prove("initial", 1, "registration-initial", "execute-initial"))
      .toBe(true);
    expect((await activate("initial", 1))[0]).toMatchObject({
      applied: true,
      status: "running",
    });

    await insertSession("resume", "completed", 42);
    await reserve("resume", 1, "runner_process", "release-1");
    await prove("resume", 1, "registration-resume", "execute-resume");
    expect((await activate("resume", 1, 42))[0]).toMatchObject({
      applied: true,
      status: "running",
      termination_event_id: null,
    });

    await insertSession("adopt", "initializing");
    await reserve("adopt", 1, "runner_process", "release-1");
    await prove("adopt", 1, "registration-adopt", "execute-adopt");
    await activate("adopt", 1);
    const adopted = await harness.sql<Array<{ applied: boolean }>>`
      SELECT * FROM session_reserve_execution_adoption(
        'adopt', 2, 'release-1', 'registration-adopt', 123,
        'start-registration-adopt', NOW()
      )
    `;
    expect(adopted[0]?.applied).toBe(true);
    await prove("adopt", 2, "registration-adopt", "execute-adopt");
    expect((await activate("adopt", 2))[0]?.applied).toBe(true);
    await expect(harness.sql<Array<{ ownership_generation: string | number }>>`
      SELECT ownership_generation FROM session_execution_ownerships
      WHERE session_id = 'adopt' AND phase = 'active'
    `).resolves.toEqual([{ ownership_generation: "2" }]);
  });

  it("maps all runner facts write-once and ignores a later same-owner close", async () => {
    const expected = {
      completed: "completed",
      failed: "error",
      reaped: "error",
      closed: "interrupted",
    } as const;
    let eventId = 100;
    for (const [fact, status] of Object.entries(expected)) {
      const sessionId = `fact-${fact}`;
      await insertSession(sessionId, "initializing");
      await reserve(sessionId, 1, "runner_process", "release-1");
      await prove(sessionId, 1, `registration-${fact}`, `execute-${fact}`);
      await activate(sessionId, 1);
      const projected = await projectFact(sessionId, fact, eventId++);
      expect(projected[0]).toMatchObject({ applied: true, status });
    }

    const duplicateClose = await projectFact("fact-completed", "closed", eventId);
    expect(duplicateClose[0]).toMatchObject({ applied: false, status: "completed" });
    await expect(harness.sql<Array<{ runner_fact: string }>>`
      SELECT runner_fact FROM session_execution_ownerships
      WHERE session_id = 'fact-completed' AND ownership_generation = 1
    `).resolves.toEqual([{ runner_fact: "completed" }]);
  });

  it("keeps the previous active owner until an adoption is fully activated", async () => {
    await insertSession("adopt-failure", "initializing");
    await reserve("adopt-failure", 1, "runner_process", "release-1");
    await prove("adopt-failure", 1, "registration-old", "execute-old");
    await activate("adopt-failure", 1);

    const reservation = await harness.sql<Array<{ applied: boolean }>>`
      SELECT * FROM session_reserve_execution_adoption(
        'adopt-failure', 2, 'release-1', 'registration-old', 123,
        'start-registration-old', NOW()
      )
    `;
    expect(reservation[0]?.applied).toBe(true);
    await expect(harness.sql<Array<{ ownership_generation: string; phase: string }>>`
      SELECT ownership_generation, phase FROM session_execution_ownerships
      WHERE session_id = 'adopt-failure'
      ORDER BY ownership_generation
    `).resolves.toEqual([
      { ownership_generation: "1", phase: "active" },
      { ownership_generation: "2", phase: "reserved" },
    ]);

    await harness.sql`
      SELECT session_fail_execution_ownership(
        'adopt-failure', 2, 'identity proof failed', NOW()
      )
    `;
    await expect(harness.sql<Array<{ ownership_generation: string; phase: string }>>`
      SELECT ownership_generation, phase FROM session_execution_ownerships
      WHERE session_id = 'adopt-failure'
      ORDER BY ownership_generation
    `).resolves.toEqual([
      { ownership_generation: "1", phase: "active" },
      { ownership_generation: "2", phase: "failed" },
    ]);
  });

  it("projects a recovered reaped fact only through the exact durable identity", async () => {
    await insertSession("recovered-reaped", "initializing");
    await reserve("recovered-reaped", 7, "runner_process", "release-1");
    await prove("recovered-reaped", 7, "registration-recovered", "execute-recovered");
    await activate("recovered-reaped", 7);

    const mismatch = await harness.sql<Array<{ applied: boolean; status: string }>>`
      SELECT * FROM session_project_recovered_runner_terminal_fact(
        'recovered-reaped', 'release-1', 'wrong-registration', 123,
        'start-registration-recovered', 'reaped', 'runner exited',
        'not_required', null, 199, NOW()
      )
    `;
    expect(mismatch[0]).toMatchObject({ applied: false, status: "running" });

    const projected = await harness.sql<Array<{ applied: boolean; status: string }>>`
      SELECT * FROM session_project_recovered_runner_terminal_fact(
        'recovered-reaped', 'release-1', 'registration-recovered', 123,
        'start-registration-recovered', 'reaped', 'runner exited',
        'not_required', null, 200, NOW()
      )
    `;
    expect(projected[0]).toMatchObject({ applied: true, status: "error" });
    await expect(harness.sql<Array<{ phase: string; runner_fact: string }>>`
      SELECT phase, runner_fact FROM session_execution_ownerships
      WHERE session_id = 'recovered-reaped' AND ownership_generation = 7
    `).resolves.toEqual([{ phase: "terminal", runner_fact: "reaped" }]);
  });

  it("backfills only a stable two-scan identity and interrupts the unproven row", async () => {
    await insertSession("stable-owner", "running");
    await insertSession("unknown-owner", "running");
    const first = new Date("2026-08-18T00:00:00.000Z");
    const second = new Date("2026-08-18T00:00:31.000Z");
    const stable = await harness.sql<Array<{ result: string }>>`
      SELECT session_backfill_execution_ownership(
        'stable-owner', 'release-1', 'registration-stable', 321,
        'start-stable', 'execute-stable', ${first}, ${second},
        INTERVAL '30 seconds'
      ) AS result
    `;
    expect(stable).toEqual([{ result: "backfilled" }]);
    const unknown = await harness.sql<Array<{ result: string }>>`
      SELECT session_backfill_execution_ownership(
        'unknown-owner', '', '', 0, '', '', ${first}, ${second},
        INTERVAL '30 seconds'
      ) AS result
    `;
    expect(unknown).toEqual([{ result: "interrupted" }]);
    await expect(harness.sql<Array<{ status: string }>>`
      SELECT status FROM sessions WHERE session_id = 'unknown-owner'
    `).resolves.toEqual([{ status: "interrupted" }]);
    await expect(harness.sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count FROM session_owner_null_running_inventory
    `).resolves.toEqual([{ count: 0 }]);
  });

  async function insertSession(
    sessionId: string,
    status: string,
    terminalEventId: number | null = null,
  ): Promise<void> {
    await harness.sql`
      INSERT INTO sessions (
        session_id, session_type, status, agent_id, termination_event_id
      ) VALUES (${sessionId}, 'claude', ${status}, 'worker', ${terminalEventId})
    `;
  }

  async function reserve(
    sessionId: string,
    generation: number,
    ownerKind: "runner_process" | "adopted_runner" | "in_process",
    manifestId: string,
  ) {
    return await harness.sql<Array<{ applied: boolean; status: string }>>`
      SELECT * FROM session_reserve_execution_ownership(
        ${sessionId}, ${generation}, ${ownerKind}, ${manifestId}, NOW()
      )
    `;
  }

  async function prove(
    sessionId: string,
    generation: number,
    registrationId: string,
    commandId: string,
  ): Promise<boolean> {
    const rows = await harness.sql<Array<{ applied: boolean }>>`
      SELECT session_prove_execution_ownership(
        ${sessionId}, ${generation}, ${registrationId}, 123,
        ${`start-${registrationId}`}, ${commandId}, NOW()
      ) AS applied
    `;
    return rows[0]?.applied === true;
  }

  async function activate(
    sessionId: string,
    generation: number,
    expectedTerminalEventId?: number,
  ) {
    return await harness.sql<Array<{
      applied: boolean;
      status: string;
      termination_event_id: number | null;
    }>>`
      SELECT * FROM session_activate_execution_ownership(
        ${sessionId}, ${generation}, 'not_required',
        ${expectedTerminalEventId ?? null},
        ${expectedTerminalEventId !== undefined}, NOW()
      )
    `;
  }

  async function projectFact(sessionId: string, fact: string, eventId: number) {
    return await harness.sql<Array<{ applied: boolean; status: string }>>`
      SELECT * FROM session_project_runner_terminal_fact(
        ${sessionId}, 1, ${fact}, null, 'not_required', null, ${eventId}, NOW()
      )
    `;
  }
});

function hasDockerBinary(): boolean {
  return spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
}
