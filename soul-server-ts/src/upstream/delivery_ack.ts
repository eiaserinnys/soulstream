import type {
  DeliverInputResponseResult,
  DeliverInputResponseStatus,
  DeliverToolApprovalResult,
  DeliverToolApprovalStatus,
} from "../task/task_manager.js";

interface BuildRespondAckParams {
  requestId: string;
  inputRequestId: string;
  result: DeliverInputResponseResult;
}

interface BuildToolApprovalAckParams {
  requestId: string;
  approvalId: string;
  decision: DeliverToolApprovalResult["decision"];
  result: DeliverToolApprovalResult;
}

export type RespondAck =
  | {
      type: "respond_ack";
      requestId: string;
      inputRequestId: string;
      status: "ok";
      delivered: true;
      eventId?: number;
    }
  | {
      type: "respond_ack";
      requestId: string;
      inputRequestId: string;
      status: "error";
      code: string;
      message: string;
      backend?: string;
      taskStatus?: string;
    };

export type ToolApprovalAck =
  | {
      type: "tool_approval_ack";
      requestId: string;
      approvalId: string;
      decision: DeliverToolApprovalResult["decision"];
      status: "ok";
      delivered: true;
      eventId?: number;
    }
  | {
      type: "tool_approval_ack";
      requestId: string;
      approvalId: string;
      decision: DeliverToolApprovalResult["decision"];
      status: "error";
      code: string;
      message: string;
      backend?: string;
      taskStatus?: string;
    };

export function buildRespondAck(params: BuildRespondAckParams): RespondAck {
  const { requestId, inputRequestId, result } = params;
  if (result.status === "delivered") {
    return {
      type: "respond_ack",
      requestId,
      inputRequestId,
      status: "ok",
      delivered: true,
      ...(result.eventId !== undefined ? { eventId: result.eventId } : {}),
    };
  }

  return {
    type: "respond_ack",
    requestId,
    inputRequestId,
    status: "error",
    code: respondErrorCode(result.status),
    message: result.message ?? defaultRespondErrorMessage(result),
    ...(result.backend ? { backend: result.backend } : {}),
    ...(result.taskStatus ? { taskStatus: result.taskStatus } : {}),
  };
}

export function buildToolApprovalAck(
  params: BuildToolApprovalAckParams,
): ToolApprovalAck {
  const { requestId, approvalId, decision, result } = params;
  if (result.status === "delivered") {
    return {
      type: "tool_approval_ack",
      requestId,
      approvalId,
      decision,
      status: "ok",
      delivered: true,
      ...(result.eventId !== undefined ? { eventId: result.eventId } : {}),
    };
  }

  return {
    type: "tool_approval_ack",
    requestId,
    approvalId,
    decision,
    status: "error",
    code: toolApprovalErrorCode(result.status),
    message: result.message ?? defaultToolApprovalErrorMessage(result),
    ...(result.backend ? { backend: result.backend } : {}),
    ...(result.taskStatus ? { taskStatus: result.taskStatus } : {}),
  };
}

function respondErrorCode(status: Exclude<DeliverInputResponseStatus, "delivered">): string {
  switch (status) {
    case "expired":
      return "INPUT_REQUEST_EXPIRED";
    case "already_responded":
      return "INPUT_REQUEST_ALREADY_RESPONDED";
    case "request_not_pending":
      return "REQUEST_NOT_PENDING";
    case "session_not_running":
      return "SESSION_NOT_RUNNING";
    case "session_not_found":
      return "SESSION_NOT_FOUND";
    case "not_supported":
      return "INPUT_RESPONSE_NOT_SUPPORTED";
  }
}

function defaultRespondErrorMessage(result: DeliverInputResponseResult): string {
  switch (result.status) {
    case "expired":
      return `Input request expired: ${result.requestId}`;
    case "already_responded":
      return `Input request already responded: ${result.requestId}`;
    case "request_not_pending":
      return `Input request not pending: ${result.requestId}`;
    case "session_not_running":
      return `Session is not running: ${result.taskStatus ?? "unknown"}`;
    case "session_not_found":
      return `Session not found for input response`;
    case "not_supported":
      return `Input response is not supported by backend: ${result.backend ?? "unknown"}`;
    case "delivered":
      return "Input response delivered";
  }
}

function toolApprovalErrorCode(
  status: Exclude<DeliverToolApprovalStatus, "delivered">,
): string {
  switch (status) {
    case "approval_not_pending":
      return "TOOL_APPROVAL_NOT_PENDING";
    case "already_resolved":
      return "TOOL_APPROVAL_ALREADY_RESOLVED";
    case "session_not_running":
      return "SESSION_NOT_RUNNING";
    case "session_not_found":
      return "SESSION_NOT_FOUND";
    case "not_supported":
      return "TOOL_APPROVAL_NOT_SUPPORTED";
  }
}

function defaultToolApprovalErrorMessage(result: DeliverToolApprovalResult): string {
  switch (result.status) {
    case "approval_not_pending":
      return `Tool approval not pending: ${result.approvalId}`;
    case "already_resolved":
      return `Tool approval already resolved: ${result.approvalId}`;
    case "session_not_running":
      return `Session is not running: ${result.taskStatus ?? "unknown"}`;
    case "session_not_found":
      return "Session not found for tool approval";
    case "not_supported":
      return `Tool approval is not supported by backend: ${result.backend ?? "unknown"}`;
    case "delivered":
      return "Tool approval delivered";
  }
}
