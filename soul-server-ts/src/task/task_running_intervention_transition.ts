import { randomUUID } from "node:crypto";

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
import { enqueueInterventionOnce } from "./task_intervention_queue.js";
import {
  buildInterventionSentEvent,
  publishInterventionSent,
} from "./task_intervention_events.js";
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
    if (isDurableRunnerQueue(task)) {
      const staged = await this.stageRunnerIntervention(
        task,
        message,
        publishBeforeDelivery,
      );
      return await this.tryInterruptForSteer(task, staged.message)
        ?? { queued: true, queuePosition: enqueueInterventionOnce(task, staged.message) };
    }
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

    const queuePosition = enqueueInterventionOnce(task, message);
    return {
      queued: true,
      queuePosition,
    };
  }

  async queueOnly(
    task: Task,
    message: InterventionMessage,
    options: { publishEvent?: boolean } = {},
  ): Promise<RunningInterventionResult> {
    if (isDurableRunnerQueue(task)) {
      const staged = await this.stageRunnerIntervention(
        task,
        message,
        options.publishEvent !== false,
      );
      const queuePosition = enqueueInterventionOnce(task, staged.message);
      return { queued: true, queuePosition };
    }
    if (options.publishEvent !== false) {
      await publishInterventionSent(task, message, this.deps);
    }
    const queuePosition = enqueueInterventionOnce(task, message);
    return {
      queued: true,
      queuePosition,
    };
  }

  private async tryInterruptForSteer(
    task: Task,
    message: InterventionMessage,
  ): Promise<RunningInterventionResult | null> {
    const engine = task.runner?.engine;
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

  private async stageRunnerIntervention(
    task: Task,
    message: InterventionMessage,
    publishEvent: boolean,
  ): Promise<{ message: InterventionMessage }> {
    const dispatcher = task.runner?.dispatcher;
    if (!dispatcher?.stageIntervention) {
      throw new Error("runner intervention inbox is unavailable");
    }
    const durableMessage: InterventionMessage = {
      ...message,
      runnerInterventionId:
        message.runnerInterventionId ?? message.deliveryId ?? randomUUID(),
    };
    const staged = await dispatcher.stageIntervention({
      interventionId: durableMessage.runnerInterventionId!,
      message: toRunnerJsonRecord(durableMessage),
      ...(publishEvent
        ? { event: buildInterventionSentEvent(durableMessage) }
        : {}),
      queued: true,
    });
    if (publishEvent) {
      const eventId = await dispatcher.waitForSessionAck();
      if (eventId === null || staged.eventSourceSeq === null) {
        throw new Error("runner intervention receipt did not reach its durable ACK boundary");
      }
      task.lastEventId = eventId;
    }
    return { message: durableMessage };
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
    const engine = task.runner?.engine;
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

function isDurableRunnerQueue(task: Task): boolean {
  return task.runner?.eventPersistence === "runner"
    && isSteerInterruptEngine(task.runner.engine);
}

function toRunnerJsonRecord(message: InterventionMessage): Record<string, unknown> {
  return JSON.parse(JSON.stringify(message)) as Record<string, unknown>;
}

function isTransientSteerBoundary(status: LiveTurnSteerStatus): boolean {
  return status === "no_active_turn" || status === "not_accepting_input";
}

function isLiveTurnSteeringEngine(
  engine: NonNullable<Task["runner"]>["engine"] | undefined,
): engine is NonNullable<Task["runner"]>["engine"] & SupportsLiveTurnSteering {
  return Boolean(
    engine && typeof (engine as Partial<SupportsLiveTurnSteering>).steerActiveTurn === "function",
  );
}

function isSteerInterruptEngine(
  engine: NonNullable<Task["runner"]>["engine"] | undefined,
): engine is NonNullable<Task["runner"]>["engine"] &
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
