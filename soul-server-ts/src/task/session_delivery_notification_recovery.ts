import type { Logger } from "pino";

import type { SessionDeliveryNotificationRepository } from "../db/repositories/session_delivery_notification_repository.js";
import type { SessionDeliveryNotificationOutboxRow } from "../db/session_db_types.js";
import type { InterventionMessage, Task } from "./task_models.js";
import {
  DELIVERY_NOTIFICATION_MAX_ATTEMPTS,
  notificationOldestAllowedCreatedAt,
  notificationRetryAt,
} from "./session_delivery_notification_policy.js";

export interface SessionDeliveryNotificationRecoveryDeps {
  repository: Pick<
    SessionDeliveryNotificationRepository,
    "claimDue" | "deadLetter" | "markPublished" | "releaseExpiredLeases" | "retry"
  >;
  publish(
    task: Task,
    message: InterventionMessage,
    disposition: "queued" | "auto_resume",
  ): Promise<boolean>;
  resolveTask(sessionId: string): Promise<Task | null>;
  targetNodeId: string;
  logger: Pick<Logger, "warn">;
}

export class SessionDeliveryNotificationRecovery {
  constructor(private readonly deps: SessionDeliveryNotificationRecoveryDeps) {}

  async recover(leaseOwner: string, limit = 100): Promise<number> {
    const oldestAllowedCreatedAt = notificationOldestAllowedCreatedAt();
    await this.deps.repository.releaseExpiredLeases(
      DELIVERY_NOTIFICATION_MAX_ATTEMPTS,
      oldestAllowedCreatedAt,
    );
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
        throw new NonRetryableNotificationError(
          `Notification target session not found: ${row.target_session_id}`,
        );
      }
      const published = await this.deps.publish(
        task,
        notificationMessageFromOutbox(row),
        row.disposition,
      );
      if (!published) {
        throw new Error("session_notification persistence failed");
      }
      await this.deps.repository.markPublished(row.delivery_id, leaseOwner);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (err instanceof NonRetryableNotificationError) {
        await this.deps.repository.deadLetter(row.delivery_id, leaseOwner, error);
      } else {
        await this.deps.repository.retry(
          row.delivery_id,
          leaseOwner,
          error,
          notificationRetryAt(row.attempt_count),
          DELIVERY_NOTIFICATION_MAX_ATTEMPTS,
          notificationOldestAllowedCreatedAt(),
        );
      }
      this.deps.logger.warn(
        {
          err,
          deliveryId: row.delivery_id,
          disposition: err instanceof NonRetryableNotificationError
            ? "dead_letter"
            : "retry",
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
    throw new NonRetryableNotificationError(
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
  };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new NonRetryableNotificationError(
      `Notification outbox payload is missing ${name}`,
    );
  }
  return value;
}

class NonRetryableNotificationError extends Error {}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
