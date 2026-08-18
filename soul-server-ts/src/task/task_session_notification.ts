import type { Logger } from "pino";

import type { EventPersistence } from "../db/event_persistence.js";
import type { SSEEventPayload } from "../engine/protocol.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";

import type { InterventionMessage, Task } from "./task_models.js";

export interface SessionNotificationPublisherDeps {
  broadcaster: SessionBroadcaster;
  logger: Logger;
  persistence?: EventPersistence;
}

export class SessionNotificationPublisher {
  constructor(private readonly deps: SessionNotificationPublisherDeps) {}

  async publish(
    task: Task,
    message: InterventionMessage,
    disposition: "queued" | "auto_resume",
  ): Promise<{ published: true; targetReceiptId: string } | { published: false }> {
    if (!message.deliveryId || !message.deliveryIntent) {
      throw new Error("session_notification requires delivery identity and intent");
    }
    if (
      message.deliveryIntent !== "completion_notification" &&
      message.deliveryIntent !== "runtime_followup"
    ) {
      throw new Error(
        `session_notification does not support ${message.deliveryIntent}`,
      );
    }
    const event: SSEEventPayload = {
      type: "session_notification",
      delivery_id: message.deliveryId,
      delivery_intent: message.deliveryIntent,
      source: message.source ?? "unknown",
      text: message.text,
      disposition,
      ...(message.completionId ? { completion_id: message.completionId } : {}),
      ...(message.relationKey ? { relation_key: message.relationKey } : {}),
      timestamp: Date.now() / 1000,
      _dedupe_key: `session_notification:${message.deliveryId}`,
    };

    if (!this.deps.persistence) {
      this.deps.logger.warn(
        { sessionId: task.agentSessionId, deliveryId: message.deliveryId },
        "session_notification durable event persistence is unavailable",
      );
      return { published: false };
    }
    let targetReceiptId: string;
    try {
      const { eventId } = await this.deps.persistence.enqueueEventAndWaitForSessionAck(
        task.agentSessionId,
        event,
      );
      task.lastEventId = eventId;
      targetReceiptId = `event:${eventId}`;
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId, deliveryId: message.deliveryId },
        "session_notification persistence failed after delivery; ledger state retained",
      );
      return { published: false };
    }
    try {
      await this.deps.persistence.handleSideEffects(
        task.agentSessionId,
        event,
        task,
      );
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId, deliveryId: message.deliveryId },
        "session_notification handleSideEffects failed after durable enqueue",
      );
    }
    return { published: true, targetReceiptId };
  }
}
