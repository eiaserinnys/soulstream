import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  SessionResourceAccessError,
  type SessionResourceAccessProvider,
} from "./session_resource_access.js";

export type SessionCatalogCallerInfo = Record<string, unknown> | null | undefined;

export type SessionCatalogUpdateInput = {
  folderId?: string | null;
  displayName?: string | null;
};

export type RawSessionCardEvent = {
  id?: unknown;
  event_type?: unknown;
  type?: unknown;
  payload?: unknown;
  created_at?: unknown;
  createdAt?: unknown;
};

export type SessionEventCard = {
  id: unknown;
  type: unknown;
  payload: unknown;
  createdAt: unknown;
};

export type MoveSessionsResult = {
  count?: number;
};

export type SessionCatalogProvider = {
  renameSession: (
    sessionId: string,
    displayName: string | null,
    callerInfo?: SessionCatalogCallerInfo,
  ) => Promise<void>;
  moveSessionsToFolder: (
    sessionIds: string[],
    folderId: string | null,
    callerInfo?: SessionCatalogCallerInfo,
  ) => Promise<void | MoveSessionsResult>;
  updateSessionCatalog: (
    sessionId: string,
    update: SessionCatalogUpdateInput,
    callerInfo?: SessionCatalogCallerInfo,
  ) => Promise<void>;
  deleteSession: (
    sessionId: string,
    callerInfo?: SessionCatalogCallerInfo,
  ) => Promise<void>;
  getSessionCards: (
    sessionId: string,
  ) => Promise<Array<RawSessionCardEvent | SessionEventCard>>;
  updateReadPosition: (
    sessionId: string,
    lastReadEventId: number,
    callerInfo?: SessionCatalogCallerInfo,
  ) => Promise<void>;
};

export type SessionCatalogRouteOptions = {
  provider: SessionCatalogProvider;
  accessProvider?: SessionResourceAccessProvider;
};

export class SessionCatalogRouteError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = "SessionCatalogRouteError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

type SessionParams = {
  session_id: string;
};

type Validation<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

export const sessionCatalogRouteAuthRequirements = {
  "PATCH /api/sessions/:session_id/display-name": true,
  "PUT /api/sessions/folder": true,
  "PATCH /api/sessions/folder": true,
  "PUT /api/sessions/:session_id": true,
  "DELETE /api/sessions/:session_id": true,
  "GET /api/sessions/:session_id/cards": true,
  "PUT /api/sessions/:session_id/read-position": true,
} as const;

