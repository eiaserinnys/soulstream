import type { FastifyRequest } from "fastify";

import type {
  BoardContainerTarget,
  BoardItemCatalogSnapshot,
  BoardItemRecord,
  BoardItemRouteProvider,
} from "../board/board_item_routes.js";
import {
  firstAllowedSessionFolderId,
  type SessionResourceAccessProvider,
} from "./session_resource_access.js";

type JsonObject = Record<string, unknown>;

export type SessionCallerInfoResolver = (
  request: FastifyRequest,
  bodyCallerInfo: JsonObject | null | undefined,
  systemNodeId: string,
) => Promise<JsonObject> | JsonObject;

export type PreparedSessionCreate = {
  readonly payload: JsonObject;
};

export type PrepareSessionCreateInput = {
  readonly request: FastifyRequest;
  readonly body: JsonObject;
};

export type SessionCreateLifecycle = {
  readonly prepare: (
    input: PrepareSessionCreateInput,
  ) => Promise<PreparedSessionCreate>;
};

export type CreateSessionCreateLifecycleOptions = {
  readonly resolveCallerInfo: SessionCallerInfoResolver;
  readonly boardItems: BoardItemRouteProvider;
  readonly access: SessionResourceAccessProvider;
};

export class SessionCreateLifecycleError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = "SessionCreateLifecycleError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function createSessionCreateLifecycle(
  options: CreateSessionCreateLifecycleOptions,
): SessionCreateLifecycle {
  return {
    async prepare(input) {
      try {
        return await prepareSessionCreate(options, input);
      } catch (error) {
        throw normalizeLifecycleError(error);
      }
    },
  };
}

async function prepareSessionCreate(
  options: CreateSessionCreateLifecycleOptions,
  input: PrepareSessionCreateInput,
): Promise<PreparedSessionCreate> {
  const body = input.body;
  const payload: JsonObject = Object.fromEntries(
    Object.entries(body).filter(([, value]) => value !== null && value !== undefined),
  );
  const sourceSessionId = optionalString(body, "sourceSessionId");
  const bodyCallerInfo = optionalObject(body, "caller_info");
  const nodeId = optionalString(body, "nodeId") ?? "";
  validateOptionalContainer(body);

  let snapshot: BoardItemCatalogSnapshot | undefined;
  delete payload.sourceSessionId;
  if (sourceSessionId) {
    if (!isJsonObject(payload.container)) {
      snapshot = await options.boardItems.getCatalogSnapshot();
      const sourceItem = primarySessionBoardItem(snapshot.boardItems, sourceSessionId);
      const inherited = inheritedTaskContainer(sourceItem);
      if (inherited !== undefined) payload.container = inherited;
    }
  }

  const accessEmail = callerInfoEmail(bodyCallerInfo);
  const access = await options.access.resolveAccess({
    request: input.request,
    accessEmail,
  });
  if (access.restricted) {
    snapshot ??= await options.boardItems.getCatalogSnapshot();
    let folderId = await resolvePayloadFolderId(options.boardItems, payload);
    if (folderId === null) {
      folderId = firstAllowedSessionFolderId(access, snapshot.folders);
      if (folderId !== null) payload.folderId = folderId;
    }
    await options.access.requireFolderAccess({
      request: input.request,
      accessEmail,
      folderId,
    });
  }

  payload.caller_info = await options.resolveCallerInfo(
    input.request,
    bodyCallerInfo,
    nodeId,
  );
  return { payload };
}

function primarySessionBoardItem(
  boardItems: readonly BoardItemRecord[],
  sourceSessionId: string,
): BoardItemRecord | undefined {
  return boardItems.find((item) =>
    item.itemType === "session" &&
    item.itemId === sourceSessionId &&
    (item.membershipKind ?? "primary") === "primary"
  );
}

function inheritedTaskContainer(
  item: BoardItemRecord | undefined,
): BoardContainerTarget | undefined {
  if (item?.containerKind !== "task") return undefined;
  const containerId = item.containerId;
  if (typeof containerId !== "string" || containerId.length === 0) return undefined;
  return { kind: "task", id: containerId };
}

async function resolvePayloadFolderId(
  provider: BoardItemRouteProvider,
  payload: JsonObject,
): Promise<string | null> {
  let folderId = stringOrNull(payload.folderId);
  if (!isJsonObject(payload.container)) return folderId;
  const kind = payload.container.kind;
  const containerId = stringOrNull(payload.container.id);
  if (kind === "folder" && containerId !== null) return containerId;
  if (kind !== "task" || containerId === null) return folderId;
  folderId = await provider.resolveBoardContainerFolderId({
    kind: "task",
    id: containerId,
  });
  return folderId;
}

function validateOptionalContainer(body: JsonObject): void {
  if (body.container === undefined || body.container === null) return;
  if (!isJsonObject(body.container)) {
    throw new SessionCreateLifecycleError(
      "INVALID_REQUEST",
      "container must be a JSON object or null",
      422,
    );
  }
}

function optionalObject(
  object: JsonObject,
  key: string,
): JsonObject | null | undefined {
  const value = object[key];
  if (value === undefined || value === null) return value;
  if (isJsonObject(value)) return value;
  throw new SessionCreateLifecycleError(
    "INVALID_REQUEST",
    `${key} must be a JSON object or null`,
    422,
  );
}

function optionalString(object: JsonObject, key: string): string | undefined {
  const value = object[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  throw new SessionCreateLifecycleError(
    "INVALID_REQUEST",
    `${key} must be a string or null`,
    422,
  );
}

function callerInfoEmail(callerInfo: JsonObject | null | undefined): string | null {
  return stringOrNull(callerInfo?.email);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeLifecycleError(error: unknown): SessionCreateLifecycleError {
  if (error instanceof SessionCreateLifecycleError) return error;
  if (typeof error === "object" && error !== null) {
    const statusCode = "statusCode" in error ? error.statusCode : undefined;
    if (typeof statusCode === "number") {
      const code = "code" in error && typeof error.code === "string"
        ? error.code
        : "SESSION_CREATE_PREPARATION_FAILED";
      const message = error instanceof Error ? error.message : code;
      return new SessionCreateLifecycleError(code, message, statusCode);
    }
  }
  return new SessionCreateLifecycleError(
    "SESSION_CREATE_PREPARATION_FAILED",
    error instanceof Error ? error.message : String(error),
    500,
  );
}
