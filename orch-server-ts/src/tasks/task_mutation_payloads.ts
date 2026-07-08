import type { TaskStatus } from "./task_read_routes.js";

export const TASK_MUTATION_LIMIT_RANGE_DETAIL = "limit must be between 1 and 200";

export type VerificationOwner = "agent" | "user" | "both";

export type CreateTaskPayload = {
  sessionId: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  verificationOwner: VerificationOwner;
  parentTaskId?: string;
  status: TaskStatus;
  setActive: boolean;
  idempotencyKey?: string;
  linkedSessionId?: string;
  linkedNodeId?: string;
  navigationSessionId?: string;
  navigationNodeId?: string;
  navigationEventId?: number;
};

export type TaskStatusPayload = {
  sessionId: string;
  status: TaskStatus;
  reason?: string;
  expectedVersion?: number;
  idempotencyKey?: string;
};

export type UpdateTaskPayload = {
  sessionId: string;
  title?: string;
  description?: string;
  acceptanceCriteria?: string;
  reason?: string;
  expectedVersion?: number;
  idempotencyKey?: string;
};

export type MoveTaskPayload = {
  sessionId: string;
  newParentTaskId?: string;
  positionKey?: number;
  reason?: string;
  expectedVersion?: number;
  idempotencyKey?: string;
};

export type LinkTaskPayload = {
  sessionId: string;
  linkedSessionId: string;
  linkedNodeId?: string;
  navigationEventId?: number;
  useOperationAnchor: boolean;
  reason?: string;
  expectedVersion?: number;
};

export type HoldTaskPayload = {
  sessionId: string;
  reason?: string;
  expectedVersion?: number;
  idempotencyKey?: string;
};

export type ArchiveTaskPayload = {
  sessionId: string;
  reason?: string;
  expectedVersion?: number;
};

export type PinTaskPayload = {
  sessionId: string;
  pinned: boolean;
  reason?: string;
  expectedVersion?: number;
  idempotencyKey?: string;
};

export type TaskOperationsQuery = {
  limit: number;
};

export type PayloadValidation<T> =
  | { ok: true; value: T }
  | { ok: false; statusCode: number; detail: string };

const taskStatuses = new Set<TaskStatus>([
  "open",
  "in_progress",
  "agent_done",
  "verified_done",
  "reopened",
  "blocked",
  "cancelled",
]);

const verificationOwners = new Set<VerificationOwner>(["agent", "user", "both"]);

export function parseCreateTaskPayload(body: unknown): PayloadValidation<CreateTaskPayload> {
  const object = parseObjectBody(body);
  if (!object.ok) return object;

  const sessionId = requiredString(object.value, "sessionId");
  if (!sessionId.ok) return sessionId;
  const title = requiredString(object.value, "title");
  if (!title.ok) return title;
  const description = stringWithDefault(object.value, "description", "");
  if (!description.ok) return description;
  const acceptanceCriteria = stringWithDefault(object.value, "acceptanceCriteria", "");
  if (!acceptanceCriteria.ok) return acceptanceCriteria;
  const verificationOwner = verificationOwnerWithDefault(
    object.value,
    "verificationOwner",
    "agent",
  );
  if (!verificationOwner.ok) return verificationOwner;
  const status = taskStatusWithDefault(object.value, "status", "open");
  if (!status.ok) return status;
  const setActive = booleanWithDefault(object.value, "setActive", false);
  if (!setActive.ok) return setActive;
  const navigationEventId = optionalInteger(object.value, "navigationEventId");
  if (!navigationEventId.ok) return navigationEventId;
  const optional = optionalStrings(object.value, [
    "parentTaskId",
    "idempotencyKey",
    "linkedSessionId",
    "linkedNodeId",
    "navigationSessionId",
    "navigationNodeId",
  ] as const);
  if (!optional.ok) return optional;

  return {
    ok: true,
    value: {
      sessionId: sessionId.value,
      title: title.value,
      description: description.value,
      acceptanceCriteria: acceptanceCriteria.value,
      verificationOwner: verificationOwner.value,
      parentTaskId: optional.value.parentTaskId,
      status: status.value,
      setActive: setActive.value,
      idempotencyKey: optional.value.idempotencyKey,
      linkedSessionId: optional.value.linkedSessionId,
      linkedNodeId: optional.value.linkedNodeId,
      navigationSessionId: optional.value.navigationSessionId,
      navigationNodeId: optional.value.navigationNodeId,
      navigationEventId: navigationEventId.value,
    },
  };
}

