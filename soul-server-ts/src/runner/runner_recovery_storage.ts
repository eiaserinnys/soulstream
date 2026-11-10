import type { Worker } from "node:worker_threads";

import type { ClaudeAccountTurnState } from "../engine/claude_account_pool.js";
import type { ClosedRunnerTailState } from "./closed_runner_tail_state.js";
import type { RunnerPhaseObservation } from "./runner_phase_observation.js";
import {
  deserializeRunnerParentStorageError,
  type RunnerParentStorageLifecycleSummaryNotice,
  type RunnerParentStorageRecoveryInput,
} from "./runner_parent_storage_protocol.js";
import {
  RunnerParentStorageWorkerClient,
  type RunnerParentStorageRequestObservation,
} from "./runner_parent_storage_worker_client.js";
import type {
  RunnerDurableInspection,
  RunnerDurableRetentionProbe,
  RunnerRegistration,
} from "./runner_process_registry.js";
import type { RecoveredRunnerIdentity } from "./runner_registration_identity.js";
import type { RunnerLifecycleRecord } from "./sqlite_runner_lifecycle.js";

export interface RunnerRecoveryStorageOptions {
  workerFactory?: (workerData: Record<string, unknown>) => Worker;
}

/**
 * Parent-side facade over one shared recovery-mode storage worker. The worker
 * owns every runner SQLite connection and lifecycle sidecar repair; this class
 * only owns the client and forwards the per-request observation.
 */
export class RunnerRecoveryStorage {
  private clientPromise: Promise<RunnerParentStorageWorkerClient> | undefined;
  private closePromise: Promise<void> | undefined;
  private closed = false;

  constructor(private readonly options: RunnerRecoveryStorageOptions = {}) {}

  async readLifecycle(
    input: RunnerParentStorageRecoveryInput,
    phaseObservation?: RunnerPhaseObservation,
  ): Promise<RunnerLifecycleRecord | null> {
    return await this.run(input, phaseObservation, async (client, observation) =>
      await client.readLifecycle(input, observation));
  }

  async readAuthoritativeLifecycle(
    input: RunnerParentStorageRecoveryInput,
    phaseObservation?: RunnerPhaseObservation,
  ): Promise<RunnerLifecycleRecord | null> {
    return await this.run(input, phaseObservation, async (client, observation) =>
      await client.readAuthoritativeLifecycle(input, observation));
  }

  async readClosedTail(
    input: { databasePath: string; sessionId: string },
    phaseObservation?: RunnerPhaseObservation,
  ): Promise<ClosedRunnerTailState> {
    return await this.run(input, phaseObservation, async (client, observation) =>
      await client.readClosedTail(input, observation));
  }

  async readSqliteIdentity(
    input: { databasePath: string },
    phaseObservation?: RunnerPhaseObservation,
  ): Promise<RecoveredRunnerIdentity | null> {
    return await this.run(input, phaseObservation, async (client, observation) =>
      await client.readSqliteIdentity(input, observation));
  }

  async inspectDurableState(
    registration: RunnerRegistration,
    phaseObservation?: RunnerPhaseObservation,
  ): Promise<RunnerDurableInspection> {
    return await this.run(
      recoveryInputForRegistration(registration),
      phaseObservation,
      async (client, observation) =>
        await client.inspectDurableState({ registration }, observation),
    );
  }

  async probeDurableRetention(
    registration: RunnerRegistration,
    phaseObservation?: RunnerPhaseObservation,
  ): Promise<RunnerDurableRetentionProbe> {
    return await this.run(
      recoveryInputForRegistration(registration),
      phaseObservation,
      async (client, observation) =>
        await client.probeDurableRetention({ registration }, observation),
    );
  }

  async readClaudeAccountTurnState(
    input: { databasePath: string; sessionId: string },
    phaseObservation?: RunnerPhaseObservation,
  ): Promise<ClaudeAccountTurnState | null> {
    return await this.run(input, phaseObservation, async (client, observation) =>
      await client.readClaudeAccountTurnState(input, observation));
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const pending = this.clientPromise;
    this.closePromise = (async () => {
      if (!pending) return;
      const client = await pending.catch(() => undefined);
      if (!client) return;
      await client.close();
    })();
    return this.closePromise;
  }

  private async run<T>(
    input: RunnerParentStorageRecoveryInput,
    phaseObservation: RunnerPhaseObservation | undefined,
    action: (
      client: RunnerParentStorageWorkerClient,
      observation: RunnerParentStorageRequestObservation,
    ) => Promise<T>,
  ): Promise<T> {
    if (this.closed) throw new Error("runner recovery storage is closed");
    const client = await this.ensureClient();
    return await action(client, {
      ...(phaseObservation ? { phaseObservation } : {}),
      databasePath: input.databasePath,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      onSummaryNotice: reportLifecycleSummaryNotice,
    });
  }

  private async ensureClient(): Promise<RunnerParentStorageWorkerClient> {
    const existing = this.clientPromise;
    if (existing) {
      const client = await existing;
      if (!client.isTerminal()) return client;
      this.clientPromise = undefined;
    }
    if (this.closed) throw new Error("runner recovery storage is closed");
    const created = this.openClient();
    this.clientPromise = created;
    try {
      return await created;
    } catch (error) {
      if (this.clientPromise === created) this.clientPromise = undefined;
      throw error;
    }
  }

  private async openClient(): Promise<RunnerParentStorageWorkerClient> {
    const client = new RunnerParentStorageWorkerClient({
      ...(this.options.workerFactory ? { workerFactory: this.options.workerFactory } : {}),
    });
    try {
      await client.openRecovery();
      return client;
    } catch (error) {
      await client.disposeAfterOpenFailure();
      throw error;
    }
  }
}

/**
 * Production composition injects one shared storage. Standalone helpers keep
 * working by owning a temporary facade for the duration of the call.
 */
export async function withRunnerRecoveryStorage<T>(
  storage: RunnerRecoveryStorage | undefined,
  action: (storage: RunnerRecoveryStorage) => Promise<T>,
): Promise<T> {
  if (storage) return await action(storage);
  const temporary = new RunnerRecoveryStorage();
  try {
    return await action(temporary);
  } finally {
    await temporary.close();
  }
}

function recoveryInputForRegistration(
  registration: RunnerRegistration,
): RunnerParentStorageRecoveryInput {
  return {
    databasePath: registration.config.paths.databasePath,
    sessionId: registration.config.sessionId,
  };
}

function reportLifecycleSummaryNotice(
  notice: RunnerParentStorageLifecycleSummaryNotice,
): void {
  if (notice.kind === "rename_failure") {
    const error = deserializeRunnerParentStorageError(notice.error);
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    process.emitWarning(
      `Runner lifecycle summary rename retries exhausted `
      + `(${code}: ${error.message}; consecutive=${notice.consecutiveFailures}; `
      + `severity=${notice.severity}): ${notice.path}`,
      { code: notice.severity === "error"
        ? "RUNNER_LIFECYCLE_SUMMARY_RENAME_PERSISTENT"
        : "RUNNER_LIFECYCLE_SUMMARY_RENAME_FAILED" },
    );
    return;
  }
  process.emitWarning(
    `Runner lifecycle summary rename recovered after ${notice.recoveredAfterFailures} failures: `
    + notice.path,
    { code: "RUNNER_LIFECYCLE_SUMMARY_RENAME_RECOVERED" },
  );
}
