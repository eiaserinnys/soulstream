import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  isBoardFolderAllowed,
  normalizeBoardAccess,
  type BoardAccess,
} from "./board_access.js";
import {
  type BoardYjsHostProxyRouteOptions,
} from "./board_yjs_host_proxy.js";
import {
  createLocalMarkdownDocument,
  deleteLocalMarkdownDocument,
  documentFolderId,
  updateLocalMarkdownDocument,
} from "./markdown_document_local_mutations.js";

export type MarkdownDocumentFolderRecord = {
  id: string;
  parentFolderId?: string | null;
  [key: string]: unknown;
};

export type MarkdownDocumentRecord = {
  id?: string;
  folderId?: string | null;
  folder_id?: string | null;
  [key: string]: unknown;
};

export type CustomViewRecord = {
  id?: string;
  folderId?: string | null;
  [key: string]: unknown;
};

export type MarkdownDocumentAccess = BoardAccess;

export type MarkdownDocumentRouteProvider = {
  listFolders: () =>
    | Promise<readonly MarkdownDocumentFolderRecord[]>
    | readonly MarkdownDocumentFolderRecord[];
  getMarkdownDocument: (
    documentId: string,
  ) => Promise<MarkdownDocumentRecord | undefined | null> | MarkdownDocumentRecord | undefined | null;
  getCustomView: (
    customViewId: string,
  ) => Promise<CustomViewRecord | undefined | null> | CustomViewRecord | undefined | null;
};

export type MarkdownDocumentAccessProvider = {
  resolveAccess: (
    request: FastifyRequest,
  ) => Promise<MarkdownDocumentAccess> | MarkdownDocumentAccess;
};

export type MarkdownDocumentRouteOptions = {
  provider: MarkdownDocumentRouteProvider;
  accessProvider: MarkdownDocumentAccessProvider;
  hostProxy: BoardYjsHostProxyRouteOptions;
};

export class MarkdownDocumentRouteError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = "MarkdownDocumentRouteError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

type MarkdownDocumentParams = {
  document_id: string;
};

type CustomViewParams = {
  custom_view_id: string;
};

type Validation<T> =
  | { ok: true; value: T }
  | { ok: false; message: string; statusCode?: number };

export const markdownDocumentRouteAuthRequirements = {
  "POST /api/markdown-documents": true,
  "GET /api/markdown-documents/:document_id": true,
  "GET /api/custom-views/:custom_view_id": true,
  "PUT /api/markdown-documents/:document_id": true,
  "DELETE /api/markdown-documents/:document_id": true,
} as const;

export function registerMarkdownDocumentRoutes(
  app: FastifyInstance,
  options: MarkdownDocumentRouteOptions,
): void {
  app.post("/api/markdown-documents", async (request, reply) => {
    const body = parseCreateBody(request.body);
    if (!body.ok) return validationError(reply, body);

    const folders = await options.provider.listFolders();
    const access = normalizeBoardAccess(await options.accessProvider.resolveAccess(request));
    if (!isBoardFolderAllowed(access, folders, body.value.folderId)) {
      return folderAccessDenied(reply);
    }

    const payload: {
      folderId: string;
      title: string;
      body: string;
      x?: number;
      y?: number;
    } = {
      folderId: body.value.folderId,
      title: body.value.title,
      body: body.value.body,
    };
    if (body.value.x !== undefined && body.value.y !== undefined) {
      payload.x = body.value.x;
      payload.y = body.value.y;
    }

    return await createLocalMarkdownDocument(app, reply, options.hostProxy, payload);
  });

  app.get<{ Params: MarkdownDocumentParams }>(
    "/api/markdown-documents/:document_id",
    async (request, reply) => {
      const documentId = markdownDocumentParams(request).document_id;
      const document = await options.provider.getMarkdownDocument(documentId);
      if (document === undefined || document === null) {
        return documentNotFound(reply);
      }
      const folders = await options.provider.listFolders();
      const access = normalizeBoardAccess(await options.accessProvider.resolveAccess(request));
      if (!isBoardFolderAllowed(access, folders, documentFolderId(document))) {
        return folderAccessDenied(reply);
      }
      return reply.send(document);
    },
  );

  app.get<{ Params: CustomViewParams }>(
    "/api/custom-views/:custom_view_id",
    async (request, reply) => {
      const customViewId = customViewParams(request).custom_view_id;
      const customView = await options.provider.getCustomView(customViewId);
      if (customView === undefined || customView === null) {
        return customViewNotFound(reply);
      }
      const folders = await options.provider.listFolders();
      const access = normalizeBoardAccess(await options.accessProvider.resolveAccess(request));
      if (!isBoardFolderAllowed(access, folders, stringOrNull(customView.folderId))) {
        return folderAccessDenied(reply);
      }
      return reply.send(customView);
    },
  );

  app.put<{ Params: MarkdownDocumentParams }>(
    "/api/markdown-documents/:document_id",
    async (request, reply) => {
      const body = parseUpdateBody(request.body);
      if (!body.ok) return validationError(reply, body);

      const documentId = markdownDocumentParams(request).document_id;
      const existing = await options.provider.getMarkdownDocument(documentId);
      if (existing === undefined || existing === null) {
        return documentNotFound(reply);
      }
      const folders = await options.provider.listFolders();
      const access = normalizeBoardAccess(await options.accessProvider.resolveAccess(request));
      if (!isBoardFolderAllowed(access, folders, documentFolderId(existing))) {
        return folderAccessDenied(reply);
      }

      return await updateLocalMarkdownDocument(
        app,
        reply,
        options.hostProxy,
        existing,
        documentId,
        body.value,
      );
    },
  );

  app.delete<{ Params: MarkdownDocumentParams }>(
    "/api/markdown-documents/:document_id",
    async (request, reply) => {
      const documentId = markdownDocumentParams(request).document_id;
      const existing = await options.provider.getMarkdownDocument(documentId);
      if (existing === undefined || existing === null) {
        return documentNotFound(reply);
      }
      const folders = await options.provider.listFolders();
      const access = normalizeBoardAccess(await options.accessProvider.resolveAccess(request));
      if (!isBoardFolderAllowed(access, folders, documentFolderId(existing))) {
        return folderAccessDenied(reply);
      }

      return await deleteLocalMarkdownDocument(
        app,
        reply,
        options.hostProxy,
        existing,
        documentId,
      );
    },
  );
}

