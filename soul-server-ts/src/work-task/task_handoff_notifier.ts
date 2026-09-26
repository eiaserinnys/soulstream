import type { Logger } from "pino";

import type {
  SendMessageToSessionParams,
  SendMessageToSessionResult,
} from "../task/session_message_sender.js";
import { buildDeterministicDeliveryIdentity } from "../task/delivery_identity.js";
import type { TaskHandoffEvent, TaskHandoffNotifierPort } from "./task_service_models.js";

export interface TaskHandoffSubscriberQuery {
  listAgentSubscriberSessionIds(taskId: string): Promise<string[]>;
}

export interface TaskHandoffMessageSender {
  send(params: SendMessageToSessionParams): Promise<SendMessageToSessionResult>;
}

export class TaskHandoffNotifier implements TaskHandoffNotifierPort {
  constructor(
    private readonly subscribers: TaskHandoffSubscriberQuery,
    private readonly sender: TaskHandoffMessageSender,
    private readonly logger: Logger,
  ) {}

  notifyHumanHandoff(event: TaskHandoffEvent): void {
    void this.dispatch(event).catch((err) => {
      this.logger.warn(
        { err, taskId: event.taskId, itemId: event.itemId },
        "Task handoff notification dispatch failed",
      );
    });
  }

  private async dispatch(event: TaskHandoffEvent): Promise<void> {
    const subscriberSessionIds = await this.subscribers.listAgentSubscriberSessionIds(
      event.taskId,
    );
    if (subscriberSessionIds.length === 0) {
      this.logger.info(
        { taskId: event.taskId, itemId: event.itemId },
        "Task handoff notification skipped: no agent subscribers",
      );
      return;
    }

    const message = buildTaskHandoffMessage(event);
    await Promise.all(subscriberSessionIds.map(async (targetSessionId) => {
      try {
        const result = await this.sender.send({
          targetSessionId,
          message,
          ...handoffDelivery(event, targetSessionId),
        });
        if (!result.ok) {
          this.logger.warn(
            { taskId: event.taskId, itemId: event.itemId, targetSessionId, result },
            "Task handoff notification delivery failed",
          );
        }
      } catch (err) {
        this.logger.warn(
          { err, taskId: event.taskId, itemId: event.itemId, targetSessionId },
          "Task handoff notification delivery failed",
        );
      }
    }));
  }
}

function handoffDelivery(
  event: TaskHandoffEvent,
  targetSessionId: string,
): Pick<SendMessageToSessionParams,
  | "deliveryId"
  | "deliveryIntent"
  | "source"
  | "completionId"
  | "relationKey"
  | "producerTerminalRevision"
> {
  const relationKey = [
    "task_handoff",
    event.taskId,
    event.operationId,
    event.itemId,
    targetSessionId,
  ].join(":");
  const identity = buildDeterministicDeliveryIdentity({
    targetSessionId,
    relationKey,
    intent: "durable_next_turn",
  });
  return {
    deliveryId: identity.deliveryId,
    deliveryIntent: "durable_next_turn",
    source: "task_handoff",
    completionId: identity.completionId,
    relationKey,
    producerTerminalRevision: String(event.eventId),
  };
}

function buildTaskHandoffMessage(event: TaskHandoffEvent): string {
  const statusText = event.status === "completed" ? "완료" : "취소";
  return [
    `업무 '${event.taskTitle}'의 '${event.itemTitle}' ${statusText}됨, 이어서 진행`,
    "",
    `task_id: ${event.taskId}`,
    `board_item_id: ${event.boardItemId}`,
    `item_id: ${event.itemId}`,
    `status: ${event.status}`,
    `operation_id: ${event.operationId}`,
    `event_id: ${event.eventId}`,
  ].join("\n");
}
