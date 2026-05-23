import type { Logger } from "pino";

import type { SSEEventPayload } from "../engine/protocol.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";

import type { Task } from "./task_models.js";

export interface TaskEngineFailureRecoveryDeps {
  broadcaster: SessionBroadcaster;
  logger: Logger;
}

/**
 * Owns recovery after EnginePort.execute throws while draining a turn.
 *
 * Final-state persistence stays in TaskLifecycleTransition. Engine-yielded event
 * persistence stays in TaskEngineEventPublisher. The queued-intervention skip
 * notice remains a wire-only recovery notification to preserve the existing
 * event history contract.
 */
export class TaskEngineFailureRecovery {
  constructor(private readonly deps: TaskEngineFailureRecoveryDeps) {}

  async recoverFromExecuteFailure(task: Task, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    this.deps.logger.warn(
      { err, sessionId: task.agentSessionId },
      "engine.execute drain threw",
    );

    if (task.status === "running") {
      task.status = "error";
      task.error = message;
    }

    await this.notifySkippedQueuedInterventions(task);
  }

  private async notifySkippedQueuedInterventions(task: Task): Promise<void> {
    if (task.interventionQueue.length === 0) return;

    const skipped = task.interventionQueue.length;
    task.interventionQueue = [];

    try {
      await this.deps.broadcaster.emitEventEnvelope(task.agentSessionId, {
        type: "error",
        message: `Turn failed; ${skipped} queued intervention(s) skipped`,
        fatal: false,
      } as SSEEventPayload);
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "queue-skipped error broadcast failed",
      );
    }
  }
}
