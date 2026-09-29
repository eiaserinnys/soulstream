import type { Logger } from "pino";

import type {
  SendMessageToSessionParams,
  SendMessageToSessionResult,
} from "../task/session_message_sender.js";
import { buildDeterministicDeliveryIdentity } from "../task/delivery_identity.js";
import type { FolderHandoffEvent, FolderHandoffNotifierPort } from "./folder_service_models.js";

export interface FolderHandoffSubscriberQuery {
  listAgentSubscriberSessionIds(folderId: string): Promise<string[]>;
}

export interface FolderHandoffMessageSender {
  send(params: SendMessageToSessionParams): Promise<SendMessageToSessionResult>;
}

export class FolderHandoffNotifier implements FolderHandoffNotifierPort {
  constructor(
    private readonly subscribers: FolderHandoffSubscriberQuery,
    private readonly sender: FolderHandoffMessageSender,
    private readonly logger: Logger,
  ) {}

  notifyHumanHandoff(event: FolderHandoffEvent): void {
    void this.dispatch(event).catch((err) => {
      this.logger.warn(
        { err, folderId: event.folderId, itemId: event.itemId },
        "Folder checklist handoff notification dispatch failed",
      );
    });
  }

  private async dispatch(event: FolderHandoffEvent): Promise<void> {
    const subscriberSessionIds = await this.subscribers.listAgentSubscriberSessionIds(
      event.folderId,
    );
    if (subscriberSessionIds.length === 0) {
      this.logger.info(
        { folderId: event.folderId, itemId: event.itemId },
        "Folder checklist handoff notification skipped: no agent subscribers",
      );
      return;
    }

    const message = buildFolderHandoffMessage(event);
    await Promise.all(subscriberSessionIds.map(async (targetSessionId) => {
      try {
        const result = await this.sender.send({
          targetSessionId,
          message,
          ...handoffDelivery(event, targetSessionId),
        });
        if (!result.ok) {
          this.logger.warn(
            { folderId: event.folderId, itemId: event.itemId, targetSessionId, result },
            "Folder checklist handoff notification delivery failed",
          );
        }
      } catch (err) {
        this.logger.warn(
          { err, folderId: event.folderId, itemId: event.itemId, targetSessionId },
          "Folder checklist handoff notification delivery failed",
        );
      }
    }));
  }
}

function handoffDelivery(
  event: FolderHandoffEvent,
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
    "folder_checklist_handoff",
    event.folderId,
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
    source: "folder_checklist_handoff",
    completionId: identity.completionId,
    relationKey,
    producerTerminalRevision: String(event.eventId),
  };
}

function buildFolderHandoffMessage(event: FolderHandoffEvent): string {
  const statusText = event.status === "completed" ? "완료" : "취소";
  return [
    `폴더 '${event.folderName}'의 '${event.itemTitle}' ${statusText}됨, 이어서 진행`,
    "",
    `folder_id: ${event.folderId}`,
    `item_id: ${event.itemId}`,
    `status: ${event.status}`,
    `operation_id: ${event.operationId}`,
    `event_id: ${event.eventId}`,
  ].join("\n");
}
