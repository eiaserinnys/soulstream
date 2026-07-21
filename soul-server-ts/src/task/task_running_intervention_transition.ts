import type { Logger } from "pino";

import type { EventPersistence } from "../db/event_persistence.js";
import type {
  EngineUserInput,
  LiveTurnSteerResult,
  LiveTurnSteerStatus,
  SupportsLiveTurnSteering,
} from "../engine/protocol.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";

import type { InterventionMessage, Task } from "./task_models.js";
import { publishInterventionSent } from "./task_intervention_events.js";
import { composeInterventionTurnPrompt } from "./task_turn_loop_transition.js";

export type RunningInterventionResult =
  | { delivered: true }
  | { steered: true; queuePosition: number }
  | { queued: true; queuePosition: number }
  | { deferred: true };

export interface RunningInterventionTransitionDeps {
  broadcaster: SessionBroadcaster;
  logger: Logger;
  persistence?: EventPersistence;
  liveRetryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Running task intervention transition.
 *
 * Owns live delivery for engines that can accept input during a running turn,
 * then falls back to the queue policy for unsupported or unsafe boundary cases.
 */
export class RunningInterventionTransition {
  constructor(private readonly deps: RunningInterventionTransitionDeps) {}

  async deliver(
    task: Task,
    message: InterventionMessage,
    options: { queueIfUndelivered?: boolean } = {},
  ): Promise<RunningInterventionResult> {
    const publishBeforeDelivery = options.queueIfUndelivered !== false;
    if (publishBeforeDelivery) {
      await publishInterventionSent(task, message, this.deps);
    }

    const steerInterruptResult = await this.tryInterruptForSteer(task, message);
    if (steerInterruptResult) {
      if (!publishBeforeDelivery) {
        await publishInterventionSent(task, message, this.deps);
      }
      return steerInterruptResult;
    }

    const liveResult = await this.tryDeliverLive(task, message);
    if (liveResult.status === "delivered") {
      if (!publishBeforeDelivery) {
        await publishInterventionSent(task, message, this.deps);
      }
      return { delivered: true };
    }

    const retryResult = await this.retryTransientBoundary(task, message, liveResult);
    if (retryResult?.status === "delivered") {
      if (!publishBeforeDelivery) {
        await publishInterventionSent(task, message, this.deps);
      }
      return { delivered: true };
    }
    const finalLiveResult = retryResult ?? liveResult;

    if (options.queueIfUndelivered === false) {
      this.deps.logger.debug?.(
        { sessionId: task.agentSessionId, liveStatus: finalLiveResult.status },
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

  private async tryInterruptForSteer(
    task: Task,
    message: InterventionMessage,
  ): Promise<RunningInterventionResult | null> {
    const engine = task.engine;
    if (!isSteerInterruptEngine(engine)) {
      return null;
    }

    task.interventionQueue.push(message);
    const queuePosition = task.interventionQueue.length;

    try {
      const interrupted = await engine.interruptForSteer();
      if (interrupted) {
        return { steered: true, queuePosition };
      }
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "running intervention steer interrupt failed",
      );
    }

    this.deps.logger.debug?.(
      { sessionId: task.agentSessionId },
      "running intervention queued after steer interrupt race",
    );
    return { queued: true, queuePosition };
  }

  private async retryTransientBoundary(
    task: Task,
    message: InterventionMessage,
    liveResult: LiveTurnSteerResult,
  ): Promise<LiveTurnSteerResult | null> {
    if (!isTransientSteerBoundary(liveResult.status)) return null;
    const delayMs = this.deps.liveRetryDelayMs ?? 50;
    if (delayMs > 0) {
      await (this.deps.sleep ?? sleep)(delayMs);
    }
    const retryResult = await this.tryDeliverLive(task, message);
    if (retryResult.status !== "delivered") {
      this.deps.logger.debug?.(
        {
          sessionId: task.agentSessionId,
          initialLiveStatus: liveResult.status,
          retryLiveStatus: retryResult.status,
        },
        "running intervention live delivery boundary retry did not deliver",
      );
    }
    return retryResult;
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

function isTransientSteerBoundary(status: LiveTurnSteerStatus): boolean {
  return status === "no_active_turn" || status === "not_accepting_input";
}

function isLiveTurnSteeringEngine(
  engine: Task["engine"],
): engine is Task["engine"] & SupportsLiveTurnSteering {
  return Boolean(
    engine && typeof (engine as Partial<SupportsLiveTurnSteering>).steerActiveTurn === "function",
  );
}

function isSteerInterruptEngine(
  engine: Task["engine"],
): engine is Task["engine"] &
  SupportsLiveTurnSteering &
  Required<Pick<SupportsLiveTurnSteering, "interruptForSteer">> {
  return Boolean(
    engine && typeof (engine as Partial<SupportsLiveTurnSteering>).interruptForSteer === "function",
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
