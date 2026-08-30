import type { Logger } from "pino";

import type { EventPersistence } from "../db/event_persistence.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";

import type { InterventionMessage, Task } from "./task_models.js";
import { publishInterventionSent } from "./task_intervention_events.js";

export type RunningInterventionResult = { delivered: true };

export interface RunningInterventionTransitionDeps {
  broadcaster: SessionBroadcaster;
  logger: Logger;
  persistence?: EventPersistence;
}

/**
 * Accepting D is durable in session_deliveries before this boundary. The cancel
 * only asks generation G to yield; its ACK or result never decides ownership.
 */
export class RunningInterventionTransition {
  constructor(private readonly deps: RunningInterventionTransitionDeps) {}

  async deliver(
    task: Task,
    message: InterventionMessage,
  ): Promise<RunningInterventionResult> {
    const deliveryId = message.deliveryId;
    const deliveryClaimOwner = message.deliveryLeaseOwner;
    if (!deliveryId || !deliveryClaimOwner) {
      throw new Error("running intervention requires exact delivery ownership");
    }

    void publishInterventionSent(task, message, this.deps).catch((error) => {
      this.deps.logger.warn(
        { err: error, sessionId: task.agentSessionId, deliveryId },
        "intervention acceptance projection failed",
      );
    });

    const ownership = task.executionOwnership;
    const runner = task.runner;
    if (ownership && runner) {
      void runner.dispatcher.interrupt({
        sessionId: task.agentSessionId,
        executionGeneration: ownership.ownershipGeneration,
        executionCommandId: ownership.executionCommandId,
        deliveryId,
        deliveryClaimOwner,
      }).catch((error) => {
        this.deps.logger.info(
          { err: error, sessionId: task.agentSessionId, deliveryId },
          "generation cancel remained advisory",
        );
      });
    }

    return { delivered: true };
  }
}
