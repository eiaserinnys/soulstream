import type { EventPersistence } from "../db/event_persistence.js";
import type { OwnerNullRunningSessionRow } from "../db/session_db_types.js";
import type { SSEEventPayload } from "../engine/protocol.js";
import type { ExecutionOwnershipObservation } from "./execution_ownership.js";
import { applyCanonicalSessionProjection } from
  "./task_canonical_session_projection.js";
import type { Task } from "./task_models.js";
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
      || ownershipChanged
      || !activeOwnership
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
      throw new Error("execution ownership recovery persistence is required");
    }
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
      const previous = {
        status: task.status,
        completedAt: task.completedAt,
        reviewState: task.reviewState,
        terminationReason: task.terminationReason,
        terminationDetail: task.terminationDetail,
        pendingTerminationHint: task.pendingTerminationHint,
        pendingTerminationDetail: task.pendingTerminationDetail,
        terminationEventRecorded: task.terminationEventRecorded,
        terminalEventId: task.terminalEventId,
      };
      task.status = "interrupted";
      task.completedAt = second.observedAt;
      task.pendingTerminationDetail =
        "owner-null running migration could not prove a stable runner identity";
      task.terminationEventRecorded = false;
      task.terminalEventId = undefined;
      try {
        const result = await this.deps.lifecycleTransition.persistExecutorFinalState(task);
        return result.terminalTransitionApplied;
      } catch (error) {
        Object.assign(task, previous);
        throw error;
      }
    }
    const application =
      await this.deps.persistence.acquireExecutionOwnershipAndWaitForApplication(
        task.agentSessionId,
        {
          ownerKind: "adopted_runner",
          ...stableCompleteIdentity,
          leaseExpiresAt: input.leaseExpiresAt,
          reviewState: task.reviewState ?? "not_required",
        },
      );
    applyCanonicalSessionProjection(task, application.canonicalSession);
    return application.applied;
  }

  async reconcileTerminalExecutionOwnership(
    task: Task,
    row: OwnerNullRunningSessionRow,
  ): Promise<boolean> {
    if (!this.deps.persistence) {
      throw new Error("terminal execution ownership persistence is required");
    }
    const manifestId = row.manifest_id;
    const registrationId = row.registration_id;
    const pid = row.pid;
    const startIdentity = row.start_identity;
    const executionCommandId = row.execution_command_id;
    if (
      !manifestId
      || !registrationId
      || typeof pid !== "number"
      || !startIdentity
      || !executionCommandId
    ) {
      throw new Error(`terminal execution ownership identity incomplete: ${task.agentSessionId}`);
    }
    const updatedAt = new Date();
    const transitionId = [
      "restart-terminal-retire",
      registrationId,
      pid,
      startIdentity,
      executionCommandId,
    ].join(":");
    const event = {
      type: "metadata",
      metadata_type: "execution_ownership_transition",
      value: { transition_id: transitionId, phase: "terminal" },
      timestamp: updatedAt.toISOString(),
      _dedupe_key: `execution_ownership:${task.agentSessionId}:${transitionId}`,
    } as unknown as SSEEventPayload;
    const application = await this.deps.persistence
      .enqueueRecoveredRunnerTerminalFactAndWaitForApplication(
        task.agentSessionId,
        event,
        {
          kind: "recovered_runner_terminal_fact",
          manifest_id: manifestId,
          registration_id: registrationId,
          pid,
          start_identity: startIdentity,
          execution_command_id: executionCommandId,
          runner_fact: task.status === "completed"
            ? "completed"
            : task.status === "interrupted"
              ? "closed"
              : "failed",
          termination_detail:
            task.terminationDetail ?? "terminal ownership survived host restart",
          review_state: task.reviewState ?? "not_required",
          last_assistant_text: task.lastAssistantText ?? null,
          updated_at: updatedAt.toISOString(),
        },
      );
    applyCanonicalSessionProjection(task, application.canonicalSession);
    return application.applied;
  }
}