export function registerSessionCatalogRoutes(
  app: FastifyInstance,
  options: SessionCatalogRouteOptions,
): void {
  app.put("/api/sessions/folder", async (request, reply) =>
    batchMoveFolder(request, reply, options),
  );
  app.patch("/api/sessions/folder", async (request, reply) =>
    batchMoveFolder(request, reply, options),
  );

  app.patch<{ Params: SessionParams }>(
    "/api/sessions/:session_id/display-name",
    async (request, reply) => {
      const body = parseObjectBody(request.body);
      if (!body.ok) return badRequest(reply, body.message);

      const displayName = optionalStringOrNull(body.value, "displayName");
      if (!displayName.ok) return badRequest(reply, displayName.message);
      const callerInfo = optionalCallerInfo(body.value);
      if (!callerInfo.ok) return badRequest(reply, callerInfo.message);

      try {
        await requireSessionAccess(
          options,
          request,
          sessionParams(request).session_id,
          callerInfo.value,
        );
        await options.provider.renameSession(
          sessionParams(request).session_id,
          displayName.value ?? null,
          callerInfo.value,
        );
      } catch (error) {
        return sendProviderError(reply, error);
      }

      return reply.send({ success: true });
    },
  );

  app.put<{ Params: SessionParams }>(
    "/api/sessions/:session_id",
    async (request, reply) => {
      const body = parseObjectBody(request.body);
      if (!body.ok) return badRequest(reply, body.message);

      const update = sessionCatalogUpdate(body.value);
      if (!update.ok) return badRequest(reply, update.message);
      const callerInfo = optionalCallerInfo(body.value);
      if (!callerInfo.ok) return badRequest(reply, callerInfo.message);

      try {
        await requireSessionAccess(
          options,
          request,
          sessionParams(request).session_id,
          callerInfo.value,
        );
        if (hasOwn(update.value, "folderId")) {
          await requireFolderAccess(
            options,
            request,
            update.value.folderId ?? null,
            callerInfo.value,
          );
        }
        await options.provider.updateSessionCatalog(
          sessionParams(request).session_id,
          update.value,
          callerInfo.value,
        );
      } catch (error) {
        return sendProviderError(reply, error);
      }

      return reply.send({ ok: true });
    },
  );

  app.delete<{ Params: SessionParams }>(
    "/api/sessions/:session_id",
    async (request, reply) => {
      const body = parseObjectBody(request.body);
      if (!body.ok) return badRequest(reply, body.message);
      const callerInfo = optionalCallerInfo(body.value);
      if (!callerInfo.ok) return badRequest(reply, callerInfo.message);

      try {
        await requireSessionAccess(
          options,
          request,
          sessionParams(request).session_id,
          callerInfo.value,
        );
        await options.provider.deleteSession(
          sessionParams(request).session_id,
          callerInfo.value,
        );
      } catch (error) {
        return sendProviderError(reply, error);
      }

      return reply.code(204).send();
    },
  );

  app.get<{ Params: SessionParams }>(
    "/api/sessions/:session_id/cards",
    async (request, reply) => {
      try {
        await requireSessionAccess(
          options,
          request,
          sessionParams(request).session_id,
          undefined,
        );
        const events = await options.provider.getSessionCards(
          sessionParams(request).session_id,
        );
        return reply.send(normalizeSessionEventCards(events));
      } catch (error) {
        return sendProviderError(reply, error);
      }
    },
  );

  app.put<{ Params: SessionParams }>(
    "/api/sessions/:session_id/read-position",
    async (request, reply) => {
      const body = parseObjectBody(request.body);
      if (!body.ok) return badRequest(reply, body.message);

      const lastReadEventId = requiredInteger(body.value, "last_read_event_id");
      if (!lastReadEventId.ok) return badRequest(reply, lastReadEventId.message);
      const callerInfo = optionalCallerInfo(body.value);
      if (!callerInfo.ok) return badRequest(reply, callerInfo.message);

      try {
        await requireSessionAccess(
          options,
          request,
          sessionParams(request).session_id,
          callerInfo.value,
        );
        await options.provider.updateReadPosition(
          sessionParams(request).session_id,
          lastReadEventId.value,
          callerInfo.value,
        );
      } catch (error) {
        return sendProviderError(reply, error);
      }

      return reply.send({ ok: true });
    },
  );
}

export function normalizeSessionEventCards(
  events: Array<RawSessionCardEvent | SessionEventCard>,
): SessionEventCard[] {
  return events.map((event) => {
    const raw = event as Record<string, unknown>;
    return {
      id: raw.id,
      type: hasOwn(raw, "type") ? raw.type : raw.event_type,
      payload: parsePayload(raw.payload),
      createdAt: hasOwn(raw, "createdAt") ? raw.createdAt : raw.created_at,
    };
  });
}

async function batchMoveFolder(
  request: FastifyRequest,
  reply: FastifyReply,
  options: SessionCatalogRouteOptions,
): Promise<FastifyReply> {
  const body = parseObjectBody(request.body);
  if (!body.ok) return badRequest(reply, body.message);

  const sessionIds = requiredStringArray(body.value, "sessionIds");
  if (!sessionIds.ok) return badRequest(reply, sessionIds.message);
  const folderId = optionalStringOrNull(body.value, "folderId");
  if (!folderId.ok) return badRequest(reply, folderId.message);
  const callerInfo = optionalCallerInfo(body.value);
  if (!callerInfo.ok) return badRequest(reply, callerInfo.message);

  try {
    await requireFolderAccess(
      options,
      request,
      folderId.value ?? null,
      callerInfo.value,
    );
    for (const sessionId of sessionIds.value) {
      await requireSessionAccess(options, request, sessionId, callerInfo.value);
    }
    const result = await options.provider.moveSessionsToFolder(
      sessionIds.value,
      folderId.value ?? null,
      callerInfo.value,
    );
    return reply.send({
      success: true,
      count: result?.count ?? sessionIds.value.length,
    });
  } catch (error) {
    return sendProviderError(reply, error);
  }
}

