import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TaskLifecycleTransition } from
  "../../src/task/task_lifecycle_transition.js";
import { hydrateEvictedTaskFromSessionRow } from
  "../../src/task/task_evicted_hydration.js";
import {
  createFullSchemaPostgresHarness,
  type FullSchemaPostgresHarness,
} from "../db/full_schema_postgres_harness.js";
import { OwnerlessIngressHarness } from
  "./ownerless_running_ingress_harness.js";
import { OWNERLESS_NODE_ID } from
  "./ownerless_running_reconciliation_fixture.js";

const logger = pino({ level: "silent" });
const SESSION_ID = "w3-execution-registration-projection";
const REGISTRATION_ID = "registration-w3";
const EXECUTION_COMMAND_ID = "command-w3";

const RETIRED_DATABASE_IDENTIFIERS = [
  "execution_manifest_id",
  "execution_runtime_env_identity",
  "execution_pid",
  "execution_start_identity",
  "execution_lease_expires_at",
  "session_acquire_execution_ownership",
  "session_activate_execution_ownership",
  "session_backfill_execution_ownership",
  "session_backfill_execution_ownership_v2",
  "session_expire_dead_execution_owner",
  "session_fail_execution_ownership",
  "session_mark_execution_orphaned_spawn",
  "session_project_recovered_runner_terminal_fact",
  "session_project_runner_terminal_fact",
  "session_prove_execution_ownership",
  "session_reconcile_recorded_runner_terminal_fact",
  "session_release_execution_ownership",
  "session_renew_execution_ownership",
  "session_reserve_execution_adoption",
  "session_reserve_execution_adoption_v2",
  "session_reserve_execution_ownership",
  "session_reserve_execution_ownership_v2",
  "session_retire_recorded_terminal_execution_identity",
  "session_retire_terminal_execution_ownership",
] as const;

function readTypeScriptSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return readTypeScriptSources(path);
    return entry.isFile() && entry.name.endsWith(".ts")
      ? [readFileSync(path, "utf8")]
      : [];
  });
}

