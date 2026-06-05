import type { Logger } from "pino";

import type { EventPersistence } from "../db/event_persistence.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";

import type { InterventionMessage, Task } from "./task_models.js";

export type RunningInterventionResult =
  | { queued: true; queuePosition: number }
  | { deferred: true };

export interface RunningInterventionTransitionDeps {
  broadcaster: SessionBroadcaster;
  logger: Logger;
  persistence?: EventPersistence;
}

/**
 * Running task intervention transition.
 *
 * Owns the queue policy for a user intervention that arrives while a task is
 * still running. The actual `intervention_sent` wire event is published when
 * TaskExecutor dequeues the message for the next query turn.
 */
export class RunningInterventionTransition {
  constructor(private readonly deps: RunningInterventionTransitionDeps) {}

  async deliver(
    task: Task,
    message: InterventionMessage,
    options: { queueIfUndelivered?: boolean } = {},
  ): Promise<RunningInterventionResult> {
    if (options.queueIfUndelivered === false) {
      this.deps.logger.debug?.(
        { sessionId: task.agentSessionId },
        "running intervention deferred by durable caller policy",
      );
      return { deferred: true };
    }

    task.interventionQueue.push(message);
    return {
      queued: true,
      queuePosition: task.interventionQueue.length,
    };
  }
}
