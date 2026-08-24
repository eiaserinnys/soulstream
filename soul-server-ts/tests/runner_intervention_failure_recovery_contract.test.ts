import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RunnerSqliteEventOutbox,
  type RunnerBootstrapInput,
} from "../src/runner/sqlite_event_outbox.js";
import { resolveAmbiguousRunnerIntervention } from
  "../src/runner/runner_intervention_resolution.js";
import { RunnerSqliteLifecycle } from "../src/runner/sqlite_runner_lifecycle.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("runner intervention failure recovery contract", () => {
  it("does not automatically re-serve a terminal failure after writer restart", async () => {
    const outbox = await createOutbox();
    const databasePath = outbox.databasePath;
    await stage(outbox, "terminal-failure", "first instruction", 2);
    await expect(
      outbox.claimIntervention("terminal-failure", "execute:first"),
    ).resolves.toBe(true);
    const lifecycle = RunnerSqliteLifecycle.open(databasePath, "session-a");
    lifecycle.begin({
      pid: process.pid,
      commandId: "execute:first",
      progressedAt: timestamp(3),
    });
    await outbox.finishExecution({
      commandId: "execute:first",
      interventionId: "terminal-failure",
      state: "failed",
      progressedAt: timestamp(4),
      terminalError: { code: "execution_failed", message: "turn produced no engine frame" },
    });
    lifecycle.close();
    outbox.close();

    const recovered = await RunnerSqliteEventOutbox.open(databasePath);
    await expect(
      recovered.claimIntervention("terminal-failure", "execute:automatic-retry"),
    ).resolves.toBe(false);
    recovered.close();
  });

  it("requeues a terminal failure after explicit not_applied resolution", async () => {
    const outbox = await createOutbox();
    const databasePath = outbox.databasePath;
    await stage(outbox, "retryable-after-review", "first instruction", 2);
    await expect(
      outbox.claimIntervention("retryable-after-review", "execute:first"),
    ).resolves.toBe(true);
    const lifecycle = RunnerSqliteLifecycle.open(databasePath, "session-a");
    lifecycle.begin({
      pid: process.pid,
      commandId: "execute:first",
      progressedAt: timestamp(3),
    });
    await outbox.finishExecution({
      commandId: "execute:first",
      interventionId: "retryable-after-review",
      state: "failed",
      progressedAt: timestamp(4),
      terminalError: { code: "execution_failed", message: "engine failed before delivery" },
    });
    lifecycle.close();
    outbox.close();

    await resolveAmbiguousRunnerIntervention(
      databasePath,
      "retryable-after-review",
      "not_applied",
      stoppedRunnerResolutionDependencies(),
    );
    const recovered = await RunnerSqliteEventOutbox.open(databasePath);
    await expect(
      recovered.claimIntervention("retryable-after-review", "execute:reviewed-retry"),
    ).resolves.toBe(true);
    recovered.close();
  });

  it("deletes a completed intervention instead of retaining a replay token", async () => {
    const outbox = await createOutbox();
    const databasePath = outbox.databasePath;
    await stage(outbox, "completed", "first instruction", 2);
    const lifecycle = RunnerSqliteLifecycle.open(databasePath, "session-a");
    lifecycle.begin({
      pid: process.pid,
      commandId: "execute:completed",
      progressedAt: timestamp(3),
    });
    await expect(
      outbox.claimIntervention("completed", "execute:completed"),
    ).resolves.toBe(true);
    await outbox.finishExecution({
      commandId: "execute:completed",
      interventionId: "completed",
      state: "completed",
      progressedAt: timestamp(4),
      terminalError: null,
    });
    lifecycle.close();
    outbox.close();

    const recovered = await RunnerSqliteEventOutbox.open(databasePath);
    await expect(
      recovered.claimIntervention("completed", "execute:repeat"),
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

  it("releases an unfinished claim only after stopped-runner resolution", async () => {
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

    const fenced = await RunnerSqliteEventOutbox.open(databasePath);
    await expect(
      fenced.claimIntervention("hard-kill", "execute:premature-replacement"),
    ).resolves.toBe(false);
    fenced.close();
    await resolveAmbiguousRunnerIntervention(
      databasePath,
      "hard-kill",
      "not_applied",
      stoppedRunnerResolutionDependencies(),
    );
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

function stoppedRunnerResolutionDependencies() {
  return {
    acquireWriterLock: async () => ({ release: async () => undefined }),
    inspectProcess: async () => ({ alive: false as const, startIdentity: null }),
    readPidFile: async () => null,
  };
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
