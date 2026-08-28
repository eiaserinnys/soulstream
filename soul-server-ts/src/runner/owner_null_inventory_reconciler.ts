import type { Logger } from "pino";
import type { ExecutionOwnershipObservation } from
  "../task/execution_ownership.js";
import type { OwnerNullRunningSessionRow } from "../db/session_db_types.js";
import type { Task } from "../task/task_models.js";
import type { RunnerRegistration } from "./runner_process_registry.js";
import { emptyExecutionOwnershipObservation } from
  "./execution_ownership_observation_evidence.js";

interface OwnerNullInventoryTaskManager {
  listOwnerNullRunningInventory(
    nodeId: string,
    limit?: number,
  ): Promise<OwnerNullRunningSessionRow[]>;
  hydrateRunnerRecoveryTask(sessionId: string): Promise<Task | null>;
  reconcileExecutionOwnershipObservations(
    task: Task,
    input: {
      first: ExecutionOwnershipObservation;
      second: ExecutionOwnershipObservation;
      leaseExpiresAt: Date;
    },
  ): Promise<boolean>;
}

export class OwnerNullInventoryReconciler {
  private readonly observations = new Map<string, ExecutionOwnershipObservation>();

  constructor(private readonly options: {
    nodeId: string;
    scanIntervalMs: number;
    leaseTimeoutMs: number;
    taskManager: OwnerNullInventoryTaskManager;
    logger: Pick<Logger, "error">;
    now: () => number;
  }) {}

  async reconcile(registrations: RunnerRegistration[]): Promise<void> {
    let inventory: OwnerNullRunningSessionRow[];
    try {
      inventory = await this.options.taskManager.listOwnerNullRunningInventory(
        this.options.nodeId,
      );
    } catch (error) {
      this.options.logger.error(
        { err: error, nodeId: this.options.nodeId },
        "owner-null running inventory read failed",
      );
      return;
    }
    const registeredSessionIds = new Set(
      registrations.map((registration) => registration.config.sessionId),
    );
    const absent = inventory.filter(
      (row) => !registeredSessionIds.has(row.session_id),
    );
    const absentSessionIds = new Set(absent.map((row) => row.session_id));
    for (const sessionId of this.observations.keys()) {
      if (!absentSessionIds.has(sessionId)) this.observations.delete(sessionId);
    }
    for (const row of absent) {
      try {
        await this.reconcileAbsentRegistration(row);
      } catch (error) {
        this.options.logger.error(
          { err: error, sessionId: row.session_id },
          "owner-null running inventory reconciliation failed",
        );
      }
    }
  }

  private async reconcileAbsentRegistration(
    row: OwnerNullRunningSessionRow,
  ): Promise<void> {
    const task = await this.options.taskManager.hydrateRunnerRecoveryTask(row.session_id);
    if (!task || task.status !== "running" || task.executionOwnership) {
      this.observations.delete(row.session_id);
      return;
    }
    const current = emptyExecutionOwnershipObservation(new Date(this.options.now()));
    const minimumLeaseIntervalMs = Math.max(
      1,
      Math.min(this.options.scanIntervalMs, this.options.leaseTimeoutMs),
    );
    const first = this.observations.get(row.session_id);
    if (!first) {
      this.observations.set(row.session_id, current);
      return;
    }
    if (current.observedAt.getTime() - first.observedAt.getTime() < minimumLeaseIntervalMs) {
      return;
    }
    await this.options.taskManager.reconcileExecutionOwnershipObservations(task, {
      first,
      second: current,
      leaseExpiresAt: new Date(current.observedAt.getTime() + this.options.leaseTimeoutMs),
    });
    this.observations.delete(row.session_id);
  }
}
