import type { RequestResponseNodeCommandPayload } from "../node/pending_commands.js";

export type JsonObject = Record<string, unknown>;

export type SessionParams = {
  session_id: string;
};

export type ApprovalParams = SessionParams & {
  approval_id: string;
};

export type ExistingSessionActionPayload<TType extends string> =
  RequestResponseNodeCommandPayload<TType> & {
    agentSessionId: string;
  };

export type InterveneNodeCommandPayload =
  ExistingSessionActionPayload<"intervene"> & {
    text: string;
    user: string;
    attachment_paths?: string[];
    extra_context_items?: JsonObject[];
    caller_info?: JsonObject;
  };

export type InterruptNodeCommandPayload =
  ExistingSessionActionPayload<"interrupt_session">;

export type ToolApprovalNodeCommandPayload =
  ExistingSessionActionPayload<"approve_tool" | "reject_tool"> & {
    approvalId: string;
    message?: string;
    alwaysApprove?: boolean;
    alwaysReject?: boolean;
  };

export type RealtimeCreateCallNodeCommandPayload =
  ExistingSessionActionPayload<"realtime_create_call"> & {
    offerSdp: string;
    model?: string;
    voice?: string;
    instructions?: string;
  };

export type RealtimeEventNodeCommandPayload =
  ExistingSessionActionPayload<"realtime_event"> & {
    event: JsonObject;
    callId?: string;
  };

export type RealtimeResolveToolApprovalNodeCommandPayload =
  ExistingSessionActionPayload<"realtime_resolve_tool_approval"> & {
    approvalId: string;
    decision: "approved" | "rejected";
    message?: string;
    source?: "tap" | "voice";
    callId?: string;
  };

export type ParseResult<TValue> =
  | { ok: true; value: TValue }
  | { ok: false; message: string };

export function parseObjectBody(body: unknown): JsonObject | undefined {
  return isJsonObject(body) ? body : undefined;
}

export function parseOptionalObjectBody(body: unknown): ParseResult<JsonObject> {
  if (body === undefined || body === null) return { ok: true, value: {} };
  const parsed = parseObjectBody(body);
  return parsed === undefined
    ? { ok: false, message: "Request body must be a JSON object" }
    : { ok: true, value: parsed };
}

export function intervenePayload(
  agentSessionId: string,
  body: JsonObject,
): ParseResult<InterveneNodeCommandPayload> {
  if (typeof body.text !== "string") {
    return { ok: false, message: "text is required" };
  }
  const user = optionalString(body.user) ?? "";
  const attachmentPaths = optionalStringArrayAlias(body, [
    "attachmentPaths",
    "attachment_paths",
  ]);
  if (!attachmentPaths.ok) return attachmentPaths;
  const contextItems = optionalObjectArrayAlias(body, [
    "context_items",
    "contextItems",
  ]);
  if (!contextItems.ok) return contextItems;
  const callerInfo = optionalObject(body.caller_info, "caller_info");
  if (!callerInfo.ok) return callerInfo;

  const payload: InterveneNodeCommandPayload = {
    type: "intervene",
    agentSessionId,
    text: body.text,
    user,
  };
  if (attachmentPaths.value !== undefined && attachmentPaths.value.length > 0) {
    payload.attachment_paths = attachmentPaths.value;
  }
  if (contextItems.value !== undefined && contextItems.value.length > 0) {
    payload.extra_context_items = contextItems.value;
  }
  if (callerInfo.value !== undefined) {
    payload.caller_info = callerInfo.value;
  }
  return { ok: true, value: payload };
}

export function toolApprovalPayload(
  params: ApprovalParams,
  body: unknown,
  type: "approve_tool" | "reject_tool",
): ParseResult<ToolApprovalNodeCommandPayload> {
  const parsedBody = parseOptionalObjectBody(body);
  if (!parsedBody.ok) return parsedBody;
  const payload: ToolApprovalNodeCommandPayload = {
    type,
    agentSessionId: params.session_id,
    approvalId: params.approval_id,
  };
  const message = optionalString(parsedBody.value.message);
  if (message !== undefined) payload.message = message;
  if (type === "approve_tool") {
    const alwaysApprove = optionalBoolean(parsedBody.value.alwaysApprove, "alwaysApprove");
    if (!alwaysApprove.ok) return alwaysApprove;
    if (alwaysApprove.value !== undefined) payload.alwaysApprove = alwaysApprove.value;
  } else {
    const alwaysReject = optionalBoolean(parsedBody.value.alwaysReject, "alwaysReject");
    if (!alwaysReject.ok) return alwaysReject;
    if (alwaysReject.value !== undefined) payload.alwaysReject = alwaysReject.value;
  }
  return { ok: true, value: payload };
}

