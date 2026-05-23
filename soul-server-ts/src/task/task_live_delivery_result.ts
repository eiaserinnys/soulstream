import type {
  BackendId,
  InputResponseDeliveryResult,
  SupportsInputResponse,
  SupportsToolApproval,
  ToolApprovalDeliveryResult,
} from "../engine/protocol.js";
import type { Task } from "./task_models.js";
import type { ResponseEventPublisher } from "./task_response_event_publisher.js";
import {
  buildToolApprovalOptions,
  type ToolApprovalRequest,
} from "./task_tool_approval_recovery.js";

export interface AgentBackendLookup {
  get(id: string): { backend?: BackendId | string } | undefined;
}

export interface TaskLiveDeliveryResultDeps {
  responseEventPublisher: Pick<
    ResponseEventPublisher,
    "publishInputRequestResponded" | "publishToolApprovalResolved"
  >;
  agentRegistry?: AgentBackendLookup;
}

export interface LiveInputResponseParams {
  task: Task;
  engine: NonNullable<Task["engine"]> & SupportsInputResponse;
  requestId: string;
  answers: Record<string, unknown>;
}

export interface LiveInputResponseResult {
  status: InputResponseDeliveryResult["status"];
  requestId: string;
  eventId?: number;
  message?: string;
  backend?: BackendId | string;
}

export interface LiveToolApprovalParams {
  task: Task;
  engine: NonNullable<Task["engine"]> & SupportsToolApproval;
  params: ToolApprovalRequest;
}

export interface LiveToolApprovalResult {
  status: ToolApprovalDeliveryResult["status"];
  approvalId: string;
  decision: ToolApprovalRequest["decision"];
  eventId?: number;
  message?: string;
  backend?: BackendId | string;
}

/**
 * Owns the live-engine result boundary after route guards have selected a live task.
 *
 * TaskDeliveryRoute owns lookup/status/capability/fallback routing. ResponseEventPublisher owns
 * persistence and broadcast policy. This boundary owns the shared rule between response branches:
 * only a delivered engine result publishes a response event, and all engine outcomes are mapped to
 * the public API result shape.
 */
export class TaskLiveDeliveryResult {
  constructor(private readonly deps: TaskLiveDeliveryResultDeps) {}

  async deliverInputResponse(
    params: LiveInputResponseParams,
  ): Promise<LiveInputResponseResult> {
    const delivered = await params.engine.deliverInputResponse(
      params.requestId,
      params.answers,
    );
    if (delivered.status !== "delivered") {
      return {
        status: delivered.status,
        requestId: params.requestId,
        ...(delivered.message ? { message: delivered.message } : {}),
        ...(delivered.status === "not_supported"
          ? { backend: resolveTaskBackend(params.task, this.deps.agentRegistry) }
          : {}),
      };
    }

    const eventId = await this.deps.responseEventPublisher.publishInputRequestResponded(
      params.task,
      params.requestId,
    );
    return {
      status: "delivered",
      requestId: params.requestId,
      ...(eventId !== undefined ? { eventId } : {}),
    };
  }

  async deliverToolApproval(
    params: LiveToolApprovalParams,
  ): Promise<LiveToolApprovalResult> {
    const delivered = await params.engine.deliverToolApproval(
      params.params.approvalId,
      params.params.decision,
      buildToolApprovalOptions(params.params),
    );
    if (delivered.status !== "delivered") {
      return {
        status: delivered.status,
        approvalId: params.params.approvalId,
        decision: params.params.decision,
        ...(delivered.message ? { message: delivered.message } : {}),
        ...(delivered.status === "not_supported"
          ? { backend: resolveTaskBackend(params.task, this.deps.agentRegistry) }
          : {}),
      };
    }

    const eventId = await this.deps.responseEventPublisher.publishToolApprovalResolved(
      params.task,
      params.params,
    );
    return {
      status: "delivered",
      approvalId: params.params.approvalId,
      decision: params.params.decision,
      ...(eventId !== undefined ? { eventId } : {}),
    };
  }
}

export function resolveTaskBackend(
  task: Task,
  agentRegistry?: AgentBackendLookup,
): BackendId | string | undefined {
  if (task.engine?.backendId) return task.engine.backendId;
  if (task.profileId && agentRegistry) {
    return agentRegistry.get(task.profileId)?.backend;
  }
  return undefined;
}