async function requireSessionAccess(
  options: SessionCatalogRouteOptions,
  request: FastifyRequest,
  sessionId: string,
  callerInfo: SessionCatalogCallerInfo,
): Promise<void> {
  await options.accessProvider?.requireSessionAccess({
    request,
    sessionId,
    accessEmail: accessEmailFromCallerInfo(callerInfo),
  });
}

async function requireFolderAccess(
  options: SessionCatalogRouteOptions,
  request: FastifyRequest,
  folderId: string | null,
  callerInfo: SessionCatalogCallerInfo,
): Promise<void> {
  await options.accessProvider?.requireFolderAccess({
    request,
    folderId,
    accessEmail: accessEmailFromCallerInfo(callerInfo),
  });
}

function parseObjectBody(body: unknown): Validation<Record<string, unknown>> {
  if (body === undefined || body === null) return { ok: true, value: {} };
  if (typeof body === "object" && !Array.isArray(body)) {
    return { ok: true, value: body as Record<string, unknown> };
  }
  return { ok: false, message: "Request body must be a JSON object" };
}

function sessionCatalogUpdate(
  body: Record<string, unknown>,
): Validation<SessionCatalogUpdateInput> {
  const update: SessionCatalogUpdateInput = {};
  if (hasOwn(body, "folderId")) {
    const folderId = optionalStringOrNull(body, "folderId");
    if (!folderId.ok) return folderId;
    update.folderId = folderId.value;
  }
  if (hasOwn(body, "displayName")) {
    const displayName = optionalStringOrNull(body, "displayName");
    if (!displayName.ok) return displayName;
    update.displayName = displayName.value;
  }
  return { ok: true, value: update };
}

function optionalStringOrNull(
  body: Record<string, unknown>,
  key: string,
): Validation<string | null | undefined> {
  if (!hasOwn(body, key)) return { ok: true, value: undefined };
  const value = body[key];
  if (value === null || typeof value === "string") return { ok: true, value };
  return { ok: false, message: `${key} must be a string or null` };
}

function optionalCallerInfo(
  body: Record<string, unknown>,
): Validation<SessionCatalogCallerInfo> {
  const key = hasOwn(body, "caller_info")
    ? "caller_info"
    : hasOwn(body, "callerInfo")
      ? "callerInfo"
      : null;
  if (key === null) return { ok: true, value: undefined };
  const value = body[key];
  if (value === null) return { ok: true, value };
  if (typeof value === "object" && !Array.isArray(value)) {
    return { ok: true, value: value as Record<string, unknown> };
  }
  return { ok: false, message: "caller_info must be an object or null" };
}

function requiredStringArray(
  body: Record<string, unknown>,
  key: string,
): Validation<string[]> {
  const value = body[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return { ok: false, message: `${key} must be an array of strings` };
  }
  return { ok: true, value };
}

function requiredInteger(
  body: Record<string, unknown>,
  key: string,
): Validation<number> {
  const value = body[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return { ok: false, message: `${key} must be an integer` };
  }
  return { ok: true, value };
}

function parsePayload(payload: unknown): unknown {
  if (typeof payload !== "string") return payload;
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return payload;
  }
}

function accessEmailFromCallerInfo(
  callerInfo: SessionCatalogCallerInfo,
): string | null | undefined {
  if (callerInfo === undefined) return undefined;
  if (callerInfo === null) return null;
  for (const key of ["email", "callerEmail", "access_email", "accessEmail"]) {
    const value = callerInfo[key];
    if (typeof value === "string") return value;
  }
  return null;
}

function badRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({
    error: {
      code: "INVALID_SESSION_CATALOG_REQUEST",
      message,
    },
  });
}

function sendProviderError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof SessionResourceAccessError) {
    return reply.code(error.statusCode).send({
      error: {
        code: error.code,
        message: error.message,
      },
    });
  }
  if (error instanceof SessionCatalogRouteError) {
    return reply.code(error.statusCode).send({
      error: {
        code: error.code,
        message: error.message,
      },
    });
  }
  const message = error instanceof Error ? error.message : "Session catalog route failed";
  return reply.code(422).send({
    error: {
      code: "SESSION_CATALOG_ROUTE_ERROR",
      message,
    },
  });
}

function sessionParams(request: FastifyRequest): SessionParams {
  return request.params as SessionParams;
}

function hasOwn(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}
