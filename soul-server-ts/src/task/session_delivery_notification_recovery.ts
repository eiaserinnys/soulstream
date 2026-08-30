import type { Logger } from "pino";

import type { SessionDeliveryNotificationRepository } from "../db/repositories/session_delivery_notification_repository.js";
import type { SessionDeliveryNotificationOutboxRow } from "../db/session_db_types.js";
import type { InterventionMessage, Task } from "./task_models.js";
import { notificationRetryAt } from "./session_delivery_notification_policy.js";
import { projectNotificationReceipt } from "./notification_receipt_projection.js";

export interface SessionDeliveryNotificationRecoveryDeps {
  repository: Pick<
    SessionDeliveryNotificationRepository,
    "claimDue" | "get" | "markPublished" | "releaseExpiredLeases" | "retry"
  >;
  publish(
    task: Task,
    message: InterventionMessage,
    disposition: "queued" | "auto_resume",
  ): Promise<{ published: true; targetReceiptId: string } | { published: false }>;
  resolveTask(sessionId: string): Promise<Task | null>;
  targetNodeId: string;
  logger: Pick<Logger, "warn">;
}

export class SessionDeliveryNotificationRecovery {
  constructor(private readonly deps: SessionDeliveryNotificationRecoveryDeps) {}

  async recover(leaseOwner: string, limit = 100): Promise<number> {
    await this.deps.repository.releaseExpiredLeases();
    const rows = await this.deps.repository.claimDue(
      this.deps.targetNodeId,
      leaseOwner,
      limit,
    );
    let processed = 0;
    for (const row of rows) {
      await this.process(row, leaseOwner);
      processed += 1;
    }
    return processed;
  }

  private async process(
    row: SessionDeliveryNotificationOutboxRow,
    leaseOwner: string,
  ): Promise<void> {
    try {
      const task = await this.deps.resolveTask(row.target_session_id);
      if (!task) {
        throw new NotificationPayloadError(
          `Notification target session not found: ${row.target_session_id}`,
        );
      }
      const published = await this.deps.publish(
        task,
        notificationMessageFromOutbox(row),
        row.disposition,
      );
      if (!published.published) {
        throw new Error("session_notification persistence failed");
      }
      await projectNotificationReceipt(
        this.deps.repository,
        row.delivery_id,
        leaseOwner,
        published.targetReceiptId,
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await this.deps.repository.retry(
        row.delivery_id,
        leaseOwner,
        error,
        notificationRetryAt(row.attempt_count),
      );
      this.deps.logger.warn(
        {
          err,
          deliveryId: row.delivery_id,
          disposition: "retry",
        },
        "Session notification outbox item was not published",
      );
    }
  }
}

function notificationMessageFromOutbox(
  row: SessionDeliveryNotificationOutboxRow,
): InterventionMessage {
  const payload = row.payload;
  const intent = payload.delivery_intent ?? payload.deliveryIntent;
  if (
    intent !== "completion_notification" &&
    intent !== "runtime_followup"
  ) {
    throw new NotificationPayloadError(
      `Unsupported outbox delivery intent: ${String(intent)}`,
    );
  }
  return {
    text: requiredString(payload.text, "text"),
    user: requiredString(payload.user, "user"),
    callerInfo:
      payload.caller_info && typeof payload.caller_info === "object"
        ? payload.caller_info as InterventionMessage["callerInfo"]
        : undefined,
    source: requiredString(payload.source, "source"),
    deliveryId: row.delivery_id,
    deliveryIntent: intent,
    completionId: optionalString(payload.completion_id),
    relationKey: optionalString(payload.relation_key),
    followupKey: optionalString(payload.followup_key ?? payload.followupKey),
    followupAttempt: optionalPositiveInteger(
      payload.followup_attempt ?? payload.followupAttempt,
    ),
  };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new NotificationPayloadError(
      `Notification outbox payload is missing ${name}`,
    );
  }
  return value;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

class NotificationPayloadError extends Error {}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
