import type { Logger } from "pino";

import type { SessionDeliveryNotificationRepository } from "../db/repositories/session_delivery_notification_repository.js";
import type { SessionDeliveryNotificationOutboxRow } from "../db/session_db_types.js";
import type { InterventionMessage, Task } from "./task_models.js";

export interface SessionDeliveryNotificationRecoveryDeps {
  repository: Pick<
    SessionDeliveryNotificationRepository,
    "claimDue" | "markPublished" | "releaseExpiredLeases" | "retry"
  >;
  publish(
    task: Task,
    message: InterventionMessage,
    disposition: "queued" | "auto_resume",
  ): Promise<boolean>;
  resolveTask(sessionId: string): Promise<Task>;
  logger: Pick<Logger, "warn">;
}

export class SessionDeliveryNotificationRecovery {
  constructor(private readonly deps: SessionDeliveryNotificationRecoveryDeps) {}

  async recover(leaseOwner: string, limit = 100): Promise<number> {
    await this.deps.repository.releaseExpiredLeases();
    const rows = await this.deps.repository.claimDue(leaseOwner, limit);
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
      await this.deps.repository.retry(
        row.delivery_id,
        leaseOwner,
        err instanceof Error ? err.message : String(err),
        retryAt(row.attempt_count),
      );
      this.deps.logger.warn(
        { err, deliveryId: row.delivery_id },
        "Session notification outbox item deferred",
      );
    }
  }
}

function notificationMessageFromOutbox(
  row: SessionDeliveryNotificationOutboxRow,
): InterventionMessage {
  const payload = row.payload;
  const intent = payload.delivery_intent;
  if (
    intent !== "completion_notification" &&
    intent !== "runtime_followup"
  ) {
    throw new Error(`Unsupported outbox delivery intent: ${String(intent)}`);
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
    throw new Error(`Notification outbox payload is missing ${name}`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function retryAt(attemptCount: number): Date {
  const delayMs = Math.min(60_000, 100 * 2 ** Math.min(attemptCount, 9));
  return new Date(Date.now() + delayMs);
}
