import type { Logger } from "pino";

import type { EventPersistence } from "../db/event_persistence.js";
import { ExecutionOwnershipCoordinator } from "./execution_ownership_coordinator.js";

import {
  isActiveTaskStatus,
  isTerminalTaskStatus,
  type Task,
} from "./task_models.js";
import {
  runnerFactProjection,
  type RunnerTerminalFact,
} from "./execution_ownership.js";
import { reviewStateAfterTerminal } from "./session_review.js";
import { applyCanonicalSessionProjection } from
  "./task_canonical_session_projection.js";
import {
  buildSessionEndedEvent,
  finalizeTaskTermination,
  recordTerminationHint,
} from "./task_termination.js";
import { releaseTaskRunner } from "./task_runner_release.js";

export interface ExternalFinalizeParams {
  result?: string;
  error?: string;
  llmUsage?: Record<string, number> | null;
}

interface TaskLifecycleTransitionDeps {
  logger: Logger;
  persistence?: EventPersistence;
}

export interface TaskFinalStatePersistenceResult {
  newlyFinalized: boolean;
  terminalTransitionApplied: boolean;
}

const USER_STOP_PROJECTION = {
  true: {
    status: "interrupted",
    error: undefined,
    terminationReason: "killed",
    terminationDetail: "user_stop",
  },
  false: {
    status: "error",
    error: "runner stop was not confirmed",
    terminationReason: "error_aborted",
    terminationDetail: "runner stop was not confirmed",
  },
} as const;

/** A repeated user stop succeeds only after every execution projection converged. */
export function isUserStopConverged(task: Task | undefined): boolean {
  return Boolean(
    task
    && isTerminalTaskStatus(task.status)
    && !task.executionOwnership
    && !task.recoveredExecutionOwnership
    && !task.runner
    && !task.executionPromise,
  );
}

export class TaskLifecycleTransition {
  private readonly executionOwnership?: ExecutionOwnershipCoordinator;

  constructor(private readonly deps: TaskLifecycleTransitionDeps) {
    this.executionOwnership = deps.persistence
      ? new ExecutionOwnershipCoordinator(deps.persistence, deps.logger)
      : undefined;
  }

  async cancelRunningTask(task: Task | undefined): Promise<boolean> {
    if (!task) return false;
    if (isUserStopConverged(task)) {
      task.interruptRequest = undefined;
      return true;
    }
    if (task.interruptRequest) {
      const previousRequest = task.interruptRequest;
      await previousRequest.catch(() => false);
      if (isUserStopConverged(task)) {
        task.interruptRequest = undefined;
        return true;
      }
      if (task.interruptRequest !== previousRequest) {
        return await task.interruptRequest;
      }
      const retry = this.retryUserStopFinalization(task);
      task.interruptRequest = retry;
      return await retry;
    }
    if (!isActiveTaskStatus(task.status)) return false;
    if (!task.runner) return false;

    const runner = task.runner;
    const executionPromise = task.executionPromise;
    const request = (async (): Promise<boolean> => {
      let interrupted = false;
      try {
        interrupted = await runner.dispatcher.interrupt();
      } catch (err) {
        this.deps.logger.warn(
          { err, sessionId: task.agentSessionId },
          "Runner interrupt delivery failed; fencing task as stop_failed",
        );
      }
      return await this.finalizeUserStop(
        task,
        runner,
        executionPromise,
        interrupted,
      );
    })();
    task.interruptRequest = request;
    return await request;
  }

  private retryUserStopFinalization(task: Task): Promise<boolean> {
    if (!task.runner) return Promise.resolve(false);
    return this.finalizeUserStop(
      task,
      task.runner,
      task.executionPromise,
      task.pendingTerminationHint === "killed",
    );
  }

