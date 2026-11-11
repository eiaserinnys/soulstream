import type { ClaudeAccountTurnState } from "../engine/claude_account_pool.js";
import type { EventOutboxBatch, EventOutboxRecord } from "../upstream/event_outbox.js";
import type {
  EventOutboxQuarantineInput,
  EventOutboxQuarantineResult,
} from "../upstream/event_outbox_quarantine.js";
import type { ClosedRunnerTailState } from "./closed_runner_tail_state.js";
import type { RunnerEventFrame } from "./frame_protocol.js";
import type { RunnerPhaseContext } from "./runner_phase_observation.js";
import type {
  RunnerDurableInspection,
  RunnerDurableRetentionProbe,
  RunnerRegistration,
} from "./runner_process_registry.js";
import type {
  RunnerHostCallAppliedReceipt,
  RunnerHostInterventionFallback,
} from "./runner_host_state_store.js";
import type { RecoveredRunnerIdentity } from "./runner_registration_identity.js";
import type { RunnerSqliteTransactionEvent } from "./runner_sqlite_connection.js";
import type { RunnerBootstrapRecord } from "./sqlite_event_outbox.js";
import type { RunnerLifecycleRecord } from "./sqlite_runner_lifecycle.js";

export type RunnerParentStorageBootstrap = RunnerBootstrapRecord;
export type RunnerParentStorageBatch = EventOutboxBatch;
export type RunnerParentStorageRecord = EventOutboxRecord;
export type RunnerParentStorageFallback = RunnerHostInterventionFallback;
export type RunnerParentStorageReceipt = RunnerHostCallAppliedReceipt;
export type RunnerParentStorageQuarantineInput = EventOutboxQuarantineInput;
export type RunnerParentStorageQuarantineResult = EventOutboxQuarantineResult;

export type RunnerParentStoragePendingFrame = {
  frame_seq: number;
  outbox_source_seq: number;
  frame: Extract<RunnerEventFrame, { kind: "engine_event" }>;
};

export type RunnerParentStoragePendingIntervention = {
  interventionId: string;
  message: Record<string, unknown>;
};

export type RunnerParentStorageInterventionInspection = {
  interventions: RunnerParentStoragePendingIntervention[];
  childInterventionIds: string[];
  shadowedFallbackIds: string[];
};

export type RunnerParentStorageAppliedReceiptInput = {
  correlationId: string;
  service: string;
  operation: string;
  createdAt: string;
};

export type RunnerParentStorageOutboxOpenInput = {
  mode: "normal" | "closed_tail";
  databasePath: string;
  sessionId: string;
};

export type RunnerParentStorageRecoveryInput = {
  databasePath: string;
  sessionId?: string;
};

export type RunnerParentStorageOperationMap = {
  open: {
    input: RunnerParentStorageOutboxOpenInput | { mode: "recovery" };
    output: void;
  };
  readBootstrap: { input: undefined; output: RunnerParentStorageBootstrap | null };
  readBatch: { input: { maxEvents?: number }; output: RunnerParentStorageBatch | null };
  acknowledge: {
    input: { streamId: string; acknowledgedThrough: number };
    output: void;
  };
  quarantineHead: {
    input: RunnerParentStorageQuarantineInput;
    output: RunnerParentStorageQuarantineResult;
  };
  readRecord: { input: { sourceSeq: number }; output: RunnerParentStorageRecord | null };
  readLatestPendingRecord: { input: undefined; output: RunnerParentStorageRecord | null };
  readPendingIpcFrames: { input: undefined; output: RunnerParentStoragePendingFrame[] };
  inspectPendingInterventions: {
    input: undefined;
    output: RunnerParentStorageInterventionInspection;
  };
  readInterventionFallback: {
    input: { interventionId: string };
    output: RunnerParentStorageFallback | null;
  };
  removeInterventionFallback: {
    input: { interventionId: string };
    output: void;
  };
  hasPendingDurableWork: { input: undefined; output: boolean };
  readHostCallApplied: {
    input: { correlationId: string };
    output: RunnerParentStorageReceipt | null;
  };
  recordHostCallApplied: {
    input: RunnerParentStorageAppliedReceiptInput;
    output: void;
  };
  acknowledgeHostCall: {
    input: { correlationId: string };
    output: void;
  };
  readLifecycle: {
    input: RunnerParentStorageRecoveryInput;
    output: RunnerLifecycleRecord | null;
  };
  readAuthoritativeLifecycle: {
    input: RunnerParentStorageRecoveryInput;
    output: RunnerLifecycleRecord | null;
  };
  readClosedTail: {
    input: { databasePath: string; sessionId: string };
    output: ClosedRunnerTailState;
  };
  readSqliteIdentity: {
    input: { databasePath: string };
    output: RecoveredRunnerIdentity | null;
  };
  inspectDurableState: {
    input: { registration: RunnerRegistration };
    output: RunnerDurableInspection;
  };
  probeDurableRetention: {
    input: { registration: RunnerRegistration };
    output: RunnerDurableRetentionProbe;
  };
  readClaudeAccountTurnState: {
    input: { databasePath: string; sessionId: string };
    output: ClaudeAccountTurnState | null;
  };
  prepareRunnerDatabase: {
    input: { databasePath: string };
    output: void;
  };
  close: { input: undefined; output: void };
};

