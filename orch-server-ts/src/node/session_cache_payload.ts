const SESSION_CACHE_PAYLOAD_KEYS = [
  "session_id",
  "agent_session_id",
  "agentSessionId",
  "sessionId",
  "status",
  "prompt",
  "created_at",
  "createdAt",
  "updated_at",
  "updatedAt",
  "session_type",
  "sessionType",
  "last_message",
  "lastMessage",
  "client_id",
  "clientId",
  "metadata",
  "display_name",
  "displayName",
  "title",
  "node_id",
  "nodeId",
  "folder_id",
  "folderId",
  "folder_name",
  "folderName",
  "last_event_id",
  "lastEventId",
  "last_read_event_id",
  "lastReadEventId",
  "caller_session_id",
  "callerSessionId",
  "predecessor_session_id",
  "predecessorSessionId",
  "agent_id",
  "agentId",
  "model_preset",
  "modelPreset",
  "model",
  "agent_name",
  "agentName",
  "agent_portrait_url",
  "agentPortraitUrl",
  "backend",
  "user_name",
  "userName",
  "user_portrait_url",
  "userPortraitUrl",
  "review_required",
  "reviewRequired",
  "review_state",
  "reviewState",
  "binding_warnings",
  "bindingWarnings",
  "caller_source",
  "callerSource",
  "session_name",
  "sessionName",
  "last_assistant_text",
  "lastAssistantText",
  "last_progress_text",
  "lastProgressText",
] as const;

export function sessionIdFromPayload(
  payload: Record<string, unknown>,
): string | undefined {
  const session = nestedSession(payload);
  for (const candidate of [payload, session]) {
    for (const key of [
      "agentSessionId",
      "agent_session_id",
      "sessionId",
      "session_id",
      "id",
    ]) {
      const value = candidate[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return undefined;
}

export function sessionStatusFromPayload(
  payload: Record<string, unknown>,
): string | undefined {
  if (typeof payload.status === "string") return payload.status;
  const session = nestedSession(payload);
  return typeof session.status === "string" ? session.status : undefined;
}

export function lastEventIdFromPayload(
  payload: Record<string, unknown>,
): number | undefined {
  if (typeof payload.last_event_id === "number") return payload.last_event_id;
  if (typeof payload.lastEventId === "number") return payload.lastEventId;
  const session = nestedSession(payload);
  if (typeof session.last_event_id === "number") return session.last_event_id;
  if (typeof session.lastEventId === "number") return session.lastEventId;
  return undefined;
}

export function lastEventIdFromEventRelay(
  payload: Record<string, unknown>,
): number | undefined {
  const event = payload.event;
  if (isRecord(event) && typeof event.id === "number") return event.id;
  return lastEventIdFromPayload(payload);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function nestedSession(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const session = payload.session;
  return isRecord(session) ? session : {};
}

export function selectedSessionCreateFields(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const selected: Record<string, unknown> = {};
  for (const key of ["caller_source", "callerSource", "folder_id", "folderId"]) {
    if (key in payload) selected[key] = payload[key];
  }
  return selected;
}

export function projectSessionPayload(
  ...sources: Array<Record<string, unknown> | undefined>
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const source of sources) {
    if (source === undefined) continue;
    const nested = nestedSession(source);
    for (const candidate of [nested, source]) {
      for (const key of SESSION_CACHE_PAYLOAD_KEYS) {
        if (key in candidate) projected[key] = candidate[key];
      }
    }
  }
  return projected;
}
