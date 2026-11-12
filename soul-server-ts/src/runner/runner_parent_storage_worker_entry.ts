import { performance } from "node:perf_hooks";
import { parentPort } from "node:worker_threads";

import { RunnerClaudeAccountTurnStateStore } from "./claude_account_turn_state_store.js";
import { readClosedRunnerTailStateLocal } from "./closed_runner_tail_state.js";
import { readAuthoritativeRunnerLifecycleLocal } from "./runner_lifecycle_reader.js";
import { RunnerParentOutboxStorage } from "./runner_parent_outbox_storage.js";
import {
  serializeRunnerParentStorageError,
  type RunnerParentStorageLifecycleSummaryNotice,
  type RunnerParentStorageRequest,
  type RunnerParentStorageSnapshot,
  type RunnerParentStorageWorkerMessage,
} from "./runner_parent_storage_protocol.js";
import { inspectRunnerDurableStateLocal } from "./runner_process_registry.js";
import { probeRunnerDurableRetentionLocal } from "./runner_durable_retention_probe.js";
import { readRunnerSqliteIdentityLocal } from "./runner_registration_identity.js";
import type {
  RunnerPhaseContext,
  RunnerPhaseExecutor,
} from "./runner_phase_observation.js";
import type { RunnerSqliteTransactionEvent } from "./runner_sqlite_connection.js";
import { RunnerSqliteEventOutbox } from "./sqlite_event_outbox.js";
import { readRunnerSqliteLifecycle } from "./sqlite_runner_lifecycle.js";

const port = parentPort;
if (!port) {
  throw new Error("runner parent storage worker requires parentPort");
}

let storage: RunnerParentOutboxStorage | undefined;
let mode: "normal" | "closed_tail" | "recovery" | undefined;
let currentRequestId = 0;
let phaseSequence = 0;

function post(message: RunnerParentStorageWorkerMessage): void {
  port!.postMessage(message);
}

const phaseExecutor: RunnerPhaseExecutor = {
  runSync<T>(phase: string, context: RunnerPhaseContext, action: () => T): T {
    const phaseId = ++phaseSequence;
    const startedAtMonoMs = performance.now();
    post({
      type: "phase_begin",
      requestId: currentRequestId,
      phaseId,
      phase,
      context,
      startedAtMonoMs,
    });
    try {
      const value = action();
      post({
        type: "phase_end",
        requestId: currentRequestId,
        phaseId,
        elapsedMs: performance.now() - startedAtMonoMs,
      });
      return value;
    } catch (error) {
      post({
        type: "phase_end",
        requestId: currentRequestId,
        phaseId,
        elapsedMs: performance.now() - startedAtMonoMs,
        error: serializeRunnerParentStorageError(error),
      });
      throw error;
    }
  },

  async runAsync<T>(
    phase: string,
    context: RunnerPhaseContext,
    action: () => Promise<T>,
  ): Promise<T> {
    const phaseId = ++phaseSequence;
    const startedAtMonoMs = performance.now();
    post({
      type: "phase_begin",
      requestId: currentRequestId,
      phaseId,
      phase,
      context,
      startedAtMonoMs,
    });
    try {
      const value = await action();
      post({
        type: "phase_end",
        requestId: currentRequestId,
        phaseId,
        elapsedMs: performance.now() - startedAtMonoMs,
      });
      return value;
    } catch (error) {
      post({
        type: "phase_end",
        requestId: currentRequestId,
        phaseId,
        elapsedMs: performance.now() - startedAtMonoMs,
        error: serializeRunnerParentStorageError(error),
      });
      throw error;
    }
  },
};

const transactionObserver = (event: RunnerSqliteTransactionEvent): void => {
  post({ type: "transaction", requestId: currentRequestId, event });
};

let queue = Promise.resolve();
port.on("message", (request: RunnerParentStorageRequest) => {
  queue = queue
    .then(async () => {
      await handle(request);
    })
    .catch(() => {
      // handle() reports operation failures as error results. This catch only
      // keeps a broken postMessage from skipping every later request.
    });
});

async function handle(request: RunnerParentStorageRequest): Promise<void> {
  currentRequestId = request.requestId;
  if (request.operation === "close") {
    try {
      storage?.close();
      post({
        type: "result",
        requestId: request.requestId,
        operation: "close",
        ok: true,
        value: undefined,
      });
    } catch (error) {
      post({
        type: "result",
        requestId: request.requestId,
        operation: "close",
        ok: false,
        error: serializeRunnerParentStorageError(error),
      });
    } finally {
      port!.close();
    }
    return;
  }
  try {
    const result = await execute(request);
    post({
      type: "result",
      requestId: request.requestId,
      operation: request.operation,
      ok: true,
      value: result.value,
      ...(result.snapshot ? { snapshot: result.snapshot } : {}),
    } as RunnerParentStorageWorkerMessage);
  } catch (error) {
    post({
      type: "result",
      requestId: request.requestId,
      operation: request.operation,
      ok: false,
      error: serializeRunnerParentStorageError(error),
    } as RunnerParentStorageWorkerMessage);
  }
}

