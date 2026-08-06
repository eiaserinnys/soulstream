import type { Logger } from "pino";

import type { EventPersistence } from "../db/event_persistence.js";
import type { SSEEventPayload, ToolApprovalDecision } from "../engine/protocol.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";
import type { Task } from "./task_models.js";

export interface ToolApprovalResolutionParams {
  approvalId: string;
  decision: ToolApprovalDecision;
  message?: string;
}

export interface ResponseEventPublisherDeps {
  broadcaster: SessionBroadcaster;
  logger: Logger;
  persistence?: EventPersistence;
}

/**
 * Owns durable ingress and ACK ordering for user response resolution events.
 *
 * These events are emitted after an external input or approval has already been
 * accepted by the engine. Public API result shapes stay outside this publisher; this
 * publisher owns event construction and the DB event ID barrier.
 */
export class ResponseEventPublisher {
  constructor(private readonly deps: ResponseEventPublisherDeps) {}

  async publishInputRequestResponded(
    task: Task,
    requestId: string,
  ): Promise<number | undefined> {
    return await this.enqueueAndWait({
      task,
      event: {
        type: "input_request_responded",
        request_id: requestId,
        timestamp: Date.now() / 1000,
      },
      persistenceFailure: {
        context: { requestId },
        message: "input_request_responded persistence failed",
      },
    });
  }

  async publishToolApprovalResolved(
    task: Task,
    params: ToolApprovalResolutionParams,
  ): Promise<number | undefined> {
    const event: Record<string, unknown> = {
      type: "tool_approval_resolved",
      approval_id: params.approvalId,
      decision: params.decision,
      approved: params.decision === "approved",
      rejected: params.decision === "rejected",
      timestamp: Date.now() / 1000,
    };
    if (params.message) {
      event.message = params.message;
    }

    return await this.enqueueAndWait({
      task,
      event,
      persistenceFailure: {
        context: { approvalId: params.approvalId },
        message: "tool_approval_resolved persistence failed",
      },
    });
  }

  private async enqueueAndWait(params: {
    task: Task;
    event: Record<string, unknown>;
    persistenceFailure: ResponseEventFailureLog;
  }): Promise<number | undefined> {
    const { task, event } = params;
    if (!this.deps.persistence) {
      throw new Error("response durable event persistence is required");
    }

    try {
      const { eventId } = await this.deps.persistence.enqueueEventAndWaitForSessionAck(
        task.agentSessionId,
        event as SSEEventPayload,
      );
      task.lastEventId = eventId;
      await this.deps.persistence.handleSideEffects(
        task.agentSessionId,
        event as SSEEventPayload,
        task,
      );
      return eventId;
    } catch (err) {
      this.deps.logger.warn(
        {
          err,
          sessionId: task.agentSessionId,
          ...params.persistenceFailure.context,
        },
        params.persistenceFailure.message,
      );
      throw err;
    }
  }
}

interface ResponseEventFailureLog {
  context: Record<string, unknown>;
  message: string;
}
