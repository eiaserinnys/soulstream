import type { Logger } from "pino";

import type { Task } from "./task_models.js";
import { recordTerminationHint } from "./task_termination.js";

export interface TaskEngineFailureRecoveryDeps {
  logger: Logger;
}

/**
 * Records the one genuine engine-failure outcome. Accepted delivery handoff is
 * resolved before this boundary, so cancel ACKs and transport closure cannot
 * compete with D for the next generation.
 */
export class TaskEngineFailureRecovery {
  constructor(private readonly deps: TaskEngineFailureRecoveryDeps) {}

  async recoverFromExecuteFailure(task: Task, err: unknown): Promise<void> {
    recordEngineFailure(task, err);
    this.deps.logger.warn(
      { err, sessionId: task.agentSessionId },
      "engine execution transport ended before a model terminal event",
    );
  }

  async recoverFromOuterExecutionFailure(task: Task, err: unknown): Promise<void> {
    recordEngineFailure(task, err);
    this.deps.logger.error(
      { err, sessionId: task.agentSessionId },
      "task execution failed outside the event stream",
    );
  }

  recoverFromSynthesizedFailure(task: Task, message: string): void {
    recordEngineFailure(task, message);
    this.deps.logger.warn(
      { sessionId: task.agentSessionId, message },
      "synthesized engine failure recorded",
    );
  }
}

function recordEngineFailure(task: Task, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  task.status = "error";
  task.error = message;
  task.result = undefined;
  recordTerminationHint(task, "error_aborted", message);
}
