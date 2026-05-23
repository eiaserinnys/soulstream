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
  resolveTaskBackend,
  TaskLiveDeliveryResult,
  type AgentBackendLookup,
} from "./task_live_delivery_result.js";
import type { ToolApprovalRecovery } from "./task_tool_approval_recovery.js";

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

export type { AgentBackendLookup } from "./task_live_delivery_result.js";

/**
 * Owns public delivery route policy for external user responses.
 *
 * ResponseEventPublisher owns event construction/persistence/broadcast. ToolApprovalRecovery owns
 * evicted approval hydration and queued Agents resume. TaskLiveDeliveryResult owns live engine
 * outcome mapping after route guards select a supported engine.
 */
export class TaskDeliveryRoute {
  private readonly liveDeliveryResult: TaskLiveDeliveryResult;

  constructor(private readonly deps: TaskDeliveryRouteDeps) {
    this.liveDeliveryResult = new TaskLiveDeliveryResult({
      responseEventPublisher: deps.responseEventPublisher,
      agentRegistry: deps.agentRegistry,
    });
  }

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
        backend: resolveTaskBackend(task, this.deps.agentRegistry),
      };
    }

    return await this.liveDeliveryResult.deliverInputResponse({
      task,
      requestId: params.requestId,
      answers: params.answers,
      engine,
    });
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
        backend: resolveTaskBackend(task, this.deps.agentRegistry),
      };
    }

    return await this.liveDeliveryResult.deliverToolApproval({
      task,
      params,
      engine,
    });
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
