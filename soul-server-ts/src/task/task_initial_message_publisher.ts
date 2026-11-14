import type { Logger } from "pino";

import type { PreparedContext } from "../context/context_builder.js";
import type { EventPersistence } from "../db/event_persistence.js";
import type { SSEEventPayload } from "../engine/protocol.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";

import type { Task } from "./task_models.js";
import { applyCanonicalSessionProjection } from
  "./task_canonical_session_projection.js";
import {
  NodeResponseRejectedError,
  judgeNodeResponse,
  nodeResponseFactsFromApplication,
  nodeResponseFactsFromError,
} from "./state/node_response_handling.js";
import {
  buildUserMessageEvent,
  finishUserMessageEvent,
  persistUserMessageEvent,
} from "./task_user_message_events.js";

export interface TaskInitialMessagePublisherDeps {
  broadcaster: SessionBroadcaster;
  logger: Logger;
  persistence: EventPersistence;
}

/**
 * Owns first-turn system/user message event construction and side effects.
 *
 * TaskExecutor keeps first-turn prompt composition. This publisher keeps the
 * Python-parity payload keys and durable ingress for events that enter the
 * timeline before the engine turn starts.
 */
export class TaskInitialMessagePublisher {
  constructor(private readonly deps: TaskInitialMessagePublisherDeps) {}

  async publishInitialMessages(
    task: Task,
    ctx?: PreparedContext,
    inputId?: string,
  ): Promise<void> {
    if (ctx?.contextManifest) {
      await this.publishContextManifestBestEffort(task, ctx.contextManifest);
    }
    if (ctx?.effectiveSystemPrompt) {
      await this.publishSystemMessage(task, ctx.effectiveSystemPrompt);
    }
    const event = buildUserMessageEvent({
      text: task.prompt,
      inputId,
      callerInfo: task.callerInfo,
      attachmentPaths: task.attachmentPaths,
      attachmentIds: task.attachmentIds,
      attachmentBindings: task.attachmentBindings,
      contextItems: (ctx ? ctx.combinedContextItems : task.contextItems)?.filter(item=>item.key !== "assigned_cards" && item.key !== "persistent_report" && item.key !== "node_resources"),
    });
    await persistUserMessageEvent(task, event, this.deps);
    if (!task.executionRegistration) {
      const context = { call: "first_message" } as const;
      let application: Awaited<ReturnType<
        EventPersistence["enqueueRunningTransitionAndWaitForApplication"]
      >>;
      try {
        application = await this.deps.persistence
          .enqueueRunningTransitionAndWaitForApplication(task.agentSessionId, {
            reviewState: task.reviewState ?? "not_required",
            transitionId: "initial",
          });
      } catch (error) {
        const facts = nodeResponseFactsFromError(context, error);
        if (!facts || facts.route === "no_response") throw error;
        throw new NodeResponseRejectedError(
          judgeNodeResponse(facts),
          `initial running transition was rejected for ${task.agentSessionId}`,
          { cause: error },
        );
      }
      applyCanonicalSessionProjection(task, application.canonicalSession);
      if (!application.applied) {
        const verdict = judgeNodeResponse(
          nodeResponseFactsFromApplication(context, application),
        );
        // 다시 될 수 있는 거절(사유 없음, 옛 서버)은 옛 동작대로 이 시도를 잇는다.
        // 다시 될 까닭 없는 거절과 영구 거절은 이 시도를 그만둔다.
        if (verdict.decision.cell !== "retryable") {
          throw new NodeResponseRejectedError(
            verdict,
            `initial running transition was rejected for ${task.agentSessionId}`,
          );
        }
      }
    }
    await finishUserMessageEvent(task, event, this.deps);
  }

  async publishContextManifestBestEffort(
    task: Task,
    manifest: NonNullable<PreparedContext["contextManifest"]>,
  ): Promise<void> {
    try {
      const event = {
        type: "context_manifest",
        ...manifest,
      } satisfies SSEEventPayload;
      await this.enqueueTaskEvent(task, event);
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "context_manifest persistence failed — continuing session start",
      );
    }
  }

  private async publishSystemMessage(
    task: Task,
    effectiveSystemPrompt: string,
  ): Promise<void> {
    // Python parity: system_message carries only {type, text}; timestamp is intentionally absent.
    const event: Record<string, unknown> = {
      type: "system_message",
      text: effectiveSystemPrompt,
    };
    await this.enqueueTaskEvent(task, event as SSEEventPayload);
  }

  private async enqueueTaskEvent(task: Task, event: SSEEventPayload): Promise<void> {
    const registrationId = task.executionRegistration?.registrationId;
    if (registrationId === undefined) {
      await this.deps.persistence.enqueueEvent(task.agentSessionId, event);
      return;
    }
    await this.deps.persistence.enqueueEvent(
      task.agentSessionId,
      event,
      undefined,
      registrationId,
    );
  }
}
