import { randomUUID } from "node:crypto";

import { formatContextItems, type ContextItem } from "../context/prompt_assembler.js";
import type { Logger } from "pino";

import type { EventPersistence } from "../db/event_persistence.js";
import type {
  EngineInterventionFailureReason,
  EngineInterventionResult,
  SupportsToolBoundaryInjection,
} from "../engine/protocol.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";

import type { InterventionMessage, Task } from "./task_models.js";
import { buildDeliveryInputUuid } from "./delivery_identity.js";
import { enqueueInterventionOnce } from "./task_intervention_queue.js";
import { publishInterventionSent } from "./task_intervention_events.js";
import { composeInterventionTurnPrompt } from "./task_turn_loop_transition.js";
import { createInterventionAttachmentSource } from "./generation_turn_input.js";
import type { PrepareAttachmentInput } from "./prepare_attachment_input.js";
import { interventionTurnOrigin } from "./turn_origin.js";
import {
  decideNodeInstruction,
  instructionNumberOf,
  withInstructionNumber,
} from "./state/node_instruction_decision.js";
import {
  askRunnerInstructionReceipt,
  handoffRegistrationId,
} from "./delivery_instruction_receipt.js";

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
  assignedCardContext?: (task: Task, inputId?: string | null) => Promise<ContextItem | null>;
  prepareAttachmentInput?: PrepareAttachmentInput;
}

/**
 * First-class conversation entry for a running task.
 *
 * Delivery failure may preserve an accepted message in the existing queue, but
 * producer intent and backend never select a different conversation path.
 */