export type RunnerParentStorageOperation = keyof RunnerParentStorageOperationMap;

export type RunnerParentStorageRequest = {
  [K in RunnerParentStorageOperation]: {
    type: "request";
    requestId: number;
    operation: K;
    input: RunnerParentStorageOperationMap[K]["input"];
  };
}[RunnerParentStorageOperation];

export type RunnerParentStorageSnapshot = {
  bootstrap: RunnerParentStorageBootstrap | null;
  /** null until the bootstrap and the host checkpoint are prepared. */
  acknowledgedThrough: number | null;
};

export type RunnerParentStorageSerializedError = {
  name: string;
  message: string;
  stack?: string;
  code?: string | number;
  errcode?: number;
  errstr?: string;
  errno?: string | number;
  syscall?: string;
  path?: string;
  cause?: RunnerParentStorageSerializedError;
  errors?: RunnerParentStorageSerializedError[];
};

export type RunnerParentStorageResponse = {
  [K in RunnerParentStorageOperation]:
    | {
      type: "result";
      requestId: number;
      operation: K;
      ok: true;
      value: RunnerParentStorageOperationMap[K]["output"];
      snapshot?: RunnerParentStorageSnapshot;
    }
    | {
      type: "result";
      requestId: number;
      operation: K;
      ok: false;
      error: RunnerParentStorageSerializedError;
    };
}[RunnerParentStorageOperation];

export type RunnerParentStorageObservation =
  | {
    type: "phase_begin";
    requestId: number;
    phaseId: number;
    phase: string;
    context: RunnerPhaseContext;
    startedAtMonoMs: number;
  }
  | {
    type: "phase_end";
    requestId: number;
    phaseId: number;
    elapsedMs: number;
    error?: RunnerParentStorageSerializedError;
  }
  | {
    type: "transaction";
    requestId: number;
    event: RunnerSqliteTransactionEvent;
  }
  | RunnerParentStorageLifecycleSummaryNotice;

export type RunnerParentStorageLifecycleSummaryNotice =
  | {
    type: "summary_notice";
    requestId: number;
    kind: "rename_failure";
    error: RunnerParentStorageSerializedError;
    path: string;
    consecutiveFailures: number;
    severity: "warn" | "error";
  }
  | {
    type: "summary_notice";
    requestId: number;
    kind: "rename_recovery";
    path: string;
    recoveredAfterFailures: number;
  };

export type RunnerParentStorageWorkerMessage =
  | RunnerParentStorageResponse
  | RunnerParentStorageObservation;

type ErrorWithDetails = Error & {
  code?: unknown;
  errcode?: unknown;
  errstr?: unknown;
  errno?: unknown;
  syscall?: unknown;
  path?: unknown;
  cause?: unknown;
  errors?: unknown;
};

export function serializeRunnerParentStorageError(
  error: unknown,
): RunnerParentStorageSerializedError {
  const value = error instanceof Error ? error : new Error(String(error));
  const details = value as ErrorWithDetails;
  const serialized: RunnerParentStorageSerializedError = {
    name: value.name,
    message: value.message,
  };
  if (typeof value.stack === "string") serialized.stack = value.stack;
  if (typeof details.code === "string" || typeof details.code === "number") {
    serialized.code = details.code;
  }
  if (typeof details.errcode === "number") serialized.errcode = details.errcode;
  if (typeof details.errstr === "string") serialized.errstr = details.errstr;
  if (typeof details.errno === "string" || typeof details.errno === "number") {
    serialized.errno = details.errno;
  }
  if (typeof details.syscall === "string") serialized.syscall = details.syscall;
  if (typeof details.path === "string") serialized.path = details.path;
  if (details.cause !== undefined) {
    serialized.cause = serializeRunnerParentStorageError(details.cause);
  }
  if (Array.isArray(details.errors)) {
    serialized.errors = details.errors.map((entry) =>
      serializeRunnerParentStorageError(entry));
  }
  return serialized;
}

export function deserializeRunnerParentStorageError(
  serialized: RunnerParentStorageSerializedError,
): Error {
  const cause = serialized.cause
    ? deserializeRunnerParentStorageError(serialized.cause)
    : undefined;
  const options = cause === undefined ? undefined : { cause };
  let error: Error;
  if (serialized.name === "AggregateError") {
    error = new AggregateError(
      (serialized.errors ?? []).map(deserializeRunnerParentStorageError),
      serialized.message,
      options,
    );
  } else if (serialized.name === "TypeError") {
    error = new TypeError(serialized.message, options);
  } else if (serialized.name === "RangeError") {
    error = new RangeError(serialized.message, options);
  } else {
    error = new Error(serialized.message, options);
  }
  error.name = serialized.name;
  if (serialized.stack !== undefined) error.stack = serialized.stack;
  const details = error as ErrorWithDetails;
  if (serialized.code !== undefined) details.code = serialized.code;
  if (serialized.errcode !== undefined) details.errcode = serialized.errcode;
  if (serialized.errstr !== undefined) details.errstr = serialized.errstr;
  if (serialized.errno !== undefined) details.errno = serialized.errno;
  if (serialized.syscall !== undefined) details.syscall = serialized.syscall;
  if (serialized.path !== undefined) details.path = serialized.path;
  return error;
}
