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
    await harness.sql`DELETE FROM node_release_activation_receipts`;
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
        'start-registration-adopt', 'execute-adopt', NOW()
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

  it("stores runtime env identity through v2 while preserving the legacy ownership API", async () => {
    await insertSession("runtime-v2", "initializing");
    const reserved = await harness.sql<Array<{ applied: boolean }>>`
      SELECT * FROM session_reserve_execution_ownership_v2(
        'runtime-v2', 1, 'runner_process', 'manifest-a',
        'runtime-env-a', NOW()
      )
    `;
    expect(reserved[0]?.applied).toBe(true);
    await prove("runtime-v2", 1, "registration-v2", "execute-v2");
    await activate("runtime-v2", 1);
    const adopted = await harness.sql<Array<{ applied: boolean }>>`
      SELECT * FROM session_reserve_execution_adoption_v2(
        'runtime-v2', 2, 'manifest-a', 'runtime-env-a',
        'registration-v2', 123, 'start-registration-v2', 'execute-v2', NOW()
      )
    `;
    expect(adopted[0]?.applied).toBe(true);
    await expect(harness.sql<Array<{
      ownership_generation: string;
      runtime_env_identity: string;
    }>>`
      SELECT ownership_generation, runtime_env_identity
      FROM session_execution_ownerships
      WHERE session_id = 'runtime-v2'
      ORDER BY ownership_generation
    `).resolves.toEqual([
      { ownership_generation: "1", runtime_env_identity: "runtime-env-a" },
      { ownership_generation: "2", runtime_env_identity: "runtime-env-a" },
    ]);

    await insertSession("runtime-legacy", "initializing");
    expect((await reserve("runtime-legacy", 1, "runner_process", "manifest-legacy"))[0]?.applied)
      .toBe(true);
    await expect(harness.sql<Array<{ runtime_env_identity: string | null }>>`
      SELECT runtime_env_identity
      FROM session_execution_ownerships
      WHERE session_id = 'runtime-legacy'
    `).resolves.toEqual([{ runtime_env_identity: null }]);

    await insertSession("runtime-empty", "initializing");
    await expect(harness.sql`
      SELECT * FROM session_reserve_execution_ownership_v2(
        'runtime-empty', 1, 'runner_process', 'manifest-a', '', NOW()
      )
    `).rejects.toThrow("runtime env identity required");
  });

  it("persists one immutable central activation receipt per registration attempt", async () => {
    const verification = {
      host: "verified",
      runner: "verified",
      env: "verified",
      executable: "verified",
    };
    const persist = async (manifestId: string) => await harness.sql<Array<{
      activation_generation: string;
      manifest_id: string;
    }>>`
      INSERT INTO node_release_activation_receipts (
        node_id, manifest_id, release_cohort_id, source_commit, prewarmed_at,
        verification, registration_idempotency_key
      ) VALUES (
        'node-a', ${manifestId}, 'cohort-a', 'commit-a',
        ${new Date("2026-08-19T09:00:00.000Z")},
        ${harness.sql.json(verification)}, 'registration-key'
      )
      ON CONFLICT (node_id, registration_idempotency_key)
      DO UPDATE SET registration_idempotency_key = EXCLUDED.registration_idempotency_key
      WHERE node_release_activation_receipts.manifest_id = EXCLUDED.manifest_id
        AND node_release_activation_receipts.release_cohort_id = EXCLUDED.release_cohort_id
        AND node_release_activation_receipts.source_commit = EXCLUDED.source_commit
        AND node_release_activation_receipts.prewarmed_at = EXCLUDED.prewarmed_at
        AND node_release_activation_receipts.verification = EXCLUDED.verification
      RETURNING activation_generation, manifest_id
    `;

    const first = await persist("manifest-a");
    expect(first).toEqual([{
      activation_generation: expect.any(String),
      manifest_id: "manifest-a",
    }]);
    expect(await persist("manifest-a")).toEqual(first);
    expect(await persist("manifest-other")).toEqual([]);
    await expect(harness.sql`
      INSERT INTO node_release_activation_receipts (
        node_id, manifest_id, release_cohort_id, source_commit, prewarmed_at,
        verification, registration_idempotency_key
      ) VALUES (
        'node-b', 'manifest-a', 'cohort-a', 'commit-a', NOW(),
        ${harness.sql.json({ ...verification, runner: "unchecked" })},
        'registration-invalid'
      )
    `).rejects.toThrow(/node_release_activation_receipts_verification_check/);
  });

  it("covers runner fact 4종 × existing central state 4종 and command fencing", async () => {
    const factStatus = {
      completed: "completed",
      failed: "error",
      reaped: "error",
      closed: "interrupted",
    } as const;
    const centralStatuses = ["running", "completed", "error", "interrupted"] as const;
    let eventId = 100;
    for (const [fact, projectedStatus] of Object.entries(factStatus)) {
      for (const centralStatus of centralStatuses) {
        const sessionId = `fact-${fact}-${centralStatus}`;
        const commandId = `execute-${fact}-${centralStatus}`;
        await insertSession(sessionId, "initializing");
        await reserve(sessionId, 1, "runner_process", "release-1");
        await prove(sessionId, 1, `registration-${fact}-${centralStatus}`, commandId);
        await activate(sessionId, 1);
        if (centralStatus !== "running") {
          await harness.sql`
            UPDATE sessions
            SET status = ${centralStatus}, termination_event_id = ${eventId + 10_000}
            WHERE session_id = ${sessionId}
          `;
        }
        const projected = await projectFact(sessionId, commandId, fact, eventId++);
        expect(projected[0]).toMatchObject({
          applied: centralStatus === "running",
          status: centralStatus === "running" ? projectedStatus : centralStatus,
        });
        await expect(harness.sql<Array<{ phase: string; runner_fact: string }>>`
          SELECT phase, runner_fact
          FROM session_execution_ownerships
          WHERE session_id = ${sessionId} AND ownership_generation = 1
        `).resolves.toEqual([{ phase: "terminal", runner_fact: fact }]);
      }
    }

    const duplicateClose = await projectFact(
      "fact-completed-running",
      "execute-completed-running",
      "closed",
      eventId,
    );
    expect(duplicateClose[0]).toMatchObject({ applied: false, status: "completed" });

    await insertSession("fact-command-fence", "initializing");
    await reserve("fact-command-fence", 1, "runner_process", "release-1");
    await prove("fact-command-fence", 1, "registration-command", "execute-command");
    await activate("fact-command-fence", 1);
    await expect(projectFact(
      "fact-command-fence",
      "execute-stale",
      "completed",
      eventId + 1,
    )).resolves.toMatchObject([{ applied: false, status: "running" }]);
    await expect(harness.sql<Array<{ phase: string }>>`
      SELECT phase FROM session_execution_ownerships
      WHERE session_id = 'fact-command-fence' AND ownership_generation = 1
    `).resolves.toEqual([{ phase: "active" }]);
  });

  it("locks the e5d01ad7 closed and c643e966 reaped recovery regressions", async () => {
    await insertSession("e5d01ad7-regression", "completed", 348);
    await reserve("e5d01ad7-regression", 1, "runner_process", "release-1");
    await prove(
      "e5d01ad7-regression",
      1,
      "registration-e5d01ad7",
      "execute-e5d01ad7",
    );
    await harness.sql`
      UPDATE session_execution_ownerships
      SET phase = 'active'
      WHERE session_id = 'e5d01ad7-regression' AND ownership_generation = 1
    `;
    await expect(harness.sql<Array<{ applied: boolean; status: string }>>`
      SELECT * FROM session_project_recovered_runner_terminal_fact(
        'e5d01ad7-regression', 'release-1', 'registration-e5d01ad7', 123,
        'start-registration-e5d01ad7', 'execute-e5d01ad7', 'closed', NULL,
        'not_required', NULL, 349, NOW()
      )
    `).resolves.toEqual([
      expect.objectContaining({ applied: false, status: "completed" }),
    ]);

    await insertSession("c643e966-regression", "initializing");
    await reserve("c643e966-regression", 1, "runner_process", "release-1");
    await prove(
      "c643e966-regression",
      1,
      "registration-c643e966",
      "execute-c643e966",
    );
    await activate("c643e966-regression", 1);
    await expect(harness.sql<Array<{ applied: boolean; status: string }>>`
      SELECT * FROM session_project_recovered_runner_terminal_fact(
        'c643e966-regression', 'release-1', 'registration-c643e966', 123,
        'start-registration-c643e966', 'execute-c643e966', 'reaped',
        'runner_exited', 'not_required', NULL, 200, NOW()
      )
    `).resolves.toEqual([
      expect.objectContaining({ applied: true, status: "error" }),
    ]);
  });

  it("keeps the previous active owner until an adoption is fully activated", async () => {
    await insertSession("adopt-failure", "initializing");
    await reserve("adopt-failure", 1, "runner_process", "release-1");
    await prove("adopt-failure", 1, "registration-old", "execute-old");
    await activate("adopt-failure", 1);

    const reservation = await harness.sql<Array<{ applied: boolean }>>`
      SELECT * FROM session_reserve_execution_adoption(
        'adopt-failure', 2, 'release-1', 'registration-old', 123,
        'start-registration-old', 'execute-old', NOW()
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
        'start-registration-recovered', 'execute-recovered', 'reaped', 'runner exited',
        'not_required', null, 199, NOW()
      )
    `;
    expect(mismatch[0]).toMatchObject({ applied: false, status: "running" });

    const projected = await harness.sql<Array<{ applied: boolean; status: string }>>`
      SELECT * FROM session_project_recovered_runner_terminal_fact(
        'recovered-reaped', 'release-1', 'registration-recovered', 123,
        'start-registration-recovered', 'execute-recovered', 'reaped', 'runner exited',
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
    const evidenceHash = "a".repeat(64);
    const stable = await harness.sql<Array<{ result: string }>>`
      SELECT session_backfill_execution_ownership(
        'stable-owner', 'release-1', 'registration-stable', 321,
        'start-stable', 'execute-stable', ${first},
        'release-1', 'registration-stable', 321,
        'start-stable', 'execute-stable', ${second},
        ${evidenceHash}, 30000, false
      ) AS result
    `;
    expect(stable).toEqual([{ result: "backfilled" }]);
    const unknown = await harness.sql<Array<{ result: string }>>`
      SELECT session_backfill_execution_ownership(
        'unknown-owner', 'release-1', 'registration-a', 321,
        'start-a', 'execute-a', ${first},
        'release-1', 'registration-b', 321,
        'start-a', 'execute-a', ${second},
        ${"b".repeat(64)}, 30000, false
      ) AS result
    `;
    expect(unknown).toEqual([{ result: "interrupted" }]);
    await expect(harness.sql<Array<{ status: string }>>`
      SELECT status FROM sessions WHERE session_id = 'unknown-owner'
    `).resolves.toEqual([{ status: "interrupted" }]);
    await expect(harness.sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count FROM session_owner_null_running_inventory
    `).resolves.toEqual([{ count: 0 }]);
    await expect(harness.sql<Array<{
      execution_command_id: string;
      evidence_hash: string;
      first_registration_id: string;
      second_registration_id: string;
    }>>`
      SELECT execution_command_id, evidence_hash,
             first_observation->>'registration_id' AS first_registration_id,
             second_observation->>'registration_id' AS second_registration_id
      FROM session_execution_ownership_migration_audit
      WHERE session_id = 'unknown-owner'
    `).resolves.toEqual([{
      execution_command_id: "execute-a",
      evidence_hash: "b".repeat(64),
      first_registration_id: "registration-a",
      second_registration_id: "registration-b",
    }]);
  });

  it("expires orphan reservations and returns one active-first conflict row", async () => {
    await insertSession("lease-recovery", "initializing");
    await reserve("lease-recovery", 1, "runner_process", "release-1");
    await harness.sql`
      UPDATE session_execution_ownerships
      SET reservation_expires_at = NOW() - INTERVAL '1 second'
      WHERE session_id = 'lease-recovery' AND ownership_generation = 1
    `;
    expect((await reserve("lease-recovery", 2, "runner_process", "release-1"))[0])
      .toMatchObject({ applied: true, ownership_generation: "2" });
    await prove("lease-recovery", 2, "registration-active", "execute-active");
    await activate("lease-recovery", 2);

    const firstAdoption = await harness.sql<Array<{ applied: boolean }>>`
      SELECT * FROM session_reserve_execution_adoption(
        'lease-recovery', 3, 'release-1', 'registration-active', 123,
        'start-registration-active', 'execute-active', NOW()
      )
    `;
    expect(firstAdoption).toHaveLength(1);
    expect(firstAdoption[0]?.applied).toBe(true);
    const conflict = await harness.sql<Array<{
      applied: boolean;
      status: string;
    }>>`
      SELECT * FROM session_reserve_execution_ownership(
        'lease-recovery', 4, 'runner_process', 'release-1', NOW()
      )
    `;
    expect(conflict).toEqual([{
      applied: false,
      ownership_generation: "2",
      status: "running",
      termination_reason: null,
      termination_detail: null,
      review_state: "not_required",
      last_assistant_text: null,
      termination_event_id: null,
      updated_at: expect.any(Date),
      last_event_id: null,
    }]);
    await expect(harness.sql<Array<{ generation: string; phase: string }>>`
      SELECT ownership_generation AS generation, phase
      FROM session_execution_ownerships
      WHERE session_id = 'lease-recovery'
      ORDER BY ownership_generation
    `).resolves.toEqual([
      { generation: "1", phase: "failed" },
      { generation: "2", phase: "active" },
      { generation: "3", phase: "reserved" },
    ]);
  });

  it("keeps a slow proof alive by refreshing the 60-second crash lease", async () => {
    await insertSession("slow-proof", "initializing");
    const reservedAt = new Date("2026-08-19T00:00:00.000Z");
    const provenAt = new Date("2026-08-19T00:00:59.000Z");
    const initial = await harness.sql<Array<{ applied: boolean }>>`
      SELECT * FROM session_reserve_execution_ownership(
        'slow-proof', 1, 'runner_process', 'release-slow', ${reservedAt}
      )
    `;
    expect(initial[0]?.applied).toBe(true);
    await expect(harness.sql<Array<{ reservation_expires_at: Date }>>`
      SELECT reservation_expires_at
      FROM session_execution_ownerships
      WHERE session_id = 'slow-proof' AND ownership_generation = 1
    `).resolves.toEqual([{
      reservation_expires_at: new Date("2026-08-19T00:01:00.000Z"),
    }]);

    const proof = await harness.sql<Array<{ applied: boolean }>>`
      SELECT session_prove_execution_ownership(
        'slow-proof', 1, 'registration-slow', 123, 'start-registration-slow',
        'execute-slow', ${provenAt}
      ) AS applied
    `;
    expect(proof).toEqual([{ applied: true }]);
    await expect(harness.sql<Array<{ reservation_expires_at: Date }>>`
      SELECT reservation_expires_at
      FROM session_execution_ownerships
      WHERE session_id = 'slow-proof' AND ownership_generation = 1
    `).resolves.toEqual([{
      reservation_expires_at: new Date("2026-08-19T00:01:59.000Z"),
    }]);

    const whileProving = await harness.sql<Array<{ applied: boolean }>>`
      SELECT * FROM session_reserve_execution_ownership(
        'slow-proof', 2, 'runner_process', 'release-slow',
        ${new Date("2026-08-19T00:01:01.000Z")}
      )
    `;
    expect(whileProving[0]?.applied).toBe(false);
    const afterCrashLease = await harness.sql<Array<{ applied: boolean }>>`
      SELECT * FROM session_reserve_execution_ownership(
        'slow-proof', 3, 'runner_process', 'release-slow',
        ${new Date("2026-08-19T00:02:00.000Z")}
      )
    `;
    expect(afterCrashLease[0]?.applied).toBe(true);
  });

  it("admits exactly one ownership generation under concurrent attach and recovery reserve", async () => {
    await insertSession("concurrent-owner", "initializing");
    const recoveryPeer = harness.createPeer();

    const results = await Promise.all([
      reserve("concurrent-owner", 101, "runner_process", "release-a"),
      recoveryPeer<Array<{ applied: boolean; status: string }>>`
        SELECT * FROM session_reserve_execution_ownership(
          'concurrent-owner', 102, 'adopted_runner', 'release-a', NOW()
        )
      `,
    ]);

    expect(results.flat().filter((result) => result.applied)).toHaveLength(1);
    await expect(harness.sql<Array<{ generation: string; phase: string }>>`
      SELECT ownership_generation AS generation, phase
      FROM session_execution_ownerships
      WHERE session_id = 'concurrent-owner'
    `).resolves.toEqual([{
      generation: expect.stringMatching(/^10[12]$/),
      phase: "reserved",
    }]);
  });

  it("hands an identity-fenced orphaned_spawn reservation to recovery adoption", async () => {
    await insertSession("orphaned-spawn", "initializing");
    await reserve("orphaned-spawn", 201, "runner_process", "release-a");
    await expect(harness.sql<Array<{ applied: boolean }>>`
      SELECT session_mark_execution_orphaned_spawn(
        'orphaned-spawn', 201, 'registration-orphan', 7201,
        'start-7201', 'execute-orphan', NOW()
      ) AS applied
    `).resolves.toEqual([{ applied: true }]);

    const adoption = await harness.sql<Array<{ applied: boolean }>>`
      SELECT * FROM session_reserve_execution_adoption(
        'orphaned-spawn', 202, 'release-a', 'registration-orphan', 7201,
        'start-7201', 'execute-orphan', NOW()
      )
    `;
    expect(adoption[0]?.applied).toBe(true);
    await expect(harness.sql<Array<{ applied: boolean }>>`
      SELECT session_prove_execution_ownership(
        'orphaned-spawn', 202, 'registration-orphan', 7201,
        'start-7201', 'execute-orphan', NOW()
      ) AS applied
    `).resolves.toEqual([{ applied: true }]);
    expect((await activate("orphaned-spawn", 202))[0]?.applied).toBe(true);

    await expect(harness.sql<Array<{
      generation: string;
      phase: string;
      failure_reason: string | null;
    }>>`
      SELECT ownership_generation AS generation, phase, failure_reason
      FROM session_execution_ownerships
      WHERE session_id = 'orphaned-spawn'
      ORDER BY ownership_generation
    `).resolves.toEqual([
      { generation: "201", phase: "terminal", failure_reason: "ownership handed to adopting host" },
      { generation: "202", phase: "active", failure_reason: null },
    ]);
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

  async function projectFact(
    sessionId: string,
    commandId: string,
    fact: string,
    eventId: number,
  ) {
    return await harness.sql<Array<{ applied: boolean; status: string }>>`
      SELECT * FROM session_project_runner_terminal_fact(
        ${sessionId}, 1, ${commandId}, ${fact}, null,
        'not_required', null, ${eventId}, NOW()
      )
    `;
  }
});

function hasDockerBinary(): boolean {
  return spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
}