async function execute(
  request: RunnerParentStorageRequest,
): Promise<{ value: unknown; snapshot?: RunnerParentStorageSnapshot }> {
  switch (request.operation) {
    case "open":
      if (request.input.mode === "recovery") {
        mode = "recovery";
        storage = undefined;
        return { value: undefined };
      }
      mode = request.input.mode;
      storage = await RunnerParentOutboxStorage.open(request.input, {
        phaseExecutor,
        transactionObserver,
      });
      return { value: undefined, snapshot: storage.snapshot() };
    case "readBootstrap": {
      const current = requireStorage();
      const value = await current.readBootstrap();
      return { value, snapshot: current.snapshot() };
    }
    case "readBatch": {
      const current = requireStorage();
      return {
        value: await current.readBatch(request.input.maxEvents),
        snapshot: current.snapshot(),
      };
    }
    case "acknowledge": {
      const current = requireStorage();
      await current.acknowledge(request.input.streamId, request.input.acknowledgedThrough);
      return { value: undefined, snapshot: current.snapshot() };
    }
    case "quarantineHead": {
      const current = requireStorage();
      return {
        value: await current.quarantineHead(request.input),
        snapshot: current.snapshot(),
      };
    }
    case "readRecord":
      return { value: await requireStorage().readRecord(request.input.sourceSeq) };
    case "readLatestPendingRecord": {
      const current = requireStorage();
      return {
        value: await current.readLatestPendingRecord(),
        snapshot: current.snapshot(),
      };
    }
    case "readPendingIpcFrames":
      return { value: await requireStorage().readPendingIpcFrames() };
    case "hasPendingDurableWork": {
      const current = requireStorage();
      return {
        value: await current.hasPendingDurableWork(),
        snapshot: current.snapshot(),
      };
    }
    case "readHostCallApplied":
      return { value: await requireStorage().readHostCallApplied(request.input.correlationId) };
    case "recordHostCallApplied":
      requireStorage().recordHostCallApplied(request.input);
      return { value: undefined };
    case "acknowledgeHostCall":
      requireStorage().acknowledgeHostCall(request.input.correlationId);
      return { value: undefined };
    case "readLifecycle": {
      if (storage) return { value: storage.readLifecycle() };
      requireRecoveryMode();
      return {
        value: readRunnerSqliteLifecycle(
          request.input.databasePath,
          recoveryLifecycleObservation(request.input),
        ),
      };
    }
    case "readAuthoritativeLifecycle": {
      requireRecoveryMode();
      const value = await readAuthoritativeRunnerLifecycleLocal(request.input.databasePath, {
        phaseObservation: phaseExecutor,
        ...(request.input.sessionId ? { sessionId: request.input.sessionId } : {}),
        lifecycleSummaryOptions: {
          onSummaryRenameFailure: (error, path, details) => {
            postSummaryNotice({
              type: "summary_notice",
              requestId: currentRequestId,
              kind: "rename_failure",
              error: serializeRunnerParentStorageError(error),
              path,
              consecutiveFailures: details.consecutiveFailures,
              severity: details.severity,
            });
          },
          onSummaryRenameRecovery: (path, recoveredAfterFailures) => {
            postSummaryNotice({
              type: "summary_notice",
              requestId: currentRequestId,
              kind: "rename_recovery",
              path,
              recoveredAfterFailures,
            });
          },
        },
      });
      return { value };
    }
    case "readClosedTail": {
      requireRecoveryMode();
      return {
        value: readClosedRunnerTailStateLocal(
          request.input.databasePath,
          request.input.sessionId,
          phaseExecutor,
        ),
      };
    }
    case "readSqliteIdentity": {
      requireRecoveryMode();
      return { value: readRunnerSqliteIdentityLocal(request.input.databasePath, phaseExecutor) };
    }
    case "inspectDurableState": {
      requireRecoveryMode();
      return { value: await inspectRunnerDurableStateLocal(request.input.registration, phaseExecutor) };
    }
    case "probeDurableRetention": {
      requireRecoveryMode();
      return {
        value: await probeRunnerDurableRetentionLocal(request.input.registration, phaseExecutor),
      };
    }
    case "readClaudeAccountTurnState": {
      requireRecoveryMode();
      return {
        value: RunnerClaudeAccountTurnStateStore.readFromDatabase(
          request.input.databasePath,
          request.input.sessionId,
        ),
      };
    }
    case "prepareRunnerDatabase": {
      requireRecoveryMode();
      const outbox = await RunnerSqliteEventOutbox.create(request.input.databasePath);
      outbox.close();
      return { value: undefined };
    }
    case "close":
      // close is handled before execute() so the port can be closed afterwards.
      throw new Error("runner parent storage close is handled separately");
  }
}

function requireStorage(): RunnerParentOutboxStorage {
  if (mode === "recovery") {
    throw new Error("runner parent storage operation is not available in recovery mode");
  }
  if (!storage) throw new Error("runner parent storage worker is not open");
  return storage;
}

function requireRecoveryMode(): void {
  if (mode !== "recovery") {
    throw new Error("runner parent recovery operation requires recovery mode");
  }
}

function recoveryLifecycleObservation(input: {
  databasePath: string;
  sessionId?: string;
}): { phaseObservation: RunnerPhaseExecutor; sessionId?: string; label: string } {
  return {
    phaseObservation: phaseExecutor,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    label: "runner recovery lifecycle",
  };
}

function postSummaryNotice(notice: RunnerParentStorageLifecycleSummaryNotice): void {
  post(notice);
}