export function realtimeCreateCallPayload(
  agentSessionId: string,
  body: JsonObject,
): ParseResult<RealtimeCreateCallNodeCommandPayload> {
  const offerSdp = optionalString(body.offerSdp) ?? optionalString(body.offer_sdp);
  if (offerSdp === undefined) {
    return { ok: false, message: "offerSdp is required" };
  }

  const payload: RealtimeCreateCallNodeCommandPayload = {
    type: "realtime_create_call",
    agentSessionId,
    offerSdp,
  };
  const model = optionalString(body.model);
  const voice = optionalString(body.voice);
  const instructions = optionalString(body.instructions);
  if (model !== undefined) payload.model = model;
  if (voice !== undefined) payload.voice = voice;
  if (instructions !== undefined) payload.instructions = instructions;
  return { ok: true, value: payload };
}

export function realtimeEventPayload(
  agentSessionId: string,
  body: JsonObject,
): ParseResult<RealtimeEventNodeCommandPayload> {
  const event = optionalObject(body.event, "event");
  if (!event.ok) return event;
  if (event.value === undefined) {
    return { ok: false, message: "event is required" };
  }

  const payload: RealtimeEventNodeCommandPayload = {
    type: "realtime_event",
    agentSessionId,
    event: event.value,
  };
  const callId = optionalString(body.callId);
  if (callId !== undefined) payload.callId = callId;
  return { ok: true, value: payload };
}

export function realtimeResolveToolApprovalPayload(
  params: ApprovalParams,
  body: JsonObject,
): ParseResult<RealtimeResolveToolApprovalNodeCommandPayload> {
  if (body.decision !== "approved" && body.decision !== "rejected") {
    return { ok: false, message: "decision must be approved or rejected" };
  }

  const payload: RealtimeResolveToolApprovalNodeCommandPayload = {
    type: "realtime_resolve_tool_approval",
    agentSessionId: params.session_id,
    approvalId: params.approval_id,
    decision: body.decision,
  };
  const message = optionalString(body.message);
  const source = optionalRealtimeSource(body.source);
  const callId = optionalString(body.callId);
  if (!source.ok) return source;
  if (message !== undefined) payload.message = message;
  if (source.value !== undefined) payload.source = source.value;
  if (callId !== undefined) payload.callId = callId;
  return { ok: true, value: payload };
}

function isJsonObject(value: unknown): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalBoolean(
  value: unknown,
  field: string,
): ParseResult<boolean | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  return typeof value === "boolean"
    ? { ok: true, value }
    : { ok: false, message: `${field} must be a boolean` };
}

function optionalRealtimeSource(
  value: unknown,
): ParseResult<"tap" | "voice" | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  return value === "tap" || value === "voice"
    ? { ok: true, value }
    : { ok: false, message: "source must be tap or voice" };
}

function optionalObject(
  value: unknown,
  field: string,
): ParseResult<JsonObject | undefined> {
  if (value === undefined || value === null) {
    return { ok: true, value: undefined };
  }
  return isJsonObject(value)
    ? { ok: true, value }
    : { ok: false, message: `${field} must be a JSON object` };
}

function optionalStringArrayAlias(
  body: JsonObject,
  aliases: readonly string[],
): ParseResult<string[] | undefined> {
  const [field, value] = firstAliasValue(body, aliases);
  if (value === undefined) return { ok: true, value: undefined };
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? { ok: true, value }
    : { ok: false, message: `${field} must be an array of strings` };
}

function optionalObjectArrayAlias(
  body: JsonObject,
  aliases: readonly string[],
): ParseResult<JsonObject[] | undefined> {
  const [field, value] = firstAliasValue(body, aliases);
  if (value === undefined) return { ok: true, value: undefined };
  return Array.isArray(value) && value.every(isJsonObject)
    ? { ok: true, value }
    : { ok: false, message: `${field} must be an array of JSON objects` };
}

function firstAliasValue(
  body: JsonObject,
  aliases: readonly string[],
): [string, unknown] {
  for (const alias of aliases) {
    if (alias in body) return [alias, body[alias]];
  }
  return [aliases[0] ?? "field", undefined];
}