export function parseTaskStatusPayload(body: unknown): PayloadValidation<TaskStatusPayload> {
  const object = parseObjectBody(body);
  if (!object.ok) return object;
  const sessionId = requiredString(object.value, "sessionId");
  if (!sessionId.ok) return sessionId;
  const status = requiredTaskStatus(object.value, "status");
  if (!status.ok) return status;
  const expectedVersion = optionalInteger(object.value, "expectedVersion");
  if (!expectedVersion.ok) return expectedVersion;
  const optional = optionalStrings(object.value, ["reason", "idempotencyKey"] as const);
  if (!optional.ok) return optional;
  return {
    ok: true,
    value: {
      sessionId: sessionId.value,
      status: status.value,
      reason: optional.value.reason,
      expectedVersion: expectedVersion.value,
      idempotencyKey: optional.value.idempotencyKey,
    },
  };
}

export function parseUpdateTaskPayload(body: unknown): PayloadValidation<UpdateTaskPayload> {
  const object = parseObjectBody(body);
  if (!object.ok) return object;
  const sessionId = requiredString(object.value, "sessionId");
  if (!sessionId.ok) return sessionId;
  const title = optionalString(object.value, "title");
  if (!title.ok) return title;
  const description = optionalString(object.value, "description");
  if (!description.ok) return description;
  const acceptanceCriteria = optionalString(object.value, "acceptanceCriteria");
  if (!acceptanceCriteria.ok) return acceptanceCriteria;
  const expectedVersion = optionalInteger(object.value, "expectedVersion");
  if (!expectedVersion.ok) return expectedVersion;
  const optional = optionalStrings(object.value, ["reason", "idempotencyKey"] as const);
  if (!optional.ok) return optional;

  const value: UpdateTaskPayload = {
    sessionId: sessionId.value,
    reason: optional.value.reason,
    expectedVersion: expectedVersion.value,
    idempotencyKey: optional.value.idempotencyKey,
  };
  if (title.value !== undefined) {
    const trimmed = title.value.trim();
    if (trimmed.length === 0) {
      return { ok: false, statusCode: 422, detail: "title must not be empty" };
    }
    value.title = trimmed;
  }
  if (description.value !== undefined) value.description = description.value;
  if (acceptanceCriteria.value !== undefined) {
    value.acceptanceCriteria = acceptanceCriteria.value;
  }
  if (
    value.title === undefined &&
    value.description === undefined &&
    value.acceptanceCriteria === undefined
  ) {
    return { ok: false, statusCode: 422, detail: "no task fields to update" };
  }
  return { ok: true, value };
}

export function parseMoveTaskPayload(body: unknown): PayloadValidation<MoveTaskPayload> {
  const object = parseObjectBody(body);
  if (!object.ok) return object;
  const sessionId = requiredString(object.value, "sessionId");
  if (!sessionId.ok) return sessionId;
  const positionKey = optionalFiniteNumber(object.value, "positionKey");
  if (!positionKey.ok) return positionKey;
  const expectedVersion = optionalInteger(object.value, "expectedVersion");
  if (!expectedVersion.ok) return expectedVersion;
  const optional = optionalStrings(object.value, [
    "newParentTaskId",
    "reason",
    "idempotencyKey",
  ] as const);
  if (!optional.ok) return optional;
  return {
    ok: true,
    value: {
      sessionId: sessionId.value,
      newParentTaskId: optional.value.newParentTaskId,
      positionKey: positionKey.value,
      reason: optional.value.reason,
      expectedVersion: expectedVersion.value,
      idempotencyKey: optional.value.idempotencyKey,
    },
  };
}

