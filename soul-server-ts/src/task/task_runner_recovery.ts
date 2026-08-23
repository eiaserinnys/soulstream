import type { EventPersistence } from "../db/event_persistence.js";
import type { ExecutionOwnershipObservation } from "./execution_ownership.js";
import { applyCanonicalSessionProjection } from
  "./task_canonical_session_projection.js";
import { isActiveTaskStatus, type Task } from "./task_models.js";
import type { StartExecutionCallback } from "./task_intervention_route.js";
import type { AutoResumeTransition } from "./task_auto_resume_transition.js";
import type { TaskLifecycleTransition } from "./task_lifecycle_transition.js";
import { releaseTaskRunner } from "./task_runner_release.js";

export interface TaskRunnerRecoveryDeps {
  getTask(sessionId: string): Task | undefined;
  loadTask(sessionId: string): Promise<Task | null>;
  rememberTask(task: Task): void;
  lifecycleTransition: TaskLifecycleTransition;
  autoResumeTransition: AutoResumeTransition;
  persistence?: EventPersistence;
}

export interface ExecutionOwnershipReconciliationInput {
  first: ExecutionOwnershipObservation;
  second: ExecutionOwnershipObservation;
  evidenceHash: string;
  minimumLeaseIntervalMs: number;
  probeOnly: boolean;
}

/**
 * Rehydrates runner-owned tasks and converts an unrecoverable runner lease into
 * the ordinary terminal-error -> auto-resume transition. The explicit error is
 * persisted before a replacement execution is allowed to start.
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
    onResume: StartExecutionCallback,
  ): Promise<void> {
    const runner = task.runner;
    if (runner) releaseTaskRunner(task, runner);
    task.executionPromise = undefined;
    task.status = "error";
    task.error = message;
    task.completedAt = new Date();
    await this.deps.lifecycleTransition.persistExecutorFinalState(task);
    let replacementCallbackStarted = false;
    try {
      await this.deps.autoResumeTransition.resume(task, {
        text: task.prompt,
        user: task.clientId ?? "runner-recovery",
        ...(task.callerInfo ? { callerInfo: task.callerInfo } : {}),
        ...(task.attachmentPaths ? { attachmentPaths: task.attachmentPaths } : {}),
        ...(task.contextItems ? { context: task.contextItems } : {}),
        source: "runner-recovery",
      }, (resumedTask) => {
        replacementCallbackStarted = true;
        onResume(resumedTask);
      }, { publishUserMessage: false });
    } catch (error) {
      // Do not compensate a rejected running CAS: its canonical running owner
      // may be another execution. Only a callback that failed before creating
      // local ownership proves this transition has no executor behind it.
      if (
        !replacementCallbackStarted
        || task.runner !== undefined
        || task.executionPromise !== undefined
      ) throw error;
      task.status = "error";
      task.error = `runner replacement start failed: ${errorMessage(error)}`;
      task.completedAt = new Date();
      await this.deps.lifecycleTransition.persistExecutorFinalState(task);
      throw error;
    }
  }

  async projectClosed(task: Task, detail: string): Promise<boolean> {
    // A closed registration admitted by an earlier scan cannot supersede a
    // replacement that reserved or activated ownership while hydration ran.
    const recoveredOwnership = task.recoveredExecutionOwnership;
    const activeOwnership = task.executionOwnership;
    const ownershipChanged = activeOwnership !== undefined && (
      recoveredOwnership === undefined
      || activeOwnership.manifestId !== recoveredOwnership.manifestId
      || activeOwnership.registrationId !== recoveredOwnership.registrationId
      || activeOwnership.pid !== recoveredOwnership.pid
      || activeOwnership.startIdentity !== recoveredOwnership.startIdentity
      || activeOwnership.executionCommandId !== recoveredOwnership.executionCommandId
    );
    if (
      task.terminationEventRecorded
      || task.executionOwnershipReservation
      || ownershipChanged
      || (task.runner && !activeOwnership && isActiveTaskStatus(task.status))
    ) return false;
    const runner = task.runner;
    if (runner) releaseTaskRunner(task, runner);
    task.executionPromise = undefined;
    return await this.deps.lifecycleTransition.projectRecoveredRunnerTerminalFact(
      task,
      "closed",
      detail,
    );
  }

  async reconcileExecutionOwnershipObservations(
    task: Task,
    input: ExecutionOwnershipReconciliationInput,
  ): Promise<boolean> {
    if (!this.deps.persistence) {
      throw new Error("execution ownership backfill persistence is required");
    }
    const application =
      await this.deps.persistence.backfillExecutionOwnershipAndWaitForApplication(
        task.agentSessionId,
        input,
      );
    applyCanonicalSessionProjection(task, application.canonicalSession);
    return application.applied;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
