import { performance } from "node:perf_hooks";
import { parentPort } from "node:worker_threads";

import { RunnerParentOutboxStorage } from "./runner_parent_outbox_storage.js";
import {
  serializeRunnerParentStorageError,
  type RunnerParentStorageRequest,
  type RunnerParentStorageSnapshot,
  type RunnerParentStorageWorkerMessage,
} from "./runner_parent_storage_protocol.js";
import type {
  RunnerPhaseContext,
  RunnerPhaseExecutor,
} from "./runner_phase_observation.js";
import type { RunnerSqliteTransactionEvent } from "./runner_sqlite_connection.js";

const port = parentPort;
if (!port) {
  throw new Error("runner parent storage worker requires parentPort");
}

let storage: RunnerParentOutboxStorage | undefined;
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
      requireStorage().close();
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
    case "inspectPendingInterventions":
      return { value: await requireStorage().inspectPendingInterventions() };
    case "readInterventionFallback":
      return {
        value: await requireStorage().readInterventionFallback(request.input.interventionId),
      };
    case "removeInterventionFallback":
      requireStorage().removeInterventionFallback(request.input.interventionId);
      return { value: undefined };
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
    case "close":
      // close is handled before execute() so the port can be closed afterwards.
      throw new Error("runner parent storage close is handled separately");
  }
}

function requireStorage(): RunnerParentOutboxStorage {
  if (!storage) throw new Error("runner parent storage worker is not open");
  return storage;
}