export function parseLinkTaskPayload(body: unknown): PayloadValidation<LinkTaskPayload> {
  const object = parseObjectBody(body);
  if (!object.ok) return object;
  const sessionId = requiredString(object.value, "sessionId");
  if (!sessionId.ok) return sessionId;
  const linkedSessionId = requiredString(object.value, "linkedSessionId");
  if (!linkedSessionId.ok) return linkedSessionId;
  const useOperationAnchor = booleanWithDefault(object.value, "useOperationAnchor", false);
  if (!useOperationAnchor.ok) return useOperationAnchor;
  const navigationEventId = optionalInteger(object.value, "navigationEventId");
  if (!navigationEventId.ok) return navigationEventId;
  const expectedVersion = optionalInteger(object.value, "expectedVersion");
  if (!expectedVersion.ok) return expectedVersion;
  const optional = optionalStrings(object.value, ["linkedNodeId", "reason"] as const);
  if (!optional.ok) return optional;
  return {
    ok: true,
    value: {
      sessionId: sessionId.value,
      linkedSessionId: linkedSessionId.value,
      linkedNodeId: optional.value.linkedNodeId,
      navigationEventId: navigationEventId.value,
      useOperationAnchor: useOperationAnchor.value,
      reason: optional.value.reason,
      expectedVersion: expectedVersion.value,
    },
  };
}

export function parseHoldTaskPayload(body: unknown): PayloadValidation<HoldTaskPayload> {
  return parseVersionedSessionBody(body, true);
}

export function parseArchiveTaskPayload(body: unknown): PayloadValidation<ArchiveTaskPayload> {
  return parseVersionedSessionBody(body, false);
}

export function parsePinTaskPayload(body: unknown): PayloadValidation<PinTaskPayload> {
  const base = parseVersionedSessionBody(body, true);
  if (!base.ok) return base;
  const object = parseObjectBody(body);
  if (!object.ok) return object;
  const pinned = requiredBoolean(object.value, "pinned");
  if (!pinned.ok) return pinned;
  return { ok: true, value: { ...base.value, pinned: pinned.value } };
}

export function parseTaskOperationsQuery(query: unknown): PayloadValidation<TaskOperationsQuery> {
  const raw = queryValue(query, "limit");
  if (raw === undefined || raw === "") return { ok: true, value: { limit: 50 } };
  if (typeof raw !== "string") {
    return { ok: false, statusCode: 422, detail: TASK_MUTATION_LIMIT_RANGE_DETAIL };
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== raw || parsed < 1 || parsed > 200) {
    return { ok: false, statusCode: 422, detail: TASK_MUTATION_LIMIT_RANGE_DETAIL };
  }
  return { ok: true, value: { limit: parsed } };
}

function parseVersionedSessionBody(
  body: unknown,
  includeIdempotencyKey: true,
): PayloadValidation<HoldTaskPayload>;
function parseVersionedSessionBody(
  body: unknown,
  includeIdempotencyKey: false,
): PayloadValidation<ArchiveTaskPayload>;
function parseVersionedSessionBody(
  body: unknown,
  includeIdempotencyKey: boolean,
): PayloadValidation<HoldTaskPayload | ArchiveTaskPayload> {
  const object = parseObjectBody(body);
  if (!object.ok) return object;
  const sessionId = requiredString(object.value, "sessionId");
  if (!sessionId.ok) return sessionId;
  const expectedVersion = optionalInteger(object.value, "expectedVersion");
  if (!expectedVersion.ok) return expectedVersion;
  const reason = optionalString(object.value, "reason");
  if (!reason.ok) return reason;
  const idempotencyKey = includeIdempotencyKey
    ? optionalString(object.value, "idempotencyKey")
    : { ok: true as const, value: undefined };
  if (!idempotencyKey.ok) return idempotencyKey;
  const value = {
    sessionId: sessionId.value,
    reason: reason.value,
    expectedVersion: expectedVersion.value,
    ...(includeIdempotencyKey
      ? { idempotencyKey: idempotencyKey.value }
      : {}),
  };
  return { ok: true, value };
}