describe("Wave 3 execution registration projection", () => {
  let postgres: FullSchemaPostgresHarness;
  let ingress: OwnerlessIngressHarness;

  beforeAll(async () => {
    postgres = await createFullSchemaPostgresHarness();
    ingress = await OwnerlessIngressHarness.create(postgres);
  }, 45_000);

  afterAll(async () => {
    await ingress.cleanup();
    await postgres.cleanup();
  });

  it("R1 keeps retired PostgreSQL projection callers at zero", () => {
    const sources = [
      new URL("../../src/", import.meta.url),
      new URL("../../../orch-server-ts/src/", import.meta.url),
    ].flatMap((url) => readTypeScriptSources(fileURLToPath(url)));

    const referencedIdentifiers = RETIRED_DATABASE_IDENTIFIERS.filter(
      (identifier) => sources.some((source) => source.includes(identifier)),
    );
    expect(referencedIdentifiers).toEqual([]);
  });

  it("R2 uses the fresh post-085b schema to record, fence, hydrate, and clear a registration", async () => {
    await postgres.sql`
      INSERT INTO sessions (
        session_id, session_type, status, agent_id, node_id, review_state,
        termination_reason, termination_detail, termination_event_id, last_event_id
      ) VALUES (
        ${SESSION_ID}, 'codex', 'initializing', 'agent-w3',
        ${OWNERLESS_NODE_ID}, 'not_required', NULL, NULL, NULL, 0
      )
    `;

    const registrationApplication = await ingress.commitDirectRegistration(
      SESSION_ID,
      REGISTRATION_ID,
      EXECUTION_COMMAND_ID,
      new Date(),
    );
    expect(registrationApplication.applied).toBe(true);
    expect((registrationApplication as unknown as {
      canonicalExecutionRegistration?: unknown;
    }).canonicalExecutionRegistration).toEqual({
      registration_id: REGISTRATION_ID,
      execution_command_id: EXECUTION_COMMAND_ID,
    });

    const [registeredRow] = await postgres.sql<Array<Record<string, unknown>>>`
      SELECT * FROM sessions WHERE session_id = ${SESSION_ID}
    `;
    const task = hydrateEvictedTaskFromSessionRow(registeredRow as never, logger);
    expect((task as unknown as { executionRegistration?: unknown })
      ?.executionRegistration).toEqual({
      registrationId: REGISTRATION_ID,
      executionCommandId: EXECUTION_COMMAND_ID,
    });

    const lifecycle = new TaskLifecycleTransition({
      logger,
      persistence: ingress.persistence,
    });
    lifecycle.applyRunnerTerminalFact(task!, "completed", null);
    const terminal = await lifecycle.persistExecutorFinalState(task!, true);
    expect(terminal.terminalTransitionApplied).toBe(true);

    const [terminalRow] = await postgres.sql<Array<{
      status: string;
      execution_registration_id: string | null;
      execution_command_id: string | null;
    }>>`
      SELECT status, execution_registration_id, execution_command_id
      FROM sessions
      WHERE session_id = ${SESSION_ID}
    `;
    expect(terminalRow).toEqual({
      status: "completed",
      execution_registration_id: null,
      execution_command_id: null,
    });
  });

  it("085a compatibility clears the legacy identity and 085b converges terminal writes to two columns", async () => {
    await postgres.sql.unsafe(`
      ALTER TABLE sessions
        ADD COLUMN execution_manifest_id TEXT,
        ADD COLUMN execution_runtime_env_identity TEXT,
        ADD COLUMN execution_pid INTEGER,
        ADD COLUMN execution_start_identity TEXT,
        ADD COLUMN execution_lease_expires_at TIMESTAMPTZ,
        ADD CONSTRAINT sessions_execution_owner_all_or_none_check CHECK (
          (
            execution_manifest_id IS NULL
            AND execution_runtime_env_identity IS NULL
            AND execution_registration_id IS NULL
            AND execution_pid IS NULL
            AND execution_start_identity IS NULL
            AND execution_command_id IS NULL
            AND execution_lease_expires_at IS NULL
          ) OR (
            execution_manifest_id IS NOT NULL
            AND execution_runtime_env_identity IS NOT NULL
            AND execution_registration_id IS NOT NULL
            AND execution_pid IS NOT NULL
            AND execution_start_identity IS NOT NULL
            AND execution_command_id IS NOT NULL
            AND execution_lease_expires_at IS NOT NULL
          )
        )
    `);
    const compatibilityMigration = readFileSync(fileURLToPath(new URL(
      "../../../packages/db-schema/sql/migrations/085a_execution_registration_projection.sql",
      import.meta.url,
    )), "utf8");
    await postgres.sql.unsafe(compatibilityMigration);
    await postgres.sql`
      INSERT INTO sessions (
        session_id, session_type, status, agent_id, node_id, review_state,
        execution_manifest_id, execution_runtime_env_identity,
        execution_registration_id, execution_pid, execution_start_identity,
        execution_command_id, execution_lease_expires_at
      ) VALUES (
        'w3-previous-release-terminal', 'codex', 'running', 'agent-w3',
        ${OWNERLESS_NODE_ID}, 'not_required', 'manifest-old', 'runtime-old',
        'registration-old', 4815, 'start-old', 'command-old', NOW()
      )
    `;

    const application = await postgres.sql<Array<{ applied: boolean }>>`
      SELECT applied
      FROM session_apply_terminal_transition(
        'w3-previous-release-terminal', 'completed', 'completed_ok', NULL,
        'not_required', NULL, 4815, NOW()
      )
    `;
    expect(application).toEqual([{ applied: true }]);

    const [row] = await postgres.sql<Array<Record<string, unknown>>>`
      SELECT execution_manifest_id, execution_runtime_env_identity,
             execution_registration_id, execution_pid,
             execution_start_identity, execution_command_id,
             execution_lease_expires_at
      FROM sessions
      WHERE session_id = 'w3-previous-release-terminal'
    `;
    expect(Object.values(row ?? {})).toEqual([
      null, null, null, null, null, null, null,
    ]);

    const dropMigration = readFileSync(fileURLToPath(new URL(
      "../../../packages/db-schema/sql/migrations/085b_execution_ownership_projection_drop.sql",
      import.meta.url,
    )), "utf8");
    await postgres.sql.unsafe(dropMigration);
    const remainingColumns = await postgres.sql<Array<{ column_name: string }>>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'sessions'
        AND column_name IN (
          'execution_generation', 'execution_manifest_id',
          'execution_runtime_env_identity', 'execution_pid',
          'execution_start_identity', 'execution_lease_expires_at'
        )
    `;
    expect(remainingColumns).toEqual([]);

    const [finalFunction] = await postgres.sql<Array<{ definition: string }>>`
      SELECT pg_get_functiondef(procedure.oid) AS definition
      FROM pg_proc AS procedure
      JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = current_schema()
        AND procedure.proname = 'session_apply_terminal_transition'
    `;
    expect(finalFunction?.definition).not.toContain("information_schema.columns");
    expect(finalFunction?.definition).not.toContain("EXECUTE $update$");
    expect(finalFunction?.definition).not.toContain("execution_manifest_id");
    expect(finalFunction?.definition).toContain("execution_registration_id = NULL");
    expect(finalFunction?.definition).toContain("execution_command_id = NULL");

    await postgres.sql`
      INSERT INTO sessions (
        session_id, session_type, status, agent_id, node_id, review_state,
        execution_registration_id, execution_command_id
      ) VALUES (
        'w3-post-085b-terminal', 'codex', 'running', 'agent-w3',
        ${OWNERLESS_NODE_ID}, 'not_required', 'registration-final', 'command-final'
      )
    `;
    const finalApplication = await postgres.sql<Array<{ applied: boolean }>>`
      SELECT applied
      FROM session_apply_terminal_transition(
        'w3-post-085b-terminal', 'completed', 'completed_ok', NULL,
        'not_required', NULL, 4816, NOW()
      )
    `;
    expect(finalApplication).toEqual([{ applied: true }]);
    const [finalRow] = await postgres.sql<Array<{
      status: string;
      execution_registration_id: string | null;
      execution_command_id: string | null;
    }>>`
      SELECT status, execution_registration_id, execution_command_id
      FROM sessions
      WHERE session_id = 'w3-post-085b-terminal'
    `;
    expect(finalRow).toEqual({
      status: "completed",
      execution_registration_id: null,
      execution_command_id: null,
    });
  });
});
