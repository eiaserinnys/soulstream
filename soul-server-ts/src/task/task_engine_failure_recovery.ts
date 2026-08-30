import type { Logger } from "pino";

import type { InterventionMessage, Task } from "./task_models.js";
import { recordTerminationHint } from "./task_termination.js";

export interface TaskEngineFailureRecoveryDeps {
  logger: Logger;
}

export type ExecuteFailureDisposition =
  | {
      kind: "continue_with_accepted_successor";
      successorOwner: string;
      source: "queued" | "active";
    }
  | { kind: "stop_on_error" };

/**
 * Owns recovery after engine execution genuinely fails before or while draining a turn.
 *
 * Final-state persistence stays in TaskLifecycleTransition. Engine-yielded event
 * persistence stays in TaskEngineEventPublisher. Native intervention results are
 * owner-fenced inside the engine adapter and never reach this throw-only boundary.
 * Queued interventions remain durable input after a real turn failure.
 */
export class TaskEngineFailureRecovery {
  constructor(private readonly deps: TaskEngineFailureRecoveryDeps) {}

  async recoverFromExecuteFailure(
    task: Task,
    err: unknown,
    activeInterventions: readonly InterventionMessage[] = [],
    attemptedSuccessorOwner?: string,
  ): Promise<ExecuteFailureDisposition> {
    const message = this.errorMessage(err);
    const successor = acceptedSuccessor(
      task,
      activeInterventions,
      attemptedSuccessorOwner,
    );
    if (task.status === "running" && successor !== undefined) {
      this.deps.logger.info(
        {
          sessionId: task.agentSessionId,
          activeOwners: activeInterventions.map(interventionOwner).filter(Boolean),
          successorOwner: successor.owner,
          successorSource: successor.source,
          interruptedTurnDetail: message,
        },
        "active turn yielded to an accepted conversation entry",
      );
      return {
        kind: "continue_with_accepted_successor",
        successorOwner: successor.owner,
        source: successor.source,
      };
    }
    this.deps.logger.warn(
      { err, sessionId: task.agentSessionId },
      "engine.execute drain threw",
    );

    this.recordError(task, message, { overwriteNonRunning: false });
    return { kind: "stop_on_error" };
  }

  async recoverFromOuterExecutionFailure(task: Task, err: unknown): Promise<void> {
    const message = this.errorMessage(err);
    this.deps.logger.error(
      { err, sessionId: task.agentSessionId },
      "Task execution threw outside event stream",
    );

    this.recordError(task, message, { overwriteNonRunning: true });
  }

  recoverFromSynthesizedFailure(task: Task, message: string): void {
    this.recordError(task, message, { overwriteNonRunning: true });
  }

  private errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  private recordError(
    task: Task,
    message: string,
    options: { overwriteNonRunning: boolean },
  ): void {
    if (!options.overwriteNonRunning && task.status !== "running") return;

    recordTerminationHint(task, "error_aborted", message);
    task.status = "error";
    task.error = message;
    task.result = undefined;
  }
}

function acceptedSuccessor(
  task: Task,
  activeInterventions: readonly InterventionMessage[],
  attemptedSuccessorOwner: string | undefined,
): { owner: string; source: "queued" | "active" } | undefined {
  const activeOwners = new Set(activeInterventions.map(interventionOwner));
  const queuedOwner = interventionOwner(task.interventionQueue[0]);
  if (
    queuedOwner !== undefined
    && queuedOwner !== attemptedSuccessorOwner
    && !activeOwners.has(queuedOwner)
  ) {
    return { owner: queuedOwner, source: "queued" };
  }

  if (task.interventionQueue.length > 0) return undefined;
  // A durable delivery is removed from the queue before its turn starts. If
  // that turn is the one the delivery interrupted, the active owner is the
  // accepted successor even though no queued entry remains.
  const activeOwner = activeInterventions.map(interventionOwner).find(Boolean);
  return activeOwner !== undefined && activeOwner !== attemptedSuccessorOwner
    ? { owner: activeOwner, source: "active" }
    : undefined;
}

function interventionOwner(message: InterventionMessage | undefined): string | undefined {
  return message?.runnerInterventionId ?? message?.deliveryId;
}
