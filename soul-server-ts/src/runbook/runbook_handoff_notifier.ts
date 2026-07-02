import type { Logger } from "pino";

import type {
  SendMessageToSessionParams,
  SendMessageToSessionResult,
} from "../task/session_message_sender.js";
import type { RunbookHandoffEvent, RunbookHandoffNotifierPort } from "./runbook_service_models.js";

export interface RunbookHandoffSubscriberQuery {
  listAgentSubscriberSessionIds(runbookId: string): Promise<string[]>;
}

export interface RunbookHandoffMessageSender {
  send(params: SendMessageToSessionParams): Promise<SendMessageToSessionResult>;
}

export class RunbookHandoffNotifier implements RunbookHandoffNotifierPort {
  constructor(
    private readonly subscribers: RunbookHandoffSubscriberQuery,
    private readonly sender: RunbookHandoffMessageSender,
    private readonly logger: Logger,
  ) {}

  notifyHumanHandoff(event: RunbookHandoffEvent): void {
    void this.dispatch(event).catch((err) => {
      this.logger.warn(
        { err, runbookId: event.runbookId, itemId: event.itemId },
        "Runbook handoff notification dispatch failed",
      );
    });
  }

  private async dispatch(event: RunbookHandoffEvent): Promise<void> {
    const subscriberSessionIds = await this.subscribers.listAgentSubscriberSessionIds(
      event.runbookId,
    );
    if (subscriberSessionIds.length === 0) {
      this.logger.info(
        { runbookId: event.runbookId, itemId: event.itemId },
        "Runbook handoff notification skipped: no agent subscribers",
      );
      return;
    }

    const message = buildRunbookHandoffMessage(event);
    for (const targetSessionId of subscriberSessionIds) {
      void this.sender
        .send({ targetSessionId, message })
        .then((result) => {
          if (!result.ok) {
            this.logger.warn(
              {
                runbookId: event.runbookId,
                itemId: event.itemId,
                targetSessionId,
                result,
              },
              "Runbook handoff notification delivery failed",
            );
          }
        })
        .catch((err) => {
          this.logger.warn(
            { err, runbookId: event.runbookId, itemId: event.itemId, targetSessionId },
            "Runbook handoff notification delivery failed",
          );
        });
    }
  }
}

function buildRunbookHandoffMessage(event: RunbookHandoffEvent): string {
  const statusText = event.status === "completed" ? "완료" : "취소";
  return [
    `런북 '${event.runbookTitle}'의 '${event.itemTitle}' ${statusText}됨, 이어서 진행`,
    "",
    `runbook_id: ${event.runbookId}`,
    `board_item_id: ${event.boardItemId}`,
    `item_id: ${event.itemId}`,
    `status: ${event.status}`,
    `operation_id: ${event.operationId}`,
    `event_id: ${event.eventId}`,
  ].join("\n");
}
