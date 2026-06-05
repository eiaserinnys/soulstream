import type { Logger } from "pino";

import type { EventPersistence } from "../db/event_persistence.js";
import type {
  EngineUserInput,
  LiveTurnSteerResult,
  SupportsLiveTurnSteering,
} from "../engine/protocol.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";

import type { InterventionMessage, Task } from "./task_models.js";
import { publishInterventionSent } from "./task_intervention_events.js";
import { composeInterventionTurnPrompt } from "./task_turn_loop_transition.js";

export type RunningInterventionResult =
  | { delivered: true }
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
 * Owns live delivery for engines that can accept input during a running turn,
 * then falls back to the queue policy for unsupported or idle-race cases.
 */
export class RunningInterventionTransition {
  constructor(private readonly deps: RunningInterventionTransitionDeps) {}

  async deliver(
    task: Task,
    message: InterventionMessage,
    options: { queueIfUndelivered?: boolean } = {},
  ): Promise<RunningInterventionResult> {
    const liveResult = await this.tryDeliverLive(task, message);
    if (liveResult.status === "delivered") {
      await publishInterventionSent(task, message, this.deps);
      return { delivered: true };
    }

    if (options.queueIfUndelivered === false) {
      this.deps.logger.debug?.(
        { sessionId: task.agentSessionId, liveStatus: liveResult.status },
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

  private async tryDeliverLive(
    task: Task,
    message: InterventionMessage,
  ): Promise<LiveTurnSteerResult> {
    const engine = task.engine;
    if (!isLiveTurnSteeringEngine(engine)) {
      return { status: "not_supported" };
    }

    const input = composeInterventionTurnPrompt(message);
    try {
      return await engine.steerActiveTurn(input);
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "running intervention live delivery failed",
      );
      return {
        status: "failed",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

function isLiveTurnSteeringEngine(
  engine: Task["engine"],
): engine is Task["engine"] & SupportsLiveTurnSteering {
  return Boolean(
    engine && typeof (engine as Partial<SupportsLiveTurnSteering>).steerActiveTurn === "function",
  );
}
