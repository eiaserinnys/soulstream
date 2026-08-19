import type { ExecutionOwnershipObservation } from
  "../task/execution_ownership.js";
import type { Task } from "../task/task_models.js";
import { isTerminalTaskStatus } from "../task/task_models.js";
import type { RunnerRecoveryCoordinatorOptions } from
  "./runner_recovery_coordinator_options.js";
import type { RunnerRegistration } from "./runner_process_registry.js";
import { executionOwnershipEvidenceHash } from
  "./execution_ownership_observation_evidence.js";

type OwnerNullExecutionReconcilerOptions = Pick<
  RunnerRecoveryCoordinatorOptions,
  "taskManager" | "scanIntervalMs" | "leaseTimeoutMs" | "now"
>;

export class OwnerNullExecutionReconciler {
  private readonly observations = new Map<string, ExecutionOwnershipObservation>();

  constructor(private readonly options: OwnerNullExecutionReconcilerOptions) {}

  prune(registrations: RunnerRegistration[]): void {
    const scannedSessionIds = new Set(
      registrations.map((registration) => registration.config.sessionId),
    );
    for (const sessionId of this.observations.keys()) {
      if (!scannedSessionIds.has(sessionId)) this.observations.delete(sessionId);
    }
  }

  async reconcile(
    task: Task,
    registration: RunnerRegistration,
  ): Promise<"proceed" | "wait" | "terminal"> {
    if (
      task.hydratedFromDb !== true
      || task.status !== "running"
      || task.executionOwnership !== undefined
    ) return "proceed";

    const reconcile = this.options.taskManager.reconcileExecutionOwnershipObservations;
    if (!reconcile) {
      throw new Error("owner-null execution reconciliation is not configured");
    }
    const observedAt = new Date((this.options.now ?? Date.now)());
    const current = ownershipObservation(registration, observedAt);
    const minimumLeaseIntervalMs = Math.max(
      1,
      Math.min(this.options.scanIntervalMs, this.options.leaseTimeoutMs),
    );
    const first = this.observations.get(task.agentSessionId);
    if (!first) {
      const applied = await reconcile.call(this.options.taskManager, task, {
        first: current,
        second: current,
        evidenceHash: executionOwnershipEvidenceHash(current, current),
        minimumLeaseIntervalMs,
        probeOnly: true,
      });
      if (applied) return "proceed";
      if (isTerminalTaskStatus(task.status)) return "terminal";
      this.observations.set(task.agentSessionId, current);
      return "wait";
    }
    if (observedAt.getTime() - first.observedAt.getTime() < minimumLeaseIntervalMs) {
      return "wait";
    }

    this.observations.delete(task.agentSessionId);
    const applied = await reconcile.call(this.options.taskManager, task, {
      first,
      second: current,
      evidenceHash: executionOwnershipEvidenceHash(first, current),
      minimumLeaseIntervalMs,
      probeOnly: false,
    });
    if (applied) return "proceed";
    return isTerminalTaskStatus(task.status) ? "terminal" : "wait";
  }
}

function ownershipObservation(
  registration: RunnerRegistration,
  observedAt: Date,
): ExecutionOwnershipObservation {
  return {
    manifestId: registration.config.releaseManifestId ?? registration.config.codeSha ?? null,
    runtimeEnvIdentity:
      registration.config.runtimeEnvIdentity ?? `legacy:${registration.config.codeSha}`,
    registrationId: registration.registrationId || null,
    pid: registration.pid && registration.pid > 0 ? registration.pid : null,
    startIdentity: registration.pidStartIdentity || null,
    executionCommandId: registration.lifecycle?.execution_command_id || null,
    observedAt,
  };
}