function parseCreateBody(body: unknown): Validation<{ folderId: string; title: string; body: string; x?: number; y?: number }> {
  const parsed = z.object({ folderId: z.string().min(1), title: z.string(), body: z.string().default(""),
    x: z.number().finite().optional(), y: z.number().finite().optional(),
  }).strict().refine(value => (value.x === undefined) === (value.y === undefined), "x and y must be supplied together").safeParse(body);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, message: parsed.error.message, statusCode: 422 };
}

function parseUpdateBody(
  body: unknown,
): Validation<{ expectedVersion: number; title?: string; body?: string }> {
  const object = parseObjectBody(body);
  if (!object.ok) return object;
  if (!hasOwn(object.value, "expectedVersion")) {
    return { ok: false, message: "expectedVersion must be a number" };
  }
  const expectedVersion = requiredInteger(object.value, "expectedVersion");
  if (!expectedVersion.ok) return expectedVersion;

  const payload: { expectedVersion: number; title?: string; body?: string } = {
    expectedVersion: expectedVersion.value,
  };
  if (hasOwn(object.value, "title") && object.value.title !== null) {
    const title = requiredString(object.value, "title");
    if (!title.ok) return title;
    payload.title = title.value;
  }
  if (hasOwn(object.value, "body") && object.value.body !== null) {
    const markdownBody = requiredString(object.value, "body");
    if (!markdownBody.ok) return markdownBody;
    payload.body = markdownBody.value;
  }
  if (payload.title === undefined && payload.body === undefined) {
    return { ok: false, message: "No fields to update" };
  }
  return { ok: true, value: payload };
}

function parseObjectBody(body: unknown): Validation<Record<string, unknown>> {
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    return { ok: true, value: body as Record<string, unknown> };
  }
  return { ok: false, message: "Request body must be a JSON object" };
}

function requiredString(
  body: Record<string, unknown>,
  key: string,
): Validation<string> {
  const value = body[key];
  if (typeof value === "string") return { ok: true, value };
  return { ok: false, message: `${key} must be a string` };
}

function optionalBodyString(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = body[key];
  return typeof value === "string" ? value : undefined;
}

function requiredInteger(
  body: Record<string, unknown>,
  key: string,
): Validation<number> {
  const value = body[key];
  if (typeof value === "number" && Number.isInteger(value)) {
    return { ok: true, value };
  }
  return { ok: false, message: `${key} must be a number` };
}

function optionalFiniteNumber(
  body: Record<string, unknown>,
  key: string,
): Validation<number | undefined> {
  const value = body[key];
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value === "number" && Number.isFinite(value)) {
    return { ok: true, value };
  }
  return { ok: false, message: `${key} must be a number` };
}

function validationError<T>(
  reply: FastifyReply,
  validation: Extract<Validation<T>, { ok: false }>,
): FastifyReply {
  return reply.code(validation.statusCode ?? 400).send({ detail: validation.message });
}

function folderAccessDenied(reply: FastifyReply): FastifyReply {
  return reply.code(403).send({ detail: "Folder access denied" });
}

function documentNotFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ detail: "Document not found" });
}

function customViewNotFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ detail: "Custom view not found" });
}

function sendMarkdownDocumentRouteError(
  reply: FastifyReply,
  error: unknown,
  fallbackStatusCode: number,
): FastifyReply {
  if (error instanceof MarkdownDocumentRouteError) {
    return reply.code(error.statusCode).send({ detail: error.message });
  }
  const message =
    error instanceof Error ? error.message : "Markdown document route failed";
  return reply.code(fallbackStatusCode).send({ detail: message });
}

function markdownDocumentParams(request: FastifyRequest): MarkdownDocumentParams {
  return request.params as MarkdownDocumentParams;
}

function customViewParams(request: FastifyRequest): CustomViewParams {
  return request.params as CustomViewParams;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}
