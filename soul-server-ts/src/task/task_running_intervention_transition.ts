import type { Logger } from "pino";

import type { EventPersistence } from "../db/event_persistence.js";
import type {
  LiveTurnSteerStatus,
  SupportsLiveTurnSteering,
} from "../engine/protocol.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";

import { splitAttachmentPaths } from "./attachment_context.js";
import { publishInterventionSent } from "./task_intervention_events.js";
import { markLiveInterventionInFlight } from "./task_live_intervention_invariant.js";
import type { InterventionMessage, Task } from "./task_models.js";

export type RunningInterventionResult =
  | { delivered: true }
  | { queued: true; queuePosition: number; liveSteerStatus?: LiveTurnSteerStatus }
  | { deferred: true; liveSteerStatus?: LiveTurnSteerStatus };

export interface RunningInterventionTransitionDeps {
  broadcaster: SessionBroadcaster;
  logger: Logger;
  persistence?: EventPersistence;
}

/**
 * Running task intervention transition.
 *
 * Owns the ordered side effects for a user intervention that arrives while a
 * task is still running: intervention_sent event construction,
 * persistence/broadcast with _event_id ride-along, optional active-turn live
 * steering, then fallback queueing when live steering is unavailable or fails.
 */
export class RunningInterventionTransition {
  constructor(private readonly deps: RunningInterventionTransitionDeps) {}

  async deliver(
    task: Task,
    message: InterventionMessage,
    options: { queueIfUndelivered?: boolean } = {},
  ): Promise<RunningInterventionResult> {
    const liveCapable = supportsLiveTurnSteering(task.engine);

    if (task.interventionQueue.length > 0) {
      if (options.queueIfUndelivered === false) {
        return { deferred: true, liveSteerStatus: "not_accepting_input" };
      }
      task.interventionQueue.push(message);
      if (!liveCapable) {
        await this.publishIntervention(task, message);
      }
      return {
        queued: true,
        queuePosition: task.interventionQueue.length,
      };
    }

    if (options.queueIfUndelivered === false) {
      const liveSteerStatus = await this.tryLiveSteer(task, message);
      if (liveSteerStatus === "delivered") {
        await this.publishIntervention(task, message);
        markLiveInterventionInFlight(task, message);
        return { delivered: true };
      }
      return {
        deferred: true,
        ...(liveSteerStatus ? { liveSteerStatus } : {}),
      };
    }

    const liveSteerStatus = await this.tryLiveSteer(task, message);
    if (liveSteerStatus === "delivered") {
      await this.publishIntervention(task, message);
      markLiveInterventionInFlight(task, message);
      return { delivered: true };
    }

    task.interventionQueue.push(message);
    if (!liveCapable) {
      await this.publishIntervention(task, message);
    }
    return {
      queued: true,
      queuePosition: task.interventionQueue.length,
      ...(liveSteerStatus ? { liveSteerStatus } : {}),
    };
  }

  private async publishIntervention(
    task: Task,
    message: InterventionMessage,
  ): Promise<void> {
    await publishInterventionSent(task, message, this.deps);
  }

  private async tryLiveSteer(
    task: Task,
    message: InterventionMessage,
  ): Promise<LiveTurnSteerStatus | undefined> {
    if (!supportsLiveTurnSteering(task.engine)) return undefined;

    try {
      const { imagePaths } = splitAttachmentPaths(message.attachmentPaths);
      const steerResult = await task.engine.steerActiveTurn({
        prompt: message.text,
        ...(imagePaths.length > 0
          ? { imageAttachmentPaths: imagePaths }
          : {}),
      });
      if (steerResult.status === "delivered") {
        return "delivered";
      }
      this.deps.logger.warn(
        {
          sessionId: task.agentSessionId,
          status: steerResult.status,
          message: steerResult.message,
        },
        "live turn steer not delivered — queueing intervention fallback",
      );
      return steerResult.status;
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "live turn steer failed — queueing intervention fallback",
      );
      return "failed";
    }
  }
}

function supportsLiveTurnSteering(
  engine: Task["engine"],
): engine is NonNullable<Task["engine"]> & SupportsLiveTurnSteering {
  return Boolean(
    engine &&
      typeof (engine as unknown as Partial<SupportsLiveTurnSteering>).steerActiveTurn ===
        "function",
  );
}
