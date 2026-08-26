import type { Logger } from "pino";

import type { InterventionMessage, Task } from "./task_models.js";
import { recordTerminationHint } from "./task_termination.js";

export interface TaskEngineFailureRecoveryDeps {
  logger: Logger;
}

export type ExecuteFailureDisposition =
  | "continue_with_accepted_successor"
  | "stop_on_error";

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
  ): Promise<ExecuteFailureDisposition> {
    const message = this.errorMessage(err);
    const successorOwner = distinctAcceptedSuccessorOwner(task, activeInterventions);
    if (task.status === "running" && successorOwner !== undefined) {
      this.deps.logger.info(
        {
          sessionId: task.agentSessionId,
          activeOwners: activeInterventions.map(interventionOwner).filter(Boolean),
          successorOwner,
          interruptedTurnDetail: message,
        },
        "active turn yielded to an accepted conversation entry",
      );
      return "continue_with_accepted_successor";
    }
    this.deps.logger.warn(
      { err, sessionId: task.agentSessionId },
      "engine.execute drain threw",
    );

    this.recordError(task, message, { overwriteNonRunning: false });
    return "stop_on_error";
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

function distinctAcceptedSuccessorOwner(
  task: Task,
  activeInterventions: readonly InterventionMessage[],
): string | undefined {
  const successorOwner = interventionOwner(task.interventionQueue[0]);
  if (successorOwner === undefined) return undefined;
  const activeOwners = new Set(activeInterventions.map(interventionOwner));
  return !activeOwners.has(successorOwner) ? successorOwner : undefined;
}

function interventionOwner(message: InterventionMessage | undefined): string | undefined {
  return message?.runnerInterventionId ?? message?.deliveryId;
}
