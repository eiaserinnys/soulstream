import { parentPort, workerData } from "node:worker_threads";

import { RunnerClaudeAccountTurnStateStore } from
  "../../../src/runner/claude_account_turn_state_store.js";
import { readClosedRunnerTailStateLocal } from
  "../../../src/runner/closed_runner_tail_state.js";
import { readAuthoritativeRunnerLifecycleLocal } from
  "../../../src/runner/runner_lifecycle_reader.js";
import { RunnerParentOutboxStorage } from
  "../../../src/runner/runner_parent_outbox_storage.js";
import {
  serializeRunnerParentStorageError,
  type RunnerParentStorageRequest,
  type RunnerParentStorageSnapshot,
  type RunnerParentStorageWorkerMessage,
} from "../../../src/runner/runner_parent_storage_protocol.js";
import { inspectRunnerDurableStateLocal } from
  "../../../src/runner/runner_process_registry.js";
import { probeRunnerDurableRetentionLocal } from
  "../../../src/runner/runner_durable_retention_probe.js";
import { readRunnerSqliteIdentityLocal } from
  "../../../src/runner/runner_registration_identity.js";
import type { RunnerSqliteTransactionEvent } from
  "../../../src/runner/runner_sqlite_connection.js";
import { readRunnerSqliteLifecycle } from "../../../src/runner/sqlite_runner_lifecycle.js";

type FixtureMode = "real" | "gate" | "hang" | "close_without_response" | "notice";

const data = workerData as {
  mode?: FixtureMode;
  signal?: SharedArrayBuffer;
  release?: SharedArrayBuffer;
};
const mode = data.mode ?? "real";
const signal = data.signal ? new Int32Array(data.signal) : undefined;
const release = data.release ? new Int32Array(data.release) : undefined;

const port = parentPort;
if (!port) throw new Error("runner parent storage test worker requires parentPort");

let storage: RunnerParentOutboxStorage | undefined;
let storageMode: "normal" | "closed_tail" | "recovery" | undefined;
let currentRequestId = 0;
let gated = false;

const transactionObserver = (event: RunnerSqliteTransactionEvent): void => {
  if (
    mode === "gate"
    && !gated
    && signal
    && release
    && event.transactionLabel === "runner_host.acknowledge_event"
    && event.stage === "commit"
  ) {
    gated = true;
    Atomics.store(signal, 0, 1);
    Atomics.wait(release, 0, 0);
  }
  port.postMessage({ type: "transaction", requestId: currentRequestId, event });
};

let queue = Promise.resolve();
port.on("message", (request: RunnerParentStorageRequest) => {
  queue = queue.then(async () => {
    currentRequestId = request.requestId;
    if (mode === "hang" && request.operation !== "open" && request.operation !== "close") {
      await new Promise(() => {});
    }
    if (mode === "close_without_response" && request.operation === "close") {
      try {
        storage?.close();
      } finally {
        port.close();
      }
      return;
    }
    try {
      const result = await execute(request);
      port.postMessage({
        type: "result",
        requestId: request.requestId,
        operation: request.operation,
        ok: true,
        value: result.value,
        ...(result.snapshot ? { snapshot: result.snapshot } : {}),
      });
      if (request.operation === "close") port.close();
    } catch (error) {
      port.postMessage({
        type: "result",
        requestId: request.requestId,
        operation: request.operation,
        ok: false,
        error: serializeRunnerParentStorageError(error),
      });
    }
  }).catch(() => {
    // The fixture is a test double; the real entry owns production queue
    // error reporting. A broken fixture must not take down the test process.
  });
});

async function execute(
  request: RunnerParentStorageRequest,
): Promise<{ value: unknown; snapshot?: RunnerParentStorageSnapshot }> {
  switch (request.operation) {
    case "open":
      if (request.input.mode === "recovery") {
        storageMode = "recovery";
        storage = undefined;
        return { value: undefined };
      }
      storageMode = request.input.mode;
      storage = await RunnerParentOutboxStorage.open(request.input, {
        transactionObserver,
      });
      return { value: undefined, snapshot: storage.snapshot() };
    case "readBootstrap": {
      const current = requireStorage();
      return { value: await current.readBootstrap(), snapshot: current.snapshot() };
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
    case "readLifecycle":
      if (storage) return { value: storage.readLifecycle() };
      requireRecoveryMode();
      return {
        value: readRunnerSqliteLifecycle(request.input.databasePath),
      };
    case "readAuthoritativeLifecycle": {
      requireRecoveryMode();
      await gateRecoveryRead();
      if (mode === "notice") {
        postNotice({
          type: "summary_notice",
          requestId: currentRequestId,
          kind: "rename_failure",
          error: { name: "Error", message: "persistent lock", code: "EPERM" },
          path: "/tmp/session-a/runner-lifecycle.json",
          consecutiveFailures: 3,
          severity: "error",
        });
        postNotice({
          type: "summary_notice",
          requestId: currentRequestId,
          kind: "rename_recovery",
          path: "/tmp/session-a/runner-lifecycle.json",
          recoveredAfterFailures: 3,
        });
      }
      return {
        value: await readAuthoritativeRunnerLifecycleLocal(request.input.databasePath, {
          ...(request.input.sessionId ? { sessionId: request.input.sessionId } : {}),
        }),
      };
    }
    case "readClosedTail": {
      requireRecoveryMode();
      return {
        value: readClosedRunnerTailStateLocal(
          request.input.databasePath,
          request.input.sessionId,
        ),
      };
    }
    case "readSqliteIdentity": {
      requireRecoveryMode();
      return { value: readRunnerSqliteIdentityLocal(request.input.databasePath) };
    }
    case "inspectDurableState": {
      requireRecoveryMode();
      return { value: await inspectRunnerDurableStateLocal(request.input.registration) };
    }
    case "probeDurableRetention": {
      requireRecoveryMode();
      return { value: await probeRunnerDurableRetentionLocal(request.input.registration) };
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
    case "close":
      if (storageMode !== "recovery") requireStorage().close();
      return { value: undefined };
    default:
      throw new Error(`runner parent storage test worker does not implement ${request.operation}`);
  }
}

async function gateRecoveryRead(): Promise<void> {
  if (mode !== "gate" || gated || !signal || !release) return;
  gated = true;
  Atomics.store(signal, 0, 1);
  await new Promise<void>((resolve) => {
    const wait = () => {
      if (Atomics.load(release, 0) !== 0) {
        resolve();
        return;
      }
      setTimeout(wait, 5);
    };
    wait();
  });
}

function postNotice(message: RunnerParentStorageWorkerMessage): void {
  port!.postMessage(message);
}

function requireStorage(): RunnerParentOutboxStorage {
  if (storageMode === "recovery") {
    throw new Error("runner parent storage operation is not available in recovery mode");
  }
  if (!storage) throw new Error("runner parent storage test worker is not open");
  return storage;
}

function requireRecoveryMode(): void {
  if (storageMode !== "recovery") {
    throw new Error("runner parent recovery operation requires recovery mode");
  }
}
