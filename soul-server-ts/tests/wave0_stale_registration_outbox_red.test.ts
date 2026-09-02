import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  EventIngressRepository,
  type EventIngressSql,
} from "../../orch-server-ts/src/node/event_ingress_repository.js";
import { applyEventSessionEffect } from
  "../../orch-server-ts/src/node/event_session_effect_applier.js";
import { runnerProcessPaths } from "../src/runner/runner_process_paths.js";
import { writeRunnerRegistrationIdentity } from
  "../src/runner/runner_registration_identity.js";
import { RunnerSqliteEventOutbox } from
  "../src/runner/sqlite_event_outbox.js";
import {
  createFullSchemaPostgresHarness,
  type FullSchemaPostgresHarness,
} from "./db/full_schema_postgres_harness.js";

const SESSION_ID = "wave0-stale-registration-outbox";
const NODE_ID = "node-wave0-stale-registration";
const OLD_REGISTRATION_ID = "registration-wave0-old";
const CURRENT_REGISTRATION_ID = "registration-wave0-current";
const temporaryDirectories: string[] = [];

describe("Wave 0 stale registration outbox contract", () => {
  let postgres: FullSchemaPostgresHarness;

  beforeAll(async () => {
    postgres = await createFullSchemaPostgresHarness();
  }, 45_000);

  afterAll(async () => {
    await postgres.cleanup();
  });

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(
      async (directory) => await rm(directory, { recursive: true, force: true }),
    ));
  });

  it("rejects an old registration terminal record while accepting the revived registration stream", async () => {
    const oldRunner = await createDurableRunnerEvidence(OLD_REGISTRATION_ID);
    const currentRunner = await createDurableRunnerEvidence(CURRENT_REGISTRATION_ID);
    const oldTerminal = await oldRunner.outbox.append({
      session_id: SESSION_ID,
      execution_generation: 7,
      event_type: "session_ended",
      payload: { type: "session_ended", status: "completed" },
      searchable_text: null,
      created_at: "2026-09-02T00:00:00.000Z",
      semantic_dedupe_key: "old-registration-terminal",
      session_effect: {
        kind: "terminal_transition",
        status: "completed",
        termination_reason: "completed_ok",
        termination_detail: null,
        review_state: "not_required",
        updated_at: "2026-09-02T00:00:00.000Z",
      },
    });
    const currentLiveEvent = await currentRunner.outbox.append({
      session_id: SESSION_ID,
      execution_generation: 7,
      event_type: "assistant_message",
      payload: { type: "assistant_message", content: "current runner is live" },
      searchable_text: null,
      created_at: "2026-09-02T00:01:00.000Z",
      semantic_dedupe_key: "current-registration-live-event",
      session_effect: null,
    });
    oldRunner.outbox.close();
    currentRunner.outbox.close();

    expect(oldRunner.identity.registrationId).toBe(OLD_REGISTRATION_ID);
    expect(currentRunner.identity.registrationId).toBe(CURRENT_REGISTRATION_ID);
    expect(oldRunner.bootstrap.stream_id).toBe(oldTerminal.stream_id);
    expect(currentRunner.bootstrap.stream_id).toBe(currentLiveEvent.stream_id);
    expect(oldTerminal.stream_id).not.toBe(currentLiveEvent.stream_id);

    await postgres.sql`
      INSERT INTO sessions (
        session_id, session_type, status, agent_id, node_id, review_state,
        execution_registration_id, execution_command_id
      ) VALUES (
        ${SESSION_ID}, 'codex', 'running', 'agent-wave0', ${NODE_ID}, 'not_required',
        ${CURRENT_REGISTRATION_ID}, 'execute-current'
      )
    `;
    const ingress = new EventIngressRepository(
      { resolveSql: async () => postgres.sql as unknown as EventIngressSql },
      applyEventSessionEffect,
    );
    await ingress.commitBatch(NODE_ID, {
      type: "event_append_batch",
      protocol_version: 1,
      stream_id: oldTerminal.stream_id,
      first_seq: oldTerminal.source_seq,
      events: [oldTerminal],
    });
    await ingress.commitBatch(NODE_ID, {
      type: "event_append_batch",
      protocol_version: 1,
      stream_id: currentLiveEvent.stream_id,
      first_seq: currentLiveEvent.source_seq,
      events: [currentLiveEvent],
    });

    const [session] = await postgres.sql<Array<{
      status: string;
      registration_id: string | null;
      command_id: string | null;
    }>>`
      SELECT status, execution_registration_id AS registration_id,
             execution_command_id AS command_id
      FROM sessions
      WHERE session_id = ${SESSION_ID}
    `;
    const events = await postgres.sql<Array<{
      event_type: string;
      semantic_dedupe_key: string | null;
    }>>`
      SELECT event_type, dedupe_key AS semantic_dedupe_key
      FROM events
      WHERE session_id = ${SESSION_ID}
      ORDER BY id ASC
    `;

    expect(session).toEqual({
      status: "running",
      registration_id: CURRENT_REGISTRATION_ID,
      command_id: "execute-current",
    });
    expect(events).toEqual([
      {
        event_type: "assistant_message",
        semantic_dedupe_key: "current-registration-live-event",
      },
    ]);
  });
});

async function createDurableRunnerEvidence(registrationId: string) {
  const root = await mkdtemp(join(tmpdir(), "wave0-registration-stream-"));
  temporaryDirectories.push(root);
  const paths = runnerProcessPaths(root, SESSION_ID);
  await mkdir(paths.sessionDirectory, { recursive: true });
  const identity = {
    schemaVersion: 1 as const,
    registrationId,
    sessionId: SESSION_ID,
    codeSha: `release-${registrationId}`,
    releaseManifestId: `manifest-${registrationId}`,
    runtimeEnvIdentity: `runtime-${registrationId}`,
    pid: registrationId === OLD_REGISTRATION_ID ? 7006 : 7007,
    startIdentity: `start-${registrationId}`,
  };
  await writeRunnerRegistrationIdentity(paths.sessionDirectory, identity);
  const outbox = await RunnerSqliteEventOutbox.create(paths.databasePath);
  const bootstrap = await outbox.initializeBootstrap({
    session_id: SESSION_ID,
    created_at: "2026-09-02T00:00:00.000Z",
    resume: {
      schema_version: 1,
      backend_session_id: `thread-${registrationId}`,
      cwd: "/workspace/wave0",
      codex_home: null,
      rollout_root: null,
      code_sha: identity.codeSha,
      snapshot_path: `/release/${registrationId}`,
    },
  });
  return { identity, bootstrap, outbox };
}
