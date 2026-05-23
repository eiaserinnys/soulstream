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
 * Owns persistence and broadcast for user response resolution events.
 *
 * These events are emitted after an external input or approval has already been
 * accepted by the engine. Public API result shapes stay outside this publisher; this
 * publisher owns event construction, `_event_id` ride-along, and failure isolation.
 */
export class ResponseEventPublisher {
  constructor(private readonly deps: ResponseEventPublisherDeps) {}

  async publishInputRequestResponded(
    task: Task,
    requestId: string,
  ): Promise<number | undefined> {
    return await this.persistAndBroadcast({
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
      broadcastFailure: {
        context: { requestId },
        message: "input_request_responded broadcast failed",
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

    return await this.persistAndBroadcast({
      task,
      event,
      persistenceFailure: {
        context: { approvalId: params.approvalId },
        message: "tool_approval_resolved persistence failed",
      },
      broadcastFailure: {
        context: { approvalId: params.approvalId },
        message: "tool_approval_resolved broadcast failed",
      },
    });
  }

  private async persistAndBroadcast(params: {
    task: Task;
    event: Record<string, unknown>;
    persistenceFailure: ResponseEventFailureLog;
    broadcastFailure: ResponseEventFailureLog;
  }): Promise<number | undefined> {
    const { task, event } = params;
    let eventId: number | undefined;

    if (this.deps.persistence) {
      try {
        eventId = await this.deps.persistence.persistEvent(
          task.agentSessionId,
          event as SSEEventPayload,
        );
        task.lastEventId = eventId;
        event._event_id = eventId;
        await this.deps.persistence.handleSideEffects(
          task.agentSessionId,
          event as SSEEventPayload,
          task,
        );
      } catch (err) {
        this.deps.logger.warn(
          {
            err,
            sessionId: task.agentSessionId,
            ...params.persistenceFailure.context,
          },
          params.persistenceFailure.message,
        );
        eventId = undefined;
      }
    }

    try {
      await this.deps.broadcaster.emitEventEnvelope(
        task.agentSessionId,
        event as SSEEventPayload,
      );
    } catch (err) {
      this.deps.logger.warn(
        {
          err,
          sessionId: task.agentSessionId,
          ...params.broadcastFailure.context,
        },
        params.broadcastFailure.message,
      );
    }

    return eventId;
  }
}

interface ResponseEventFailureLog {
  context: Record<string, unknown>;
  message: string;
}
