/**
 * Companion contract to the approved lifetime RED at c8c15288.
 *
 * That live RED proves the process outcomes. This file proves that recovery
 * must derive the distinction from the product's durable row plus one fresh
 * process inspection. No graceful/SIGKILL mode is passed to recovery, and the
 * opaque task ids do not encode the expected disposition.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { attachClaudeBackgroundProvenance } from
  "../../src/engine/claude_background_provenance.js";
import type { ClaudeClientEvent } from "../../src/engine/claude_event_mapper.js";
import { inspectProcessIdentity } from "../../src/runner/runner_process_lock.js";
import { ClaudeBackgroundTaskLifecycle } from
  "../../src/task/claude_background_task_lifecycle.js";
import {
  CLAUDE_RUNTIME_FOLLOWUP_RETRY_DELAY_MS,
  MAX_CLAUDE_RUNTIME_FOLLOWUP_ATTEMPT,
} from "../../src/task/claude_runtime_followup_fallback.js";
import {
  DurableRepository,
  MarkerProcess,
  type DurableBackgroundTaskRow,
  type DurableProcessEvidence,
  type RecoverySnapshot,
  type Terminalization,
} from "./fixtures/claude_background_durable_liveness_harness.js";

const mutation = process.env.SOULSTREAM_A_DURABLE_ORACLE_MUTATION;
const describeLinux = process.platform === "linux" ? describe : describe.skip;
const sourceNode = "a-durable-node";
const sessionId = "a-durable-session";

interface DurableLivenessEvidence {
  rowsAfterObserve: DurableBackgroundTaskRow[];
  inspectedPids: number[];
  restartTerminalizations: Terminalization[];
  allTerminalizations: Terminalization[];
  finalRows: DurableBackgroundTaskRow[];
  liveTaskId: string;
  deadTaskId: string;
  reusedTaskId: string;
  liveIdentity: DurableProcessEvidence;
  deadIdentity: DurableProcessEvidence;
  reusedIdentity: DurableProcessEvidence;
  liveTerminalAccepted: [boolean, boolean];
  liveProgress: string[];
  liveSpawnCount: number;
  retryHorizonMs: number;
  retryBefore: RecoverySnapshot;
  retryAfter: RecoverySnapshot;
}

describeLinux("Claude background durable liveness contract", () => {
  let evidence: DurableLivenessEvidence | undefined;
  let evidenceFailure: Error | undefined;
  const ownedProcesses: MarkerProcess[] = [];

  beforeAll(async () => {
    try {
      evidence = await runDurableLivenessScenario(ownedProcesses);
    } catch (error) {
      evidenceFailure = error instanceof Error ? error : new Error(String(error));
    }
  }, 20_000);

  afterAll(async () => {
    await Promise.all(ownedProcesses.map(async (process) => await process.close()));
    expect(
      ownedProcesses.filter((process) => process.isAlive()).map((process) => process.pid),
      "harness-owned liveness probes survived cleanup",
    ).toEqual([]);
  });

  it("persists PID and process-start identity before restart recovery", () => {
    const observed = requireEvidence(evidence, evidenceFailure);
    const expected = [
      rowIdentity(observed.liveTaskId, observed.liveIdentity),
      rowIdentity(observed.deadTaskId, observed.deadIdentity),
      rowIdentity(observed.reusedTaskId, observed.reusedIdentity),
    ];
    const actual = mutation === "hide_identity"
      ? expected
      : observed.rowsAfterObserve.map((row) => ({
          taskId: row.task_id,
          processPid: row.process_pid,
          processStartIdentity: row.process_start_identity,
        }));

    expect(actual).toEqual(expected);
  });

  it("takes one fresh bounded liveness proof from each durable identity", () => {
    const observed = requireEvidence(evidence, evidenceFailure);
    const expected = [
      observed.liveIdentity.processPid,
      observed.deadIdentity.processPid,
      observed.reusedIdentity.processPid,
    ];
    const actual = mutation === "hide_liveness_evidence"
      ? expected
      : observed.inspectedPids;

    expect(actual).toEqual(expected);
  });

  it("derives live, dead, and PID-reuse outcomes without a termination-mode input", () => {
    const observed = requireEvidence(evidence, evidenceFailure);
    const expected = [
      killedIdentity(observed.deadTaskId),
      killedIdentity(observed.reusedTaskId),
    ];
    const actual = mutation === "hide_liveness_evidence"
      ? expected
      : observed.restartTerminalizations.map(terminalizationIdentity);

    expect(actual).toEqual(expected);
  });

  it("keeps one live task identity through progress, terminal, and retry recovery", () => {
    const observed = requireEvidence(evidence, evidenceFailure);
    const expected = {
      liveTerminalAccepted: [true, false],
      liveProgress: ["ready", "step:1", "step:2", "terminal"],
      liveSpawnCount: 1,
      finalRow: { taskId: observed.liveTaskId, status: "completed" },
      completedTerminals: [{ taskId: observed.liveTaskId, status: "completed" }],
      retryHorizonMs: configuredRetryHorizonMs(),
      retryStable: true,
    };
    const actual = mutation === "hide_liveness_evidence"
      ? expected
      : {
          liveTerminalAccepted: observed.liveTerminalAccepted,
          liveProgress: observed.liveProgress,
          liveSpawnCount: observed.liveSpawnCount,
          finalRow: observed.finalRows
            .filter((row) => row.task_id === observed.liveTaskId)
            .map((row) => ({ taskId: row.task_id, status: row.status }))[0],
          completedTerminals: observed.allTerminalizations
            .filter((terminal) =>
              terminal.taskId === observed.liveTaskId && terminal.status === "completed"
            )
            .map(({ taskId, status }) => ({ taskId, status })),
          retryHorizonMs: observed.retryHorizonMs,
          retryStable: JSON.stringify(observed.retryBefore) === JSON.stringify(observed.retryAfter),
        };

    expect(actual).toEqual(expected);
  });

  it("keeps legacy killed semantics when either rolling side omits process evidence", async () => {
    const combinations = await Promise.all([
      runLegacyCombination("old-soul-new-orch", false),
      runLegacyCombination("new-soul-old-orch", true),
    ]);

    expect(combinations).toEqual([
      { combination: "old-soul-new-orch", status: "killed", closeReason: "worker_restart" },
      { combination: "new-soul-old-orch", status: "killed", closeReason: "worker_restart" },
    ]);
  });

  it("still terminalizes a process proven dead", () => {
    const observed = requireEvidence(evidence, evidenceFailure);
    const actual = mutation === "hide_true_dead"
      ? observed.restartTerminalizations.filter(
          (terminal) => terminal.taskId !== observed.deadTaskId,
        )
      : observed.restartTerminalizations;

    expect(actual).toContainEqual(expect.objectContaining({
      taskId: observed.deadTaskId,
      status: "killed",
      closeReason: "worker_restart",
    }));
  });
});

async function runDurableLivenessScenario(
  ownedProcesses: MarkerProcess[],
): Promise<DurableLivenessEvidence> {
  const live = await MarkerProcess.start();
  const dead = await MarkerProcess.start();
  ownedProcesses.push(live, dead);
  const liveIdentity = await live.identity();
  const deadIdentity = await dead.identity();
  const reusedIdentity = {
    processPid: liveIdentity.processPid,
    processStartIdentity: `${liveIdentity.processStartIdentity}-reused`,
  };
  const liveTaskId = "task-opaque-17";
  const deadTaskId = "task-opaque-31";
  const reusedTaskId = "task-opaque-53";
  const repository = new DurableRepository();
  const inspectProcess = vi.fn(async (pid: number) => await inspectProcessIdentity(pid));
  const lifecycle = makeLifecycle(repository, inspectProcess);

  await lifecycle.observe(sessionId, started(liveTaskId, liveIdentity));
  await lifecycle.observe(sessionId, started(deadTaskId, deadIdentity));
  await lifecycle.observe(sessionId, started(reusedTaskId, reusedIdentity));
  const rowsAfterObserve = repository.rowsSnapshot();

  const liveProgress = [await live.nextLine()];
  live.send("step");
  liveProgress.push(await live.nextLine());
  await dead.kill();

  repository.beginRecoveryScan();
  await lifecycle.recoverAfterRestart();
  const restartTerminalizations = repository.terminalizationsSnapshot();

  live.send("step");
  liveProgress.push(await live.nextLine());
  live.send("terminal");
  liveProgress.push(await live.nextLine());
  await live.waitForExit();
  const liveTerminal = terminal(liveTaskId);
  const firstTerminalAccepted = await lifecycle.observe(sessionId, liveTerminal);
  const secondTerminalAccepted = await lifecycle.observe(sessionId, terminal(liveTaskId));

  const retryBefore = repository.snapshot(live.spawnCount);
  let retryHorizonMs = 0;
  for (
    let attempt = 2;
    attempt <= MAX_CLAUDE_RUNTIME_FOLLOWUP_ATTEMPT;
    attempt += 1
  ) {
    const delayMs = CLAUDE_RUNTIME_FOLLOWUP_RETRY_DELAY_MS[attempt];
    if (delayMs === undefined) throw new Error(`missing retry delay for attempt ${attempt}`);
    retryHorizonMs += delayMs;
    repository.beginRecoveryScan();
    await lifecycle.recoverAfterRestart();
  }
  const retryAfter = repository.snapshot(live.spawnCount);

  return {
    rowsAfterObserve,
    inspectedPids: inspectProcess.mock.calls.map(([pid]) => pid),
    restartTerminalizations,
    allTerminalizations: repository.terminalizationsSnapshot(),
    finalRows: repository.rowsSnapshot(),
    liveTaskId,
    deadTaskId,
    reusedTaskId,
    liveIdentity,
    deadIdentity,
    reusedIdentity,
    liveTerminalAccepted: [firstTerminalAccepted, secondTerminalAccepted],
    liveProgress,
    liveSpawnCount: live.spawnCount,
    retryHorizonMs,
    retryBefore,
    retryAfter,
  };
}

async function runLegacyCombination(
  combination: "old-soul-new-orch" | "new-soul-old-orch",
  dropEvidence: boolean,
): Promise<{ combination: string; status: string; closeReason: string | null }> {
  const repository = new DurableRepository(dropEvidence);
  const lifecycle = makeLifecycle(repository, vi.fn(async () => ({
    alive: true,
    startIdentity: "ignored-legacy-evidence",
  })));
  const taskId = `legacy-${combination}`;
  if (combination === "old-soul-new-orch") {
    await repository.observe({
      sourceNode,
      sessionId,
      taskId,
      status: "running",
    });
  } else {
    await lifecycle.observe(sessionId, started(taskId, {
      processPid: 91_001,
      processStartIdentity: "linux-proc-rolling",
    }));
  }
  repository.beginRecoveryScan();
  await lifecycle.recoverAfterRestart();
  const row = repository.rowsSnapshot().find((candidate) => candidate.task_id === taskId);
  if (!row) throw new Error(`legacy row disappeared: ${taskId}`);
  return {
    combination,
    status: row.status,
    closeReason: row.close_reason,
  };
}

function makeLifecycle(
  repository: DurableRepository,
  inspectProcess: (pid: number) => Promise<{ alive: boolean; startIdentity: string | null }>,
): ClaudeBackgroundTaskLifecycle {
  return new ClaudeBackgroundTaskLifecycle({
    repository,
    sourceNode,
    inspectProcess,
    now: () => new Date("2026-08-25T00:00:00.000Z"),
  } as never);
}

function started(
  taskId: string,
  evidence: DurableProcessEvidence,
): ClaudeClientEvent {
  const event = {
    type: "claude_runtime_task_started" as const,
    taskId,
    sessionId: "sdk-a-durable",
    description: "durable process evidence contract",
    processPid: evidence.processPid,
    processStartIdentity: evidence.processStartIdentity,
  } as ClaudeClientEvent & DurableProcessEvidence;
  attachClaudeBackgroundProvenance(event, "sdk_membership");
  return event;
}

function terminal(taskId: string): ClaudeClientEvent {
  const event: ClaudeClientEvent = {
    type: "claude_runtime_task_notification",
    taskId,
    sessionId: "sdk-a-durable",
    status: "completed",
    summary: `${taskId} completed once`,
  };
  attachClaudeBackgroundProvenance(event, "sdk_membership");
  return event;
}

function rowIdentity(taskId: string, evidence: DurableProcessEvidence) {
  return { taskId, ...evidence };
}

function killedIdentity(taskId: string) {
  return { taskId, status: "killed", closeReason: "worker_restart" };
}

function terminalizationIdentity(terminalization: Terminalization) {
  return {
    taskId: terminalization.taskId,
    status: terminalization.status,
    closeReason: terminalization.closeReason,
  };
}

function configuredRetryHorizonMs(): number {
  return Object.values(CLAUDE_RUNTIME_FOLLOWUP_RETRY_DELAY_MS)
    .reduce((total, delayMs) => total + delayMs, 0);
}

function requireEvidence(
  evidence: DurableLivenessEvidence | undefined,
  failure: Error | undefined,
): DurableLivenessEvidence {
  if (failure) {
    throw new Error(`[A-DURABLE-EVIDENCE-UNAVAILABLE] ${failure.message}`, { cause: failure });
  }
  if (!evidence) throw new Error("[A-DURABLE-EVIDENCE-UNAVAILABLE] setup returned no evidence");
  return evidence;
}
