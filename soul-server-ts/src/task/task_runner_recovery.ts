import type { EventPersistence } from "../db/event_persistence.js";
import type { ExecutionOwnershipObservation } from "./execution_ownership.js";
import { applyCanonicalSessionProjection } from
  "./task_canonical_session_projection.js";
import { isTerminalTaskStatus, type Task } from "./task_models.js";
import type { StartExecutionCallback } from "./task_intervention_route.js";
import type { TaskLifecycleTransition } from "./task_lifecycle_transition.js";
import { releaseTaskRunner } from "./task_runner_release.js";

export interface TaskRunnerRecoveryDeps {
  getTask(sessionId: string): Task | undefined;
  loadTask(sessionId: string): Promise<Task | null>;
  rememberTask(task: Task): void;
  lifecycleTransition: TaskLifecycleTransition;
  persistence?: EventPersistence;
}

export interface ExecutionOwnershipReconciliationInput {
  first: ExecutionOwnershipObservation;
  second: ExecutionOwnershipObservation;
  leaseExpiresAt: Date;
}

/**
 * Rehydrates runner-owned tasks and converts an unrecoverable runner lease into
 * the ordinary terminal-error transition. A later explicit input or resume owns
 * any replacement execution.
 */
export class TaskRunnerRecovery {
  constructor(private readonly deps: TaskRunnerRecoveryDeps) {}

  async hydrate(sessionId: string): Promise<Task | null> {
    const active = this.deps.getTask(sessionId);
    if (active) return active;
    const task = await this.deps.loadTask(sessionId);
    if (task) this.deps.rememberTask(task);
    return task;
  }

  async markFailureAndResume(
    task: Task,
    message: string,
    _onResume: StartExecutionCallback,
  ): Promise<void> {
    const runner = task.runner;
    if (runner) releaseTaskRunner(task, runner);
    task.executionPromise = undefined;
    task.status = "error";
    task.error = message;
    task.completedAt = new Date();
    await this.deps.lifecycleTransition.persistExecutorFinalState(task);
  }

  async projectClosed(task: Task, detail: string): Promise<boolean> {
    if (task.terminationEventRecorded) return false;
    const runner = task.runner;
    if (runner) releaseTaskRunner(task, runner);
    task.executionPromise = undefined;
    this.deps.lifecycleTransition.applyRunnerTerminalFact(task, "closed", detail);
    return (
      await this.deps.lifecycleTransition.persistExecutorFinalState(task)
    ).terminalTransitionApplied;
  }

  async reconcileRecordedTerminalExecution(task: Task): Promise<boolean> {
    const terminalEventId = task.terminalEventId;
    if (
      !isTerminalTaskStatus(task.status)
      || !task.terminationEventRecorded
      || typeof terminalEventId !== "number"
      || !Number.isSafeInteger(terminalEventId)
      || terminalEventId <= 0
    ) return false;
    const ownership = task.executionOwnership;
    if (!ownership) return true;
    if (!this.deps.persistence) {
      throw new Error("terminal execution ownership recovery persistence is required");
    }
    const application = await this.deps.persistence
      .reconcileRecordedTerminalExecutionAndWaitForApplication(
        task.agentSessionId,
        {
          ownershipGeneration: ownership.ownershipGeneration,
          manifestId: ownership.manifestId,
          runtimeEnvIdentity: ownership.runtimeEnvIdentity,
          registrationId: ownership.registrationId,
          pid: ownership.pid,
          startIdentity: ownership.startIdentity,
          executionCommandId: ownership.executionCommandId,
          terminalEventId,
          runnerFact: task.runnerTerminalFact ?? runnerFactForTerminalTask(task),
          terminationDetail: task.terminationDetail ?? null,
          reviewState: task.reviewState ?? "not_required",
          lastAssistantText: task.lastAssistantText ?? null,
          updatedAt: new Date(),
        },
      );
    applyCanonicalSessionProjection(task, application.canonicalSession);
    if (application.applied) task.executionOwnership = undefined;
    return application.applied;
  }

  async reconcileExecutionOwnershipObservations(
    _task: Task,
    input: ExecutionOwnershipReconciliationInput,
  ): Promise<boolean> {
    const { first, second } = input;
    const stableCompleteIdentity = (
      typeof first.manifestId === "string"
      && first.manifestId.length > 0
      && typeof first.runtimeEnvIdentity === "string"
      && first.runtimeEnvIdentity.length > 0
      && typeof first.registrationId === "string"
      && first.registrationId.length > 0
      && typeof first.pid === "number"
      && Number.isSafeInteger(first.pid)
      && first.pid > 0
      && typeof first.startIdentity === "string"
      && first.startIdentity.length > 0
      && typeof first.executionCommandId === "string"
      && first.executionCommandId.length > 0
      && second.manifestId === first.manifestId
      && second.runtimeEnvIdentity === first.runtimeEnvIdentity
      && second.registrationId === first.registrationId
      && second.pid === first.pid
      && second.startIdentity === first.startIdentity
      && second.executionCommandId === first.executionCommandId
    ) ? {
        manifestId: first.manifestId,
        runtimeEnvIdentity: first.runtimeEnvIdentity,
        registrationId: first.registrationId,
        pid: first.pid,
        startIdentity: first.startIdentity,
        executionCommandId: first.executionCommandId,
      }
      : undefined;
    if (!stableCompleteIdentity) {
      return false;
    }
    return true;
  }

}

function runnerFactForTerminalTask(task: Task): "completed" | "failed" | "closed" {
  if (task.status === "completed") return "completed";
  if (task.status === "interrupted") return "closed";
  return "failed";
}
