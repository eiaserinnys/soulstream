import type { Logger } from "pino";

import type {
  ToolApprovalDecision,
  ToolApprovalDeliveryOptions,
} from "../engine/protocol.js";
import type { Task } from "./task_models.js";

export interface ToolApprovalRequest {
  agentSessionId: string;
  approvalId: string;
  decision: ToolApprovalDecision;
  message?: string;
  alwaysApprove?: boolean;
  alwaysReject?: boolean;
}

export interface ToolApprovalResumeResult {
  status: "delivered";
  approvalId: string;
  decision: ToolApprovalDecision;
  eventId?: number;
}

export type ToolApprovalResumeCallback = (task: Task) => void;

export interface ToolApprovalRecoveryDeps {
  getTask(sessionId: string): Task | undefined;
  loadEvictedTask(sessionId: string): Promise<Task | null>;
  rememberTask(task: Task): void;
  persistToolApprovalResolved(
    task: Task,
    params: ToolApprovalRequest,
  ): Promise<number | undefined>;
  emitSessionUpdated(task: Task): Promise<void>;
  logger: Logger;
}

export function buildToolApprovalOptions(
  params: ToolApprovalRequest,
): ToolApprovalDeliveryOptions {
  return {
    ...(params.message ? { message: params.message } : {}),
    ...(params.alwaysApprove !== undefined
      ? { alwaysApprove: params.alwaysApprove }
      : {}),
    ...(params.alwaysReject !== undefined
      ? { alwaysReject: params.alwaysReject }
      : {}),
  };
}

/**
 * Owns the recovery side of tool approval delivery.
 *
 * TaskManager owns public API result shape and live engine delivery. This helper owns the
 * "memory miss -> evicted task hydration -> Agents approval resume" branch and its handoff.
 */
export class ToolApprovalRecovery {
  constructor(private readonly deps: ToolApprovalRecoveryDeps) {}

  async resolveTaskForApproval(sessionId: string): Promise<Task | null> {
    const memoryTask = this.deps.getTask(sessionId);
    if (memoryTask) return memoryTask;

    const hydratedTask = await this.deps.loadEvictedTask(sessionId);
    if (!hydratedTask) return null;

    this.deps.rememberTask(hydratedTask);
    return hydratedTask;
  }

  async tryQueueAgentsResume(
    task: Task,
    params: ToolApprovalRequest,
    onResume: ToolApprovalResumeCallback | undefined,
  ): Promise<ToolApprovalResumeResult | undefined> {
    if (!onResume) return undefined;
    if (!task.agentsRunState || task.agentsPendingApprovalId !== params.approvalId) {
      return undefined;
    }

    task.agentsQueuedToolApproval = {
      approvalId: params.approvalId,
      decision: params.decision,
      options: buildToolApprovalOptions(params),
    };

    const eventId = await this.deps.persistToolApprovalResolved(task, params);
    try {
      await this.deps.emitSessionUpdated(task);
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "session_updated (tool approval resume) broadcast failed",
      );
    }
    onResume(task);

    return {
      status: "delivered",
      approvalId: params.approvalId,
      decision: params.decision,
      ...(eventId !== undefined ? { eventId } : {}),
    };
  }
}
