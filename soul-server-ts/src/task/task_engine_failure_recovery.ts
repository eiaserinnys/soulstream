import type { Logger } from "pino";

import type { Task } from "./task_models.js";
import { recordTerminationHint } from "./task_termination.js";

export interface TaskEngineFailureRecoveryDeps {
  logger: Logger;
}

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

  async recoverFromExecuteFailure(task: Task, err: unknown): Promise<void> {
    const message = this.errorMessage(err);
    this.deps.logger.warn(
      { err, sessionId: task.agentSessionId },
      "engine.execute drain threw",
    );

    this.recordError(task, message, { overwriteNonRunning: false });
  }

  async recoverFromOuterExecutionFailure(task: Task, err: unknown): Promise<void> {
    const message = this.errorMessage(err);
    this.deps.logger.error(
      { err, sessionId: task.agentSessionId },
      "Task execution threw outside event stream",
    );

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
  }
}
