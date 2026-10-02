import type { ServiceCaller } from "../auth/service_caller.js";
import type { FastifyRequest } from "fastify";

import type {
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
  request: FastifyRequest | ServiceCaller,
  bodyCallerInfo: JsonObject | null | undefined,
  systemNodeId: string,
) => Promise<JsonObject> | JsonObject;

export type PreparedSessionCreate = {
  readonly payload: JsonObject;
};

export type PrepareSessionCreateInput = {
  readonly request: FastifyRequest | ServiceCaller;
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
  if ("container" in body) throw new SessionCreateLifecycleError("INVALID_REQUEST", "folderId is required for folder placement", 422);
  optionalString(body, "folderId");

  let snapshot: BoardItemCatalogSnapshot | undefined;
  delete payload.sourceSessionId;
  if (sourceSessionId) {
    if (!stringOrNull(payload.folderId)) {
      snapshot = await options.boardItems.getCatalogSnapshot();
      const sourceItem = primarySessionBoardItem(snapshot.boardItems, sourceSessionId);
      const inherited = stringOrNull(sourceItem?.folderId);
      if (inherited !== null) payload.folderId = inherited;
    }
  }

  const accessEmail = callerInfoEmail(bodyCallerInfo);
  const access = await options.access.resolveAccess({
    request: input.request,
    accessEmail,
  });
  if (access.restricted) {
    snapshot ??= await options.boardItems.getCatalogSnapshot();
    let folderId = stringOrNull(payload.folderId);
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