export class RunningInterventionTransition {
  private readonly deliveryTails = new WeakMap<Task, Promise<void>>();

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
    // 앞 장벽이 멈춤이면 이 넘기기가 그 위에 이어 붙어도 멈춤 장벽으로 남는다.
    // 멈춤은 자기 장벽이 아닌 장벽을 기다린 뒤 보통 멈춤 길을 타야 하므로(장벽
    // 직렬화 정본), 지시 넘기기 장벽만 종류를 표시한다.
    if (previousTurnBarrier === undefined) task.interruptBarrierKind = "intervention_handoff";
    try {
      return await this.deliverAfterTurnBarrier(task, message, options);
    } finally {
      releaseTurnBarrier();
      if (task.interruptRequest === turnBarrier) {
        task.interruptRequest = undefined;
        task.interruptBarrierKind = undefined;
      }
    }
  }

  private async deliverAfterTurnBarrier(
    task: Task,
    message: InterventionMessage,
    options: { queueIfUndelivered?: boolean },
  ): Promise<RunningInterventionResult> {
    const previousTail = this.deliveryTails.get(task) ?? Promise.resolve();
    const delivery = previousTail
      .catch(() => undefined)
      .then(() => this.deliverInOrder(task, message, options));
    this.deliveryTails.set(task, delivery.then(() => undefined, () => undefined));
    return delivery;
  }

  private async deliverInOrder(
    task: Task,
    message: InterventionMessage,
    options: { queueIfUndelivered?: boolean },
  ): Promise<RunningInterventionResult> {
    const publishBeforeDelivery = options.queueIfUndelivered !== false;
    // The number is fixed before the handoff and stays on the message, so a
    // queued copy carries the same number into the next execution.
    const deliveryMessage = withInstructionNumber(message, randomUUID);
    if (publishBeforeDelivery) {
      await this.publishAcceptance(task, message);
    }

    const expectedRegistrationId = handoffRegistrationId(task);
    const attempted = await this.tryIntervene(
      task,
      deliveryMessage,
      publishBeforeDelivery,
      message,
    );
    const initialResult = attempted.status === "unknown"
      ? await this.resolveUnknown(task, deliveryMessage, attempted, expectedRegistrationId)
      : attempted;
    if (initialResult.status === "unknown") {
      // Neither delivered nor provably undelivered: never resend or queue it.
      return { delivered: null, reason: "verdict_unknown", consumeWhen: null };
    }
    if (initialResult.status === "delivered") {
      await task.activeDeliveryTurnReceipt?.register(message);
      if (!publishBeforeDelivery) {
        await this.publishAcceptance(task, message);
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
    const queuePosition = enqueueInterventionOnce(
      task,
      withInstructionNumber(message, randomUUID),
    );
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

  /**
   * Asks the runner by instruction number when the handoff result is unknown.
   * Applied counts as delivered, a runner of the same registration that never
   * received it counts as undelivered, and anything else stays unknown.
   */
  private async resolveUnknown(
    task: Task,
    message: InterventionMessage,
    unknown: Extract<EngineInterventionResult, { status: "unknown" }>,
    expectedRegistrationId: string | undefined,
  ): Promise<EngineInterventionResult> {
    const instructionNumber = instructionNumberOf(message);
    const verdict = instructionNumber === undefined
      ? "unknown"
      : await askRunnerInstructionReceipt(
          task,
          instructionNumber,
          expectedRegistrationId,
          this.deps.logger,
        );
    const decision = decideNodeInstruction({
      verdict,
      ledger: message.deliveryId ? "line" : "none",
    });
    if (verdict === "applied") {
      return { status: "delivered", mechanism: "active_turn" };
    }
    if (decision.resend) {
      return {
        status: "not_delivered",
        mechanism: "unsupported",
        reason: "failed",
        message: "The runner reported that it never received the instruction",
      };
    }
    this.deps.logger.warn(
      {
        sessionId: task.agentSessionId,
        deliveryId: message.deliveryId,
        instructionNumber,
        detail: unknown.message,
        ledger: decision.ledger,
      },
      "running intervention result unknown; not resending",
    );
    return unknown;
  }

  private async tryIntervene(
    task: Task,
    message: InterventionMessage,
    publishBeforeDelivery: boolean,
    originMessage: InterventionMessage,
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
    // 기록을 다시 읽는 손잡이 뒤에는 받을 엔진이 없다(러너는 재생 전에 끝난다). 넘기면 죽은
    // 러너에 보내 결과를 모름으로 잃으므로, 넘기지 않은 것이 확실한 지시로 대기 줄에 쌓는다.
    // 재생이 끝나면 쌓인 지시로 다시 띄운다(카드 #1266 U5b, 바깥 요청 칸 replaying/intervene).
    if (task.runnerIsOfflineReplay === true) {
      return {
        status: "not_delivered",
        mechanism: "unsupported",
        reason: "no_active_turn",
        message: "Offline replay handle has no live runner to receive the instruction",
      };
    }
    let executionMessage = message;
    if ((message.attachmentIds?.length ?? 0) > 0) {
      const prepareAttachmentInput = this.deps.prepareAttachmentInput;
      if (!prepareAttachmentInput) throw new Error("ATTACHMENT_INPUT_UNAVAILABLE");
      if (!publishBeforeDelivery && !message.deliveryId) {
        throw new Error("ATTACHMENT_DELIVERY_AUTHORIZATION_REQUIRED");
      }
      if (publishBeforeDelivery) {
        await this.deps.persistence?.waitForSessionAck(task.agentSessionId);
      }
      const source = createInterventionAttachmentSource(task.agentSessionId, message);
      if (!source) throw new Error("ATTACHMENT_INPUT_UNAVAILABLE");
      const prepared = await prepareAttachmentInput(source);
      executionMessage = {
        ...message,
        text: prepared.text,
        attachmentPaths: prepared.attachmentPaths,
      };
    }
    const composed = composeInterventionTurnPrompt([{
      ...executionMessage,
      context: executionMessage.context?.filter(item => item.key !== "assigned_cards"),
    }]);
    const inputUuid = message.deliveryId
      ? buildDeliveryInputUuid(message.deliveryId)
      : undefined;
    if (this.deps.assignedCardContext) {
      const current = await this.deps.assignedCardContext(task, inputUuid ?? null);
      if (current) composed.prompt += `\n\n${formatContextItems([current])}`;
    }
    // The runner records a receipt under this number before it calls the
    // engine, so a later lookup can tell "the engine received it" apart from
    // "this handoff never reached a runner". Precedence follows the durable
    // intervention identity used elsewhere; the queued message is not mutated.
    const runnerInterventionId = instructionNumberOf(message);
    if (runnerInterventionId === undefined) {
      throw new Error("running intervention lost its instruction number");
    }
    const input = {
      prompt: composed.prompt,
      imageAttachmentPaths: composed.imageAttachmentPaths,
      ...(inputUuid ? { inputUuid } : {}),
      // The origin id stays what it was before a number was filled in.
      turnOrigin: interventionTurnOrigin(originMessage, inputUuid),
      runnerInterventionId,
    };
    try {
      if (engine.backendId !== "claude") {
        return await engine.intervene(input);
      }
      const injection = engine as typeof engine & Partial<SupportsToolBoundaryInjection>;
      if (!injection.injectAtToolBoundary) {
        return await engine.intervene(input);
      }
      const result = await injection.injectAtToolBoundary(input);
      if (
        result.status === "not_delivered"
        && result.mechanism === "unsupported"
        && result.reason === "not_supported"
      ) {
        return await engine.intervene(input);
      }
      return result;
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
