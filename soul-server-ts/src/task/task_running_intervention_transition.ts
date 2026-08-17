import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import type { EventPersistence } from "../db/event_persistence.js";
import type {
  EngineInterventionFailureReason,
  EngineInterventionResult,
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
    const durableRunnerInbox = usesDurableRunnerInterventionInbox(task);
    const deliveryMessage = durableRunnerInbox
      ? withRunnerInterventionId(message)
      : message;
    if (publishBeforeDelivery || durableRunnerInbox) {
      if (!durableRunnerInbox) {
        await this.publishAcceptance(task, deliveryMessage);
      } else {
        try {
          await this.publishAcceptance(task, deliveryMessage);
        } catch (error) {
          const unknown = {
            status: "unknown",
            reason: "verdict_unknown",
            message: error instanceof Error ? error.message : String(error),
          } as const;
          if (options.queueIfUndelivered === false) {
            try {
              await this.discardDurableIntervention(task, deliveryMessage);
              return this.deferredUnknown(task, unknown);
            } catch (discardError) {
              return await this.queueUnknownReceipt(task, deliveryMessage, {
                ...unknown,
                message: formatRecoveryFailure(unknown.message, discardError),
              });
            }
          }
          return await this.queueUnknownReceipt(task, deliveryMessage, unknown);
        }
      }
    }

    const initialResult = await this.tryIntervene(task, deliveryMessage);
    if (initialResult.status === "delivered") {
      if (!publishBeforeDelivery && !durableRunnerInbox) {
        await this.publishAcceptance(task, deliveryMessage);
      }
      return { delivered: true };
    }
    const retryResult = initialResult.status === "unknown"
      ? null
      : await this.retryTransientBoundary(
          task,
          deliveryMessage,
          initialResult,
        );
    if (retryResult?.status === "delivered") {
      if (!publishBeforeDelivery && !durableRunnerInbox) {
        await this.publishAcceptance(task, deliveryMessage);
      }
      return { delivered: true };
    }
    const finalResult = retryResult ?? initialResult;

    // A runner apply timeout leaves an ambiguous replay fence. Preserve the
    // non-runner contract by staging the same message for the next turn:
    // duplicate delivery is recoverable, silently losing the intervention is not.

    if (options.queueIfUndelivered === false) {
      if (durableRunnerInbox) {
        try {
          await this.discardDurableIntervention(task, deliveryMessage);
        } catch (error) {
          // The caller asked not to queue, but an unconfirmed discard cannot be
          // allowed to leave a replay fence that permanently blocks the session.
          // This exceptional path reports the durable fallback explicitly.
          const unknown = {
            status: "unknown",
            reason: "verdict_unknown",
            message: error instanceof Error ? error.message : String(error),
          } as const;
          const queuePosition = await this.queueUndelivered(task, deliveryMessage);
          this.logQueued(task, unknown, queuePosition);
          return {
            delivered: false,
            queued: true,
            queuePosition,
            consumeWhen: "next_turn",
            reason: "verdict_unknown",
          };
        }
      }
      this.deps.logger.info(
        {
          sessionId: task.agentSessionId,
          delivered: false,
          ...(finalResult.status === "not_delivered"
            ? { mechanism: finalResult.mechanism }
            : {}),
          reason: finalResult.reason,
          retryWhen: "engine_available",
        },
        "running intervention deferred by durable caller policy",
      );
      return {
        delivered: false,
        deferred: true,
        retryWhen: "engine_available",
        reason: finalResult.reason,
      };
    }

    const queuePosition = await this.queueUndelivered(task, deliveryMessage);
    this.logQueued(task, finalResult, queuePosition);
    return {
      delivered: false,
      queued: true,
      queuePosition,
      consumeWhen: "next_turn",
      reason: finalResult.reason,
    };
  }

  async queueOnly(
    task: Task,
    message: InterventionMessage,
    options: { publishEvent?: boolean } = {},
  ): Promise<RunningInterventionResult> {
    const deliveryMessage = usesDurableRunnerInterventionInbox(task)
      ? withRunnerInterventionId(message)
      : message;
    let queuePosition: number;
    if (usesDurableRunnerInterventionInbox(task)) {
      queuePosition = await this.stageRunnerQueue(
        task,
        deliveryMessage,
        options.publishEvent !== false,
      );
      enqueueInterventionOnce(task, deliveryMessage);
    } else {
      if (options.publishEvent !== false) {
        await publishInterventionSent(task, deliveryMessage, this.deps);
      }
      queuePosition = enqueueInterventionOnce(task, deliveryMessage);
    }
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
    if (!usesDurableRunnerInterventionInbox(task)) {
      await publishInterventionSent(task, message, this.deps);
      return;
    }
    await this.stageRunnerReceipt(task, message);
  }

  private async tryIntervene(
    task: Task,
    message: InterventionMessage,
  ): Promise<EngineInterventionResult> {
    const runner = task.runner;
    const engine = runner?.engine;
    if (!engine) {
      return {
        status: "not_delivered",
        mechanism: "unsupported",
        reason: "not_supported",
        message: "Task runner engine is unavailable",
      };
    }
    const input = composeInterventionTurnPrompt(message);
    try {
      if (usesDurableRunnerInterventionInbox(task)) {
        if (!runner?.dispatcher.applyIntervention) {
          return {
            status: "not_delivered",
            mechanism: "unsupported",
            reason: "not_supported",
            message: "Runner intervention apply operation is unavailable",
          };
        }
        return await runner.dispatcher.applyIntervention({
          interventionId: requireRunnerInterventionId(message),
          input,
        });
      }
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

  private deferredUnknown(
    task: Task,
    result: Extract<EngineInterventionResult, { status: "unknown" }>,
  ): RunningInterventionResult {
    this.deps.logger.info(
      {
        sessionId: task.agentSessionId,
        delivered: false,
        reason: result.reason,
        detail: result.message,
        retryWhen: "engine_available",
      },
      "running intervention deferred by durable caller policy",
    );
    return {
      delivered: false,
      deferred: true,
      retryWhen: "engine_available",
      reason: "verdict_unknown",
    };
  }

  private async queueUnknownReceipt(
    task: Task,
    message: InterventionMessage,
    result: Extract<EngineInterventionResult, { status: "unknown" }>,
  ): Promise<RunningInterventionResult> {
    try {
      // The first receipt command or its host ACK may have succeeded. Reusing
      // the intervention id makes this a durable create-or-release operation.
      const queuePosition = await this.stageRunnerQueue(task, message, true);
      enqueueInterventionOnce(task, message);
      this.logQueued(task, result, queuePosition);
      return {
        delivered: false,
        queued: true,
        queuePosition,
        consumeWhen: "next_turn",
        reason: "verdict_unknown",
      };
    } catch (error) {
      // The durable create-or-release result is still unknown. Drop its durable
      // id so the next execute does not require a row that may not exist, then
      // preserve the intervention at the same in-memory level as non-runner mode.
      const memoryMessage = { ...message };
      delete memoryMessage.runnerInterventionId;
      const queuePosition = enqueueInterventionOnce(task, memoryMessage);
      this.deps.logger.warn(
        {
          err: error,
          sessionId: task.agentSessionId,
          interventionId: message.runnerInterventionId,
          reason: result.reason,
          detail: result.message,
          queuePosition,
          durability: "memory_only",
        },
        "runner intervention durable queue recovery failed; queued in memory",
      );
      return {
        delivered: false,
        queued: true,
        queuePosition,
        consumeWhen: "next_turn",
        reason: "verdict_unknown",
      };
    }
  }

  private async discardDurableIntervention(
    task: Task,
    message: InterventionMessage,
  ): Promise<void> {
    const dispatcher = task.runner?.dispatcher;
    if (!dispatcher?.discardIntervention) {
      throw new Error("runner intervention discard operation is unavailable");
    }
    await dispatcher.discardIntervention(requireRunnerInterventionId(message));
  }

  private async stageRunnerReceipt(
    task: Task,
    message: InterventionMessage,
  ): Promise<void> {
    const dispatcher = task.runner?.dispatcher;
    if (!dispatcher?.stageIntervention) {
      throw new Error("runner intervention inbox is unavailable");
    }
    const interventionId = requireRunnerInterventionId(message);
    const staged = await dispatcher.stageIntervention({
      interventionId,
      message: toRunnerJsonRecord(message),
      event: buildInterventionSentEvent(message),
      queued: false,
    });
    if (staged.durability === "host_fallback") return;
    const eventId = await dispatcher.waitForSessionAck();
    if (eventId === null || staged.eventSourceSeq === null) {
      throw new Error("runner intervention receipt did not reach its durable ACK boundary");
    }
    task.lastEventId = eventId;
  }

  private async stageRunnerQueue(
    task: Task,
    message: InterventionMessage,
    publishEvent: boolean,
  ): Promise<number> {
    const dispatcher = task.runner?.dispatcher;
    if (!dispatcher?.stageIntervention) {
      throw new Error("runner intervention inbox is unavailable");
    }
    const staged = await dispatcher.stageIntervention({
      interventionId: requireRunnerInterventionId(message),
      message: toRunnerJsonRecord(message),
      ...(publishEvent ? { event: buildInterventionSentEvent(message) } : {}),
      queued: true,
    });
    if (publishEvent && staged.durability !== "host_fallback") {
      const eventId = await dispatcher.waitForSessionAck();
      if (eventId === null || staged.eventSourceSeq === null) {
        throw new Error("runner intervention receipt did not reach its durable ACK boundary");
      }
      task.lastEventId = eventId;
    }
    return staged.queuePosition;
  }

  private async queueUndelivered(
    task: Task,
    message: InterventionMessage,
  ): Promise<number> {
    if (!usesDurableRunnerInterventionInbox(task)) {
      return enqueueInterventionOnce(task, message);
    }
    const queuePosition = await this.stageRunnerQueue(task, message, false);
    enqueueInterventionOnce(task, message);
    return queuePosition;
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

  private async retryTransientBoundary(
    task: Task,
    message: InterventionMessage,
    interventionResult: EngineInterventionResult,
  ): Promise<EngineInterventionResult | null> {
    if (!isTransientInterventionBoundary(interventionResult)) return null;
    const delayMs = this.deps.liveRetryDelayMs ?? 50;
    if (delayMs > 0) {
      await (this.deps.sleep ?? sleep)(delayMs);
    }
    const retryResult = await this.tryIntervene(task, message);
    if (retryResult.status !== "delivered") {
      this.deps.logger.debug?.(
        {
          sessionId: task.agentSessionId,
          initialReason: interventionResult.reason,
          retryReason: retryResult.reason,
        },
        "running engine intervention boundary retry did not deliver",
      );
    }
    return retryResult;
  }
}

function usesDurableRunnerInterventionInbox(task: Task): boolean {
  return task.runner?.eventPersistence === "runner";
}

function withRunnerInterventionId(message: InterventionMessage): InterventionMessage {
  return {
    ...message,
    runnerInterventionId:
      message.runnerInterventionId ?? message.deliveryId ?? randomUUID(),
  };
}

function requireRunnerInterventionId(message: InterventionMessage): string {
  if (!message.runnerInterventionId) {
    throw new Error("runner intervention id is unavailable");
  }
  return message.runnerInterventionId;
}

function toRunnerJsonRecord(message: InterventionMessage): Record<string, unknown> {
  return JSON.parse(JSON.stringify(message)) as Record<string, unknown>;
}

function isTransientInterventionBoundary(
  result: EngineInterventionResult,
): result is Extract<EngineInterventionResult, { status: "not_delivered" }> {
  return result.status === "not_delivered"
    && (result.reason === "no_active_turn" || result.reason === "not_accepting_input");
}

function formatRecoveryFailure(
  primary: string | undefined,
  recoveryError: unknown,
): string {
  const recovery = recoveryError instanceof Error
    ? recoveryError.message
    : String(recoveryError);
  return primary ? `${primary}; recovery failed: ${recovery}` : recovery;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
