import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RunnerSqliteEventOutbox,
  type RunnerBootstrapInput,
} from "../src/runner/sqlite_event_outbox.js";
import { RunnerSqliteLifecycle } from "../src/runner/sqlite_runner_lifecycle.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("runner intervention failure recovery contract", () => {
  it("keeps a pre-delivery terminal failure claimable after restart", async () => {
    const outbox = await createOutbox();
    const databasePath = outbox.databasePath;
    await stage(outbox, "pre-delivery-failure", "first instruction", 2);
    const lifecycle = RunnerSqliteLifecycle.open(databasePath, "session-a");
    lifecycle.begin({
      pid: process.pid,
      commandId: "execute:first",
      progressedAt: timestamp(3),
    });
    await expect(
      outbox.claimIntervention("pre-delivery-failure", "execute:first"),
    ).resolves.toBe(true);
    await outbox.finishExecution({
      commandId: "execute:first",
      interventionId: "pre-delivery-failure",
      state: "failed",
      progressedAt: timestamp(4),
      terminalError: { code: "execution_failed", message: "engine rejected before turn start" },
    });
    lifecycle.close();
    outbox.close();

    const recovered = await RunnerSqliteEventOutbox.open(databasePath);
    await expect(
      recovered.claimIntervention("pre-delivery-failure", "execute:retry"),
    ).resolves.toBe(true);
    recovered.close();
  });

  it("does not re-claim input after the engine durably reported its turn started", async () => {
    const outbox = await createOutbox();
    const databasePath = outbox.databasePath;
    await stage(outbox, "accepted-then-empty", "first instruction", 2);
    const lifecycle = RunnerSqliteLifecycle.open(databasePath, "session-a");
    lifecycle.begin({
      pid: process.pid,
      commandId: "execute:accepted",
      progressedAt: timestamp(3),
    });
    await expect(
      outbox.claimIntervention("accepted-then-empty", "execute:accepted"),
    ).resolves.toBe(true);
    await recordTurnStarted(outbox, lifecycle, "execute:accepted", 4);
    await outbox.finishExecution({
      commandId: "execute:accepted",
      interventionId: "accepted-then-empty",
      state: "failed",
      progressedAt: timestamp(5),
      terminalError: { code: "execution_failed", message: "engine produced no result" },
    });
    lifecycle.close();
    outbox.close();

    const recovered = await RunnerSqliteEventOutbox.open(databasePath);
    await expect(
      recovered.claimIntervention("accepted-then-empty", "execute:repeat"),
    ).resolves.toBe(false);
    recovered.close();
  });

  it("lets later input advance after an earlier delivery reaches terminal failure", async () => {
    const outbox = await createOutbox();
    const databasePath = outbox.databasePath;
    await stage(outbox, "poison-head", "first instruction", 2);
    await stage(outbox, "next-human-input", "second instruction", 3);
    const lifecycle = RunnerSqliteLifecycle.open(databasePath, "session-a");
    lifecycle.begin({
      pid: process.pid,
      commandId: "execute:poison-head",
      progressedAt: timestamp(4),
    });
    await expect(
      outbox.claimIntervention("poison-head", "execute:poison-head"),
    ).resolves.toBe(true);
    await recordTurnStarted(outbox, lifecycle, "execute:poison-head", 5);
    await outbox.finishExecution({
      commandId: "execute:poison-head",
      interventionId: "poison-head",
      state: "failed",
      progressedAt: timestamp(6),
      terminalError: { code: "execution_failed", message: "engine produced no result" },
    });
    lifecycle.close();
    outbox.close();

    const recovered = await RunnerSqliteEventOutbox.open(databasePath);
    await expect(recovered.readPendingInterventions()).resolves.toEqual([{
      interventionId: "next-human-input",
      message: { text: "second instruction", user: "human" },
    }]);
    recovered.close();
  });

  it("recovers an unfinished claim when the runner disappears before terminal commit", async () => {
    const outbox = await createOutbox();
    const databasePath = outbox.databasePath;
    await stage(outbox, "hard-kill", "survive runner death", 2);
    const lifecycle = RunnerSqliteLifecycle.open(databasePath, "session-a");
    lifecycle.begin({
      pid: process.pid,
      commandId: "execute:lost-runner",
      progressedAt: timestamp(3),
    });
    await expect(
      outbox.claimIntervention("hard-kill", "execute:lost-runner"),
    ).resolves.toBe(true);

    lifecycle.close();
    outbox.close();

    const recovered = await RunnerSqliteEventOutbox.open(databasePath);
    await expect(
      recovered.claimIntervention("hard-kill", "execute:replacement"),
    ).resolves.toBe(true);
    recovered.close();
  });
});

async function createOutbox(): Promise<RunnerSqliteEventOutbox> {
  const directory = await mkdtemp(join(tmpdir(), "runner-intervention-recovery-"));
  tempDirectories.push(directory);
  const outbox = await RunnerSqliteEventOutbox.create(join(directory, "runner.sqlite"));
  await outbox.initializeBootstrap(bootstrapInput());
  return outbox;
}

async function stage(
  outbox: RunnerSqliteEventOutbox,
  interventionId: string,
  text: string,
  second: number,
): Promise<void> {
  await outbox.stageIntervention({
    interventionId,
    message: { text, user: "human" },
    queued: true,
    queuedAt: timestamp(second),
  });
}

function timestamp(second: number): string {
  return `2026-08-23T20:08:${String(second).padStart(2, "0")}.000Z`;
}

async function recordTurnStarted(
  outbox: RunnerSqliteEventOutbox,
  lifecycle: RunnerSqliteLifecycle,
  commandId: string,
  second: number,
): Promise<void> {
  const payload = {
    type: "progress",
    text: "Codex turn started",
    timestamp: second,
    raw_event_type: "turn/started",
    turn_id: `turn-${second}`,
  };
  lifecycle.progress(commandId, timestamp(second));
  await outbox.appendEngineFrame({
    session_id: "session-a",
    event_type: "progress",
    payload,
    searchable_text: payload.text,
    created_at: timestamp(second),
    semantic_dedupe_key: null,
    session_effect: null,
  }, {
    protocolVersion: 1,
    channel: "event",
    kind: "engine_event",
    payload,
  });
}

function bootstrapInput(): RunnerBootstrapInput {
  return {
    session_id: "session-a",
    created_at: timestamp(0),
    resume: {
      schema_version: 1,
      backend_session_id: "backend-session-a",
      cwd: "/workspace/session-a",
      codex_home: "/workspace/session-a/.codex",
      rollout_root: null,
      code_sha: "test-release",
      snapshot_path: "/releases/test-release/soul-server-ts",
    },
  };
}
