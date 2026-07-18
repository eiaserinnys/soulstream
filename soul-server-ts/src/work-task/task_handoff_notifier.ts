import type { Logger } from "pino";

import type {
  SendMessageToSessionParams,
  SendMessageToSessionResult,
} from "../task/session_message_sender.js";
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
    for (const targetSessionId of subscriberSessionIds) {
      void this.sender
        .send({ targetSessionId, message })
        .then((result) => {
          if (!result.ok) {
            this.logger.warn(
              {
                taskId: event.taskId,
                itemId: event.itemId,
                targetSessionId,
                result,
              },
              "Task handoff notification delivery failed",
            );
          }
        })
        .catch((err) => {
          this.logger.warn(
            { err, taskId: event.taskId, itemId: event.itemId, targetSessionId },
            "Task handoff notification delivery failed",
          );
        });
    }
  }
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
