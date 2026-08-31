import type { Logger } from "pino";

import type { EventPersistence } from "../db/event_persistence.js";
import type {
  EngineInterventionFailureReason,
  EngineInterventionResult,
} from "../engine/protocol.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";

import type { InterventionMessage, Task } from "./task_models.js";
import { buildDeliveryInputUuid } from "./delivery_identity.js";
import { enqueueInterventionOnce } from "./task_intervention_queue.js";
import { publishInterventionSent } from "./task_intervention_events.js";
import { composeInterventionTurnPrompt } from "./task_turn_loop_transition.js";
import { interventionTurnOrigin } from "./turn_origin.js";

export type RunningInterventionResult =
  | { delivered: true }
  | {
      delivered: null;
      reason: "verdict_unknown";
      consumeWhen: null;
    }
  | {
      delivered: false;
      queued: true;
      /** 1-based position after the shared high/low priority comparator, FIFO within a lane. */
      queuePosition: number;
      consumeWhen: "next_turn";
      reason: EngineInterventionFailureReason | "queue_only_policy" | "verdict_unknown";
    }
  | {
      delivered: false;
      deferred: true;
      retryWhen: "engine_available";
      reason: EngineInterventionFailureReason | "verdict_unknown";
    };

export interface RunningInterventionTransitionDeps {
  broadcaster: SessionBroadcaster;
  logger: Logger;
  persistence?: EventPersistence;
}

/**
 * First-class conversation entry for a running task.
 *
 * Delivery failure may preserve an accepted message in the existing queue, but
 * producer intent and backend never select a different conversation path.
 */
export class RunningInterventionTransition {
  constructor(private readonly deps: RunningInterventionTransitionDeps) {}

  async deliver(
    task: Task,
    message: InterventionMessage,
    options: { queueIfUndelivered?: boolean } = {},
  ): Promise<RunningInterventionResult> {
    let releaseTurnBarrier!: () => void;
    const ownTurnBarrier = new Promise<boolean>((resolve) => {
      releaseTurnBarrier = () => resolve(false);
    });
    const previousTurnBarrier = task.interruptRequest;
    const turnBarrier = previousTurnBarrier
      ? Promise.all([previousTurnBarrier, ownTurnBarrier]).then(([interrupted]) => interrupted)
      : ownTurnBarrier;
    task.interruptRequest = turnBarrier;
    try {
      return await this.deliverAfterTurnBarrier(task, message, options);
    } finally {
      releaseTurnBarrier();
      if (task.interruptRequest === turnBarrier) task.interruptRequest = undefined;
    }
  }

  private async deliverAfterTurnBarrier(
    task: Task,
    message: InterventionMessage,
    options: { queueIfUndelivered?: boolean },
  ): Promise<RunningInterventionResult> {
    const publishBeforeDelivery = options.queueIfUndelivered !== false;
    const deliveryMessage = message;
    if (publishBeforeDelivery) {
      await this.publishAcceptance(task, deliveryMessage);
    }

    const initialResult = await this.tryIntervene(task, deliveryMessage);
    if (initialResult.status === "delivered") {
      if (!publishBeforeDelivery) {
        await this.publishAcceptance(task, deliveryMessage);
      }
      return { delivered: true };
    }
    if (options.queueIfUndelivered === false) {
      this.deps.logger.info(
        {
          sessionId: task.agentSessionId,
          delivered: false,
          ...(initialResult.status === "not_delivered"
            ? { mechanism: initialResult.mechanism }
            : {}),
          reason: initialResult.reason,
          retryWhen: "engine_available",
        },
        "running intervention deferred by durable caller policy",
      );
      return {
        delivered: false,
        deferred: true,
        retryWhen: "engine_available",
        reason: initialResult.reason,
      };
    }

    const queuePosition = await this.queueUndelivered(task, deliveryMessage);
    this.logQueued(task, initialResult, queuePosition);
    return {
      delivered: false,
      queued: true,
      queuePosition,
      consumeWhen: "next_turn",
      reason: initialResult.reason,
    };
  }

  async queueOnly(
    task: Task,
    message: InterventionMessage,
    options: { publishEvent?: boolean } = {},
  ): Promise<RunningInterventionResult> {
    if (options.publishEvent !== false) {
      await publishInterventionSent(task, message, this.deps);
    }
    const queuePosition = enqueueInterventionOnce(task, message);
    this.deps.logger.info(
      {
        sessionId: task.agentSessionId,
        delivered: false,
        reason: "queue_only_policy",
        queuePosition,
        consumeWhen: "next_turn",
      },
      "running intervention queued by delivery policy",
    );
    return {
      delivered: false,
      queued: true,
      queuePosition,
      consumeWhen: "next_turn",
      reason: "queue_only_policy",
    };
  }

  private async publishAcceptance(
    task: Task,
    message: InterventionMessage,
  ): Promise<void> {
    await publishInterventionSent(task, message, this.deps);
  }

  private async tryIntervene(
    task: Task,
    message: InterventionMessage,
  ): Promise<EngineInterventionResult> {
    const engine = task.runner?.engine;
    if (!engine) {
      return {
        status: "not_delivered",
        mechanism: "unsupported",
        reason: "not_supported",
        message: "Task runner engine is unavailable",
      };
    }
    const composed = composeInterventionTurnPrompt([message]);
    const inputUuid = message.deliveryId
      ? buildDeliveryInputUuid(message.deliveryId)
      : undefined;
    const input = {
      ...composed,
      ...(inputUuid ? { inputUuid } : {}),
      turnOrigin: interventionTurnOrigin(message, inputUuid),
    };
    try {
      return await engine.intervene(input);
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "running engine intervention failed",
      );
      return {
        status: "unknown",
        reason: "verdict_unknown",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async queueUndelivered(
    task: Task,
    message: InterventionMessage,
  ): Promise<number> {
    return enqueueInterventionOnce(task, message);
  }

  private logQueued(
    task: Task,
    result: Exclude<EngineInterventionResult, { status: "delivered" }>,
    queuePosition: number,
  ): void {
    this.deps.logger.info(
      {
        sessionId: task.agentSessionId,
        delivered: false,
        ...(result.status === "not_delivered" ? { mechanism: result.mechanism } : {}),
        reason: result.reason,
        detail: result.message,
        queuePosition,
        consumeWhen: "next_turn",
      },
      "running intervention not delivered; queued for next turn",
    );
  }
}
