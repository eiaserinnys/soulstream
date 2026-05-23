import type {
  BackendId,
  InputResponseDeliveryResult,
  SupportsInputResponse,
  SupportsToolApproval,
  ToolApprovalDecision,
  ToolApprovalDeliveryResult,
} from "../engine/protocol.js";
import type { Task, TaskStatus } from "./task_models.js";
import type { ResponseEventPublisher } from "./task_response_event_publisher.js";
import {
  buildToolApprovalOptions,
  type ToolApprovalRecovery,
} from "./task_tool_approval_recovery.js";

export type DeliverInputResponseStatus =
  | InputResponseDeliveryResult["status"]
  | "session_not_found"
  | "session_not_running";

export interface DeliverInputResponseParams {
  agentSessionId: string;
  requestId: string;
  answers: Record<string, unknown>;
}

export interface DeliverInputResponseResult {
  status: DeliverInputResponseStatus;
  requestId: string;
  eventId?: number;
  message?: string;
  taskStatus?: TaskStatus;
  backend?: BackendId | string;
}

export type DeliverToolApprovalStatus =
  | ToolApprovalDeliveryResult["status"]
  | "session_not_found"
  | "session_not_running";

export interface DeliverToolApprovalParams {
  agentSessionId: string;
  approvalId: string;
  decision: ToolApprovalDecision;
  message?: string;
  alwaysApprove?: boolean;
  alwaysReject?: boolean;
}

export interface DeliverToolApprovalResult {
  status: DeliverToolApprovalStatus;
  approvalId: string;
  decision: ToolApprovalDecision;
  eventId?: number;
  message?: string;
  taskStatus?: TaskStatus;
  backend?: BackendId | string;
}

export type DeliveryResumeCallback = (task: Task) => void;

export interface TaskDeliveryRouteDeps {
  getTask(sessionId: string): Task | undefined;
  toolApprovalRecovery: Pick<
    ToolApprovalRecovery,
    "resolveTaskForApproval" | "tryQueueAgentsResume"
  >;
  responseEventPublisher: Pick<
    ResponseEventPublisher,
    "publishInputRequestResponded" | "publishToolApprovalResolved"
  >;
  agentRegistry?: AgentBackendLookup;
}

export interface AgentBackendLookup {
  get(id: string): { backend?: BackendId | string } | undefined;
}

/**
 * Owns public delivery route policy for external user responses.
 *
 * ResponseEventPublisher owns event construction/persistence/broadcast. ToolApprovalRecovery owns
 * evicted approval hydration and queued Agents resume. This route owns live delivery decisions and
 * the public API result shapes that callers observe.
 */
export class TaskDeliveryRoute {
  constructor(private readonly deps: TaskDeliveryRouteDeps) {}

  async deliverInputResponse(
    params: DeliverInputResponseParams,
  ): Promise<DeliverInputResponseResult> {
    const task = this.deps.getTask(params.agentSessionId);
    if (!task) {
      return { status: "session_not_found", requestId: params.requestId };
    }
    if (task.status !== "running") {
      return {
        status: "session_not_running",
        requestId: params.requestId,
        taskStatus: task.status,
      };
    }

    const engine = task.engine;
    if (!supportsInputResponse(engine)) {
      return {
        status: "not_supported",
        requestId: params.requestId,
        backend: taskBackend(task, this.deps.agentRegistry),
      };
    }

    const delivered = await engine.deliverInputResponse(params.requestId, params.answers);
    if (delivered.status !== "delivered") {
      return {
        status: delivered.status,
        requestId: params.requestId,
        ...(delivered.message ? { message: delivered.message } : {}),
        ...(delivered.status === "not_supported"
          ? { backend: taskBackend(task, this.deps.agentRegistry) }
          : {}),
      };
    }

    const eventId = await this.deps.responseEventPublisher.publishInputRequestResponded(
      task,
      params.requestId,
    );
    return {
      status: "delivered",
      requestId: params.requestId,
      ...(eventId !== undefined ? { eventId } : {}),
    };
  }

  async deliverToolApproval(
    params: DeliverToolApprovalParams,
    onResume?: DeliveryResumeCallback,
  ): Promise<DeliverToolApprovalResult> {
    const task = await this.deps.toolApprovalRecovery.resolveTaskForApproval(
      params.agentSessionId,
    );
    if (!task) {
      return {
        status: "session_not_found",
        approvalId: params.approvalId,
        decision: params.decision,
      };
    }
    if (task.status !== "running") {
      return {
        status: "session_not_running",
        approvalId: params.approvalId,
        decision: params.decision,
        taskStatus: task.status,
      };
    }

    const engine = task.engine;
    if (!supportsToolApproval(engine)) {
      const queued = await this.deps.toolApprovalRecovery.tryQueueAgentsResume(
        task,
        params,
        onResume,
      );
      if (queued) return queued;
      return {
        status: "not_supported",
        approvalId: params.approvalId,
        decision: params.decision,
        backend: taskBackend(task, this.deps.agentRegistry),
      };
    }

    const delivered = await engine.deliverToolApproval(
      params.approvalId,
      params.decision,
      buildToolApprovalOptions(params),
    );
    if (delivered.status !== "delivered") {
      return {
        status: delivered.status,
        approvalId: params.approvalId,
        decision: params.decision,
        ...(delivered.message ? { message: delivered.message } : {}),
        ...(delivered.status === "not_supported"
          ? { backend: taskBackend(task, this.deps.agentRegistry) }
          : {}),
      };
    }

    const eventId = await this.deps.responseEventPublisher.publishToolApprovalResolved(
      task,
      params,
    );
    return {
      status: "delivered",
      approvalId: params.approvalId,
      decision: params.decision,
      ...(eventId !== undefined ? { eventId } : {}),
    };
  }
}

function supportsInputResponse(
  engine: Task["engine"],
): engine is NonNullable<Task["engine"]> & SupportsInputResponse {
  return Boolean(
    engine &&
      typeof (engine as unknown as Partial<SupportsInputResponse>).deliverInputResponse ===
        "function",
  );
}

function supportsToolApproval(
  engine: Task["engine"],
): engine is NonNullable<Task["engine"]> & SupportsToolApproval {
  return Boolean(
    engine &&
      typeof (engine as unknown as Partial<SupportsToolApproval>).deliverToolApproval ===
        "function",
  );
}

function taskBackend(
  task: Task,
  agentRegistry?: AgentBackendLookup,
): BackendId | string | undefined {
  if (task.engine?.backendId) return task.engine.backendId;
  if (task.profileId && agentRegistry) {
    return agentRegistry.get(task.profileId)?.backend;
  }
  return undefined;
}