  private async finalizeUserStop(
    task: Task,
    runner: NonNullable<Task["runner"]>,
    executionPromise: Promise<void> | undefined,
    interrupted: boolean,
  ): Promise<boolean> {
    if (isActiveTaskStatus(task.status)) {
      const projection = USER_STOP_PROJECTION[String(interrupted) as "true" | "false"];
      task.status = projection.status;
      task.completedAt ??= new Date();
      task.error = projection.error;
      recordTerminationHint(
        task,
        projection.terminationReason,
        projection.terminationDetail,
      );
    }

    const stopCompletedAt = task.completedAt ?? new Date();
    task.completedAt = stopCompletedAt;
    try {
      await this.persistFinalState(task, true);
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "Explicit stop terminal persistence failed; awaiting explicit retry",
      );
      return false;
    }
    if (!isTerminalTaskStatus(task.status)) {
      task.completedAt = stopCompletedAt;
      return false;
    }

    try {
      await runner.dispatcher.close();
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "runner close failed after explicit stop was fenced",
      );
    }
    releaseTaskRunner(task, runner);
    if (task.executionPromise === executionPromise) {
      task.executionPromise = undefined;
    }
    task.interruptRequest = undefined;
    return interrupted;
  }

  async interruptAndDrain(task: Task): Promise<void> {
    if (!task.runner) return;

    try {
      await task.runner.dispatcher.interrupt();
    } catch {
      // interrupt is idempotent; cleanup must continue.
    }
    if (task.executionPromise) {
      try {
        await task.executionPromise;
      } catch {
        // interrupted execution rejection must not block cleanup.
      }
    }
  }

  async markRunningTaskInterruptedForShutdown(
    task: Task,
    shutdownAt: Date,
  ): Promise<void> {
    if (!isActiveTaskStatus(task.status)) return;

    task.status = "interrupted";
    task.completedAt = shutdownAt;
    recordTerminationHint(task, "killed", "shutdown");
    await this.persistFinalState(task);
  }

  async interruptForShutdown(task: Task): Promise<void> {
    if (!task.runner) return;

    try {
      await task.runner.dispatcher.interrupt();
    } catch {
      // idempotent; shutdown drain collection must continue.
    }
  }

  getDrainPromise(task: Task): Promise<void> | undefined {
    return task.executionPromise?.catch(() => undefined);
  }

  async finalizeExternalTask(
    task: Task,
    params: ExternalFinalizeParams,
  ): Promise<Task> {
    if (params.result !== undefined) {
      task.status = "completed";
      task.result = params.result;
      task.error = undefined;
    } else {
      task.status = "error";
      task.error = params.error;
      task.result = undefined;
    }
    task.completedAt = new Date();
    if (params.llmUsage !== undefined) {
      task.llmUsage = params.llmUsage;
    }

    await this.persistFinalState(task);
    return task;
  }

  async persistExecutorFinalState(task: Task): Promise<TaskFinalStatePersistenceResult> {
    return await this.persistFinalState(task);
  }

  async projectRecoveredRunnerTerminalFact(
    task: Task,
    runnerFact: RunnerTerminalFact,
    terminationDetail: string,
  ): Promise<boolean> {
    const ownership = task.recoveredExecutionOwnership;
    if (!ownership) {
      throw new Error("recovered execution ownership identity required");
    }
    if (!this.deps.persistence) {
      throw new Error("recovered runner terminal persistence is required");
    }

    if (!isTerminalTaskStatus(task.status)) {
      const projection = runnerFactProjection(runnerFact);
      task.status = projection.status;
      task.completedAt = new Date();
      task.reviewState = reviewStateAfterTerminal(task.reviewRequired === true);
      task.terminationReason = projection.terminationReason;
      task.terminationDetail = terminationDetail;
      task.pendingTerminationHint = undefined;
      task.pendingTerminationDetail = undefined;
    }
    task.runnerTerminalFact = runnerFact;

    const completedAt = task.completedAt ?? new Date();
    const application =
      await this.deps.persistence.enqueueRecoveredRunnerTerminalFactAndWaitForApplication(
        task.agentSessionId,
        buildSessionEndedEvent(task),
        {
          kind: "recovered_runner_terminal_fact",
          manifest_id: ownership.manifestId,
          registration_id: ownership.registrationId,
          pid: ownership.pid,
          start_identity: ownership.startIdentity,
          execution_command_id: ownership.executionCommandId,
          runner_fact: runnerFact,
          termination_detail: terminationDetail,
          review_state: task.reviewState ?? "not_required",
          last_assistant_text: task.lastAssistantText ?? null,
          updated_at: completedAt.toISOString(),
        },
      );
    applyCanonicalSessionProjection(task, application.canonicalSession);
    return application.applied;
  }

  private async persistFinalState(
    task: Task,
    retryUnrecordedTerminal = false,
  ): Promise<TaskFinalStatePersistenceResult> {
    const termination = finalizeTaskTermination(task);
    if (termination.newlyFinalized) {
      task.reviewState = reviewStateAfterTerminal(task.reviewRequired === true);
    }
    let terminalTransitionApplied = false;
    if (
      (termination.newlyFinalized || retryUnrecordedTerminal)
      && isTerminalTaskStatus(task.status)
      && !task.terminationEventRecorded
    ) {
      terminalTransitionApplied = await this.enqueueAndAwaitSessionEnded(
        task,
        termination.reason,
        termination.detail,
      );
    }
    return {
      newlyFinalized: termination.newlyFinalized,
      terminalTransitionApplied,
    };
  }

  private async enqueueAndAwaitSessionEnded(
    task: Task,
    terminationReason: string,
    terminationDetail: string | null,
  ): Promise<boolean> {
    if (!this.deps.persistence) {
      throw new Error("session_ended durable event persistence is required");
    }
    const event = buildSessionEndedEvent(task);
    const common = {
      termination_detail: terminationDetail,
      review_state: task.reviewState ?? "not_required",
      last_assistant_text: task.lastAssistantText ?? null,
      updated_at: (task.completedAt ?? new Date()).toISOString(),
    };
    const ownership = task.executionOwnership;
    const application = ownership
      ? await this.executionOwnership!.release(
          task.agentSessionId,
          event,
          {
            ownershipGeneration: ownership.ownershipGeneration,
            executionCommandId: ownership.executionCommandId,
            runnerFact: task.runnerTerminalFact ?? runnerFactForTask(task),
            terminationDetail,
            reviewState: task.reviewState ?? "not_required",
            lastAssistantText: task.lastAssistantText ?? null,
            updatedAt: task.completedAt ?? new Date(),
          },
        )
      : task.recoveredExecutionOwnership
        ? await this.deps.persistence.enqueueRecoveredRunnerTerminalFactAndWaitForApplication(
            task.agentSessionId,
            event,
            {
              kind: "recovered_runner_terminal_fact",
              manifest_id: task.recoveredExecutionOwnership.manifestId,
              registration_id: task.recoveredExecutionOwnership.registrationId,
              pid: task.recoveredExecutionOwnership.pid,
              start_identity: task.recoveredExecutionOwnership.startIdentity,
              execution_command_id:
                task.recoveredExecutionOwnership.executionCommandId,
              runner_fact: task.runnerTerminalFact ?? runnerFactForTask(task),
              ...common,
            },
          )
        : await this.deps.persistence.enqueueTerminalTransitionAndWaitForApplication(
          task.agentSessionId,
          event,
          {
            kind: "terminal_transition",
            status: task.status,
            termination_reason: terminationReason,
            ...common,
          },
        );
    applyCanonicalSessionProjection(task, application.canonicalSession);
    if (
      isTerminalTaskStatus(task.status)
      && application.canonicalExecutionOwnership == null
    ) {
      task.executionOwnership = undefined;
      task.recoveredExecutionOwnership = undefined;
    }
    return application.applied;
  }

}

function runnerFactForTask(task: Task): RunnerTerminalFact {
  if (task.status === "completed") return "completed";
  if (task.status === "interrupted") return "closed";
  return "failed";
}
