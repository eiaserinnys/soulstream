import type { FastifyInstance, FastifyReply } from "fastify";

import { MarkdownDocumentVersionConflictError } from "../board-yjs/markdown_document_version.js";
import {
  resolveLocalBoardYjsService,
  sendBoardYjsHostProxyError,
  type BoardYjsHostProxyRouteOptions,
} from "./board_yjs_host_proxy.js";
import type {
  MarkdownDocumentContainerKind,
  MarkdownDocumentRecord,
} from "./markdown_document_routes.js";

export async function updateLocalMarkdownDocument(
  app: FastifyInstance,
  reply: FastifyReply,
  hostProxy: BoardYjsHostProxyRouteOptions,
  existing: MarkdownDocumentRecord,
  documentId: string,
  fields: { expectedVersion: number; title?: string; body?: string },
): Promise<FastifyReply> {
  try {
    const updated = await resolveLocalBoardYjsService(app, hostProxy)
      .updateMarkdownDocument(documentContainer(existing), documentId, fields);
    if (updated === null) return reply.code(404).send({ detail: "Document not found" });
    return reply.send(updated);
  } catch (error) {
    if (error instanceof MarkdownDocumentVersionConflictError) {
      return reply.code(409).send({
        detail: "Markdown document version conflict",
        expectedVersion: error.expectedVersion,
        actualVersion: error.actualVersion,
      });
    }
    return sendBoardYjsHostProxyError(reply, error);
  }
}

export async function deleteLocalMarkdownDocument(
  app: FastifyInstance,
  reply: FastifyReply,
  hostProxy: BoardYjsHostProxyRouteOptions,
  existing: MarkdownDocumentRecord,
  documentId: string,
): Promise<FastifyReply> {
  try {
    await resolveLocalBoardYjsService(app, hostProxy)
      .deleteMarkdownDocument(documentContainer(existing), documentId);
    return reply.code(204).send();
  } catch (error) {
    return sendBoardYjsHostProxyError(reply, error);
  }
}

export function documentFolderId(document: MarkdownDocumentRecord): string | null {
  return stringOrNull(document.folderId) ?? stringOrNull(document.folder_id);
}

export function publicMarkdownDocumentRecord(
  document: MarkdownDocumentRecord,
): MarkdownDocumentRecord {
  const { containerKind: _containerKind, containerId: _containerId, ...record } = document;
  return record;
}

function documentContainer(document: MarkdownDocumentRecord): {
  containerKind: MarkdownDocumentContainerKind;
  containerId: string;
} {
  const containerKind = document.containerKind;
  const containerId = stringOrNull(document.containerId);
  if ((containerKind === "folder" || containerKind === "task") && containerId !== null) {
    return { containerKind, containerId };
  }
  const folderId = documentFolderId(document);
  if (folderId !== null) return { containerKind: "folder", containerId: folderId };
  throw new Error("Markdown document board container not found");
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
