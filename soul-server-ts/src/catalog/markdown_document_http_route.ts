import type { IncomingHttpHeaders } from "node:http";

import type { FastifyInstance } from "fastify";

import {
  authenticateDashboardHttpRequest,
  type BoardYjsAuthConfig,
} from "../collaboration/board_yjs_auth.js";
import { MarkdownDocumentVersionConflictError } from "../db/markdown_document_version.js";
import type { CatalogService } from "./catalog_service.js";

export interface MarkdownDocumentHttpRouteConfig {
  service: CatalogService;
  auth: BoardYjsAuthConfig;
}

interface MarkdownDocumentCreateBody {
  folderId?: unknown;
  folder_id?: unknown;
  container?: unknown;
  title?: unknown;
  body?: unknown;
  x?: unknown;
  y?: unknown;
}

interface MarkdownDocumentUpdateBody {
  expectedVersion?: unknown;
  expected_version?: unknown;
  title?: unknown;
  body?: unknown;
}

interface MarkdownDocumentRouteParams {
  documentId: string;
}

export function registerMarkdownDocumentHttpRoutes(
  fastify: FastifyInstance,
  config: MarkdownDocumentHttpRouteConfig,
): void {
  fastify.post<{ Body: MarkdownDocumentCreateBody }>(
    "/api/markdown-documents",
    async (request, reply) => {
      const unauthorized = await authorize(request.headers, config.auth);
      if (unauthorized) return reply.status(401).send(unauthorized);

      const parsed = parseCreateBody(request.body ?? {});
      if (!parsed.ok) return reply.status(422).send(errorDetail("INVALID_MARKDOWN_DOCUMENT_CREATE", parsed.error));

      try {
        const result = await config.service.createMarkdownDocument(parsed.value);
        return reply.status(201).send(result);
      } catch (err) {
        request.log.error({ err }, "Markdown document create failed");
        return reply.status(500).send(errorDetail(
          "MARKDOWN_DOCUMENT_CREATE_FAILED",
          err instanceof Error ? err.message : "Markdown document create failed",
        ));
      }
    },
  );

  fastify.put<{
    Params: MarkdownDocumentRouteParams;
    Body: MarkdownDocumentUpdateBody;
  }>("/api/markdown-documents/:documentId", async (request, reply) => {
    const unauthorized = await authorize(request.headers, config.auth);
    if (unauthorized) return reply.status(401).send(unauthorized);

    const parsed = parseUpdateBody(request.body ?? {});
    if (!parsed.ok) return reply.status(422).send(errorDetail("INVALID_MARKDOWN_DOCUMENT_UPDATE", parsed.error));

    try {
      const document = await config.service.updateMarkdownDocument(
        request.params.documentId,
        parsed.value,
      );
      if (!document) {
        return reply.status(404).send(errorDetail("MARKDOWN_DOCUMENT_NOT_FOUND", "Document not found"));
      }
      return document;
    } catch (err) {
      if (err instanceof MarkdownDocumentVersionConflictError) {
        return reply.status(409).send(errorDetail("MARKDOWN_DOCUMENT_VERSION_CONFLICT", err.message));
      }
      request.log.error({ err }, "Markdown document update failed");
      return reply.status(500).send(errorDetail(
        "MARKDOWN_DOCUMENT_UPDATE_FAILED",
        err instanceof Error ? err.message : "Markdown document update failed",
      ));
    }
  });

  fastify.delete<{ Params: MarkdownDocumentRouteParams }>(
    "/api/markdown-documents/:documentId",
    async (request, reply) => {
      const unauthorized = await authorize(request.headers, config.auth);
      if (unauthorized) return reply.status(401).send(unauthorized);

      try {
        await config.service.deleteMarkdownDocument(request.params.documentId);
        return reply.status(204).send();
      } catch (err) {
        request.log.error({ err }, "Markdown document delete failed");
        return reply.status(500).send(errorDetail(
          "MARKDOWN_DOCUMENT_DELETE_FAILED",
          err instanceof Error ? err.message : "Markdown document delete failed",
        ));
      }
    },
  );
}

async function authorize(
  requestHeaders: IncomingHttpHeaders,
  config: BoardYjsAuthConfig,
): Promise<ReturnType<typeof errorDetail> | null> {
  try {
    await authenticateDashboardHttpRequest({ requestHeaders, config });
    return null;
  } catch (err) {
    return errorDetail(
      "UNAUTHORIZED",
      err instanceof Error ? err.message : "Authentication failed",
    );
  }
}

function parseCreateBody(
  body: MarkdownDocumentCreateBody,
): { ok: true; value: Parameters<CatalogService["createMarkdownDocument"]>[0] } | { ok: false; error: string } {
  const folderId = body.folderId ?? body.folder_id;
  if (typeof folderId !== "string" || !folderId.trim()) {
    return { ok: false, error: "folderId is required" };
  }
  if (typeof body.title !== "string" || !body.title.trim()) {
    return { ok: false, error: "title is required" };
  }
  const container = parseContainer(body.container);
  if (!container.ok) return container;
  const hasX = body.x !== undefined;
  const hasY = body.y !== undefined;
  if (hasX !== hasY) return { ok: false, error: "x and y must be supplied together" };
  if (hasX && (typeof body.x !== "number" || typeof body.y !== "number")) {
    return { ok: false, error: "x and y must be numbers" };
  }
  return {
    ok: true,
    value: {
      folderId,
      ...(container.value ? { container: container.value } : {}),
      title: body.title,
      body: typeof body.body === "string" ? body.body : "",
      ...(typeof body.x === "number" && typeof body.y === "number"
        ? { x: body.x, y: body.y }
        : {}),
    },
  };
}

function parseUpdateBody(
  body: MarkdownDocumentUpdateBody,
): { ok: true; value: { title?: string; body?: string; expectedVersion: number } } | { ok: false; error: string } {
  const expectedVersion = body.expectedVersion ?? body.expected_version;
  if (typeof expectedVersion !== "number" || !Number.isInteger(expectedVersion) || expectedVersion <= 0) {
    return { ok: false, error: "expectedVersion must be a positive integer" };
  }
  const value: { title?: string; body?: string; expectedVersion: number } = { expectedVersion };
  if (body.title !== undefined) {
    if (typeof body.title !== "string") return { ok: false, error: "title must be a string" };
    value.title = body.title;
  }
  if (body.body !== undefined) {
    if (typeof body.body !== "string") return { ok: false, error: "body must be a string" };
    value.body = body.body;
  }
  if (value.title === undefined && value.body === undefined) {
    return { ok: false, error: "No fields to update" };
  }
  return { ok: true, value };
}

function parseContainer(
  value: unknown,
): { ok: true; value?: { containerKind: "folder" | "runbook"; containerId: string } } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== "object") return { ok: false, error: "container must be an object" };
  const kind = (value as { kind?: unknown; containerKind?: unknown }).kind
    ?? (value as { containerKind?: unknown }).containerKind;
  const id = (value as { id?: unknown; containerId?: unknown }).id
    ?? (value as { containerId?: unknown }).containerId;
  if ((kind !== "folder" && kind !== "runbook") || typeof id !== "string" || !id.trim()) {
    return { ok: false, error: "invalid container" };
  }
  return { ok: true, value: { containerKind: kind, containerId: id } };
}

function errorDetail(code: string, message: string) {
  return {
    detail: {
      error: {
        code,
        message,
      },
    },
  };
}
