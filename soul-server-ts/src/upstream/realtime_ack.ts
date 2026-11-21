import type {
  RealtimeCreateCallResult,
  RealtimeRelayEventResult,
  RealtimeResolveApprovalResult,
} from "../realtime/realtime_broker.js";
import type {
  RealtimeEventAck as WireRealtimeEventAck,
  RealtimeToolApprovalAck as WireRealtimeToolApprovalAck,
} from "@soulstream/wire-schema";

export type RealtimeAckType =
  | "realtime_call_created"
  | "realtime_event_ack"
  | "realtime_tool_approval_ack";

interface BuildRealtimeCallCreatedAckParams {
  requestId: string;
  agentSessionId: string;
  result: RealtimeCreateCallResult;
}

interface BuildRealtimeEventAckParams {
  requestId: string;
  agentSessionId: string;
  result: RealtimeRelayEventResult;
}

interface BuildRealtimeToolApprovalAckParams {
  requestId: string;
  agentSessionId: string;
  approvalId: string;
  decision: RealtimeResolveApprovalResult["decision"];
  result: RealtimeResolveApprovalResult;
}

interface BuildRealtimeAckErrorParams {
  type: RealtimeAckType;
  requestId: string;
  agentSessionId: string;
  message: string;
}

export interface RealtimeCallCreatedAck {
  type: "realtime_call_created";
  requestId: string;
  agentSessionId: string;
  status: "ok";
  callId: string;
  answerSdp: string;
  eventId?: number;
}

export type RealtimeEventAck = { [K in keyof WireRealtimeEventAck as K extends "status" ? never : K]: WireRealtimeEventAck[K] } & { status: "ok" } & Required<Pick<WireRealtimeEventAck, "agentSessionId">>;

export type RealtimeToolApprovalAck = { [K in keyof WireRealtimeToolApprovalAck as K extends "status" ? never : K]: WireRealtimeToolApprovalAck[K] } & { status: "ok" } & Required<Pick<WireRealtimeToolApprovalAck, "agentSessionId" | "approvalId" | "decision" | "dataChannelEvent">>;

export interface RealtimeAckError {
  type: RealtimeAckType;
  requestId: string;
  agentSessionId: string;
  status: "error";
  code: "REALTIME_ERROR";
  message: string;
}

export function buildRealtimeCallCreatedAck(
  params: BuildRealtimeCallCreatedAckParams,
): RealtimeCallCreatedAck {
  const { requestId, agentSessionId, result } = params;
  return {
    type: "realtime_call_created",
    requestId,
    agentSessionId,
    status: "ok",
    callId: result.callId,
    answerSdp: result.answerSdp,
    ...(result.eventId !== undefined ? { eventId: result.eventId } : {}),
  };
}

export function buildRealtimeEventAck(
  params: BuildRealtimeEventAckParams,
): RealtimeEventAck {
  const { requestId, agentSessionId, result } = params;
  return {
    type: "realtime_event_ack",
    requestId,
    agentSessionId,
    status: "ok",
    ...(result.normalizedType ? { normalizedType: result.normalizedType } : {}),
    ...(result.eventId !== undefined ? { eventId: result.eventId } : {}),
  };
}

export function buildRealtimeToolApprovalAck(
  params: BuildRealtimeToolApprovalAckParams,
): RealtimeToolApprovalAck {
  const { requestId, agentSessionId, approvalId, decision, result } = params;
  return {
    type: "realtime_tool_approval_ack",
    requestId,
    agentSessionId,
    approvalId,
    decision,
    status: "ok",
    dataChannelEvent: result.dataChannelEvent,
    ...(result.eventId !== undefined ? { eventId: result.eventId } : {}),
  };
}

export function buildRealtimeAckError(
  params: BuildRealtimeAckErrorParams,
): RealtimeAckError {
  const { type, requestId, agentSessionId, message } = params;
  return {
    type,
    requestId,
    agentSessionId,
    status: "error",
    code: "REALTIME_ERROR",
    message,
  };
}
