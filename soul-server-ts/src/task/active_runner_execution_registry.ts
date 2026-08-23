import type { TaskRunnerRuntime } from "../runner/task_runner_runtime.js";
import type { ExecutionOwnershipToken } from "./execution_ownership.js";
import type { Task } from "./task_models.js";

export interface ActiveRunnerExecution {
  task: Task;
  promise: Promise<void>;
  runner: TaskRunnerRuntime;
  ownership: ExecutionOwnershipToken;
}

export interface DiscoveredRunnerRegistration {
  sessionId: string;
  registrationId: string | null;
}

interface TrackedExecution {
  task: Task;
  promise: Promise<void>;
  runner?: TaskRunnerRuntime;
  ownership?: ExecutionOwnershipToken;
}

/**
 * Keeps the host execution lifecycle independent from mutable Task pointers.
 *
 * Recovery is allowed to replace `task.runner` and `task.executionPromise`.
 * Those fields are routing conveniences, not ownership of the promise or the
 * dispatcher that must settle it. This registry retains the exact pair until
 * the promise itself settles.
 */
export class ActiveRunnerExecutionRegistry {
  private readonly byPromise = new Map<Promise<void>, TrackedExecution>();

  track(task: Task, promise: Promise<void>): () => void {
    const execution: TrackedExecution = {
      task,
      promise,
      ...(task.runner ? { runner: task.runner } : {}),
      ...(task.executionOwnership ? { ownership: task.executionOwnership } : {}),
    };
    this.byPromise.set(promise, execution);
    return () => this.byPromise.delete(promise);
  }

  attach(task: Task, runner: TaskRunnerRuntime): void {
    const execution = task.executionPromise
      ? this.byPromise.get(task.executionPromise)
      : undefined;
    if (execution) execution.runner = runner;
  }

  bindOwnership(task: Task, ownership: ExecutionOwnershipToken): void {
    const execution = task.executionPromise
      ? this.byPromise.get(task.executionPromise)
      : undefined;
    if (execution) execution.ownership = ownership;
  }

  missingRegistrations(
    discoveredRegistrations: readonly DiscoveredRunnerRegistration[],
  ): ActiveRunnerExecution[] {
    const protectedSessions = new Set(
      discoveredRegistrations
        .filter(({ registrationId }) => registrationId === null)
        .map(({ sessionId }) => sessionId),
    );
    const discoveredIdentities = new Set(
      discoveredRegistrations.flatMap(({ sessionId, registrationId }) =>
        registrationId === null ? [] : [`${sessionId}:${registrationId}`]),
    );
    const missing: ActiveRunnerExecution[] = [];
    for (const execution of this.byPromise.values()) {
      if (
        execution.runner
        && execution.ownership
        && execution.ownership.ownerKind !== "in_process"
        && !protectedSessions.has(execution.task.agentSessionId)
        && !discoveredIdentities.has(
          `${execution.task.agentSessionId}:${execution.ownership.registrationId}`,
        )
      ) {
        missing.push({
          task: execution.task,
          promise: execution.promise,
          runner: execution.runner,
          ownership: execution.ownership,
        });
      }
    }
    return missing;
  }
}