function parseObjectBody(body: unknown): PayloadValidation<Record<string, unknown>> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, statusCode: 422, detail: "request body must be a JSON object" };
  }
  return { ok: true, value: body as Record<string, unknown> };
}

function requiredString(
  object: Record<string, unknown>,
  key: string,
): PayloadValidation<string> {
  const value = object[key];
  if (typeof value !== "string") {
    return { ok: false, statusCode: 422, detail: `${key} is required` };
  }
  return { ok: true, value };
}

function optionalString(
  object: Record<string, unknown>,
  key: string,
): PayloadValidation<string | undefined> {
  const value = object[key];
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== "string") {
    return { ok: false, statusCode: 422, detail: `${key} must be a string` };
  }
  return { ok: true, value };
}

function optionalStrings<const TKeys extends readonly string[]>(
  object: Record<string, unknown>,
  keys: TKeys,
): PayloadValidation<{ [K in TKeys[number]]: string | undefined }> {
  const values = {} as { [K in TKeys[number]]: string | undefined };
  for (const key of keys) {
    const parsed = optionalString(object, key);
    if (!parsed.ok) return parsed;
    values[key as TKeys[number]] = parsed.value;
  }
  return { ok: true, value: values };
}

function stringWithDefault(
  object: Record<string, unknown>,
  key: string,
  defaultValue: string,
): PayloadValidation<string> {
  if (!(key in object)) return { ok: true, value: defaultValue };
  const parsed = requiredString(object, key);
  return parsed.ok ? parsed : { ok: false, statusCode: 422, detail: `${key} must be a string` };
}

function requiredTaskStatus(
  object: Record<string, unknown>,
  key: string,
): PayloadValidation<TaskStatus> {
  const value = object[key];
  if (typeof value !== "string" || !taskStatuses.has(value as TaskStatus)) {
    return { ok: false, statusCode: 422, detail: "Invalid task status" };
  }
  return { ok: true, value: value as TaskStatus };
}

function taskStatusWithDefault(
  object: Record<string, unknown>,
  key: string,
  defaultValue: TaskStatus,
): PayloadValidation<TaskStatus> {
  if (!(key in object)) return { ok: true, value: defaultValue };
  return requiredTaskStatus(object, key);
}

function verificationOwnerWithDefault(
  object: Record<string, unknown>,
  key: string,
  defaultValue: VerificationOwner,
): PayloadValidation<VerificationOwner> {
  if (!(key in object)) return { ok: true, value: defaultValue };
  const value = object[key];
  if (typeof value !== "string" || !verificationOwners.has(value as VerificationOwner)) {
    return { ok: false, statusCode: 422, detail: "verificationOwner must be agent, user, or both" };
  }
  return { ok: true, value: value as VerificationOwner };
}

function booleanWithDefault(
  object: Record<string, unknown>,
  key: string,
  defaultValue: boolean,
): PayloadValidation<boolean> {
  if (!(key in object)) return { ok: true, value: defaultValue };
  const value = object[key];
  if (typeof value !== "boolean") {
    return { ok: false, statusCode: 422, detail: `${key} must be a boolean` };
  }
  return { ok: true, value };
}

function requiredBoolean(
  object: Record<string, unknown>,
  key: string,
): PayloadValidation<boolean> {
  const value = object[key];
  if (typeof value !== "boolean") {
    return { ok: false, statusCode: 422, detail: `${key} must be a boolean` };
  }
  return { ok: true, value };
}

function optionalInteger(
  object: Record<string, unknown>,
  key: string,
): PayloadValidation<number | undefined> {
  const value = object[key];
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return { ok: false, statusCode: 422, detail: `${key} must be an integer` };
  }
  return { ok: true, value };
}

function optionalFiniteNumber(
  object: Record<string, unknown>,
  key: string,
): PayloadValidation<number | undefined> {
  const value = object[key];
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, statusCode: 422, detail: `${key} must be a number` };
  }
  return { ok: true, value };
}

function queryValue(query: unknown, key: string): unknown {
  if (typeof query !== "object" || query === null || !(key in query)) return undefined;
  const value = (query as Record<string, unknown>)[key];
  return Array.isArray(value) ? value[0] : value;
}
