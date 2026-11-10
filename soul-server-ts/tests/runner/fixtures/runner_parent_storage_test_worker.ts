import { parentPort, workerData } from "node:worker_threads";

import { RunnerParentOutboxStorage } from
  "../../../src/runner/runner_parent_outbox_storage.js";
import {
  serializeRunnerParentStorageError,
  type RunnerParentStorageRequest,
  type RunnerParentStorageSnapshot,
} from "../../../src/runner/runner_parent_storage_protocol.js";
import type { RunnerSqliteTransactionEvent } from
  "../../../src/runner/runner_sqlite_connection.js";

type FixtureMode = "real" | "gate" | "hang" | "close_without_response";

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
    case "close":
      requireStorage().close();
      return { value: undefined };
    default:
      throw new Error(`runner parent storage test worker does not implement ${request.operation}`);
  }
}

function requireStorage(): RunnerParentOutboxStorage {
  if (!storage) throw new Error("runner parent storage test worker is not open");
  return storage;
}
