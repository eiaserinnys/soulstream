import type { FastifyInstance, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";

import { MarkdownDocumentVersionConflictError } from "../board-yjs/markdown_document_version.js";
import {
  resolveLocalBoardYjsService,
  sendBoardYjsHostProxyError,
  type BoardYjsHostProxyRouteOptions,
} from "./board_yjs_host_proxy.js";
import type {
  MarkdownDocumentRecord,
} from "./markdown_document_routes.js";

export async function createLocalMarkdownDocument(
  app: FastifyInstance,
  reply: FastifyReply,
  hostProxy: BoardYjsHostProxyRouteOptions,
  input: {
    folderId: string;
    title: string;
    body: string;
    x?: number;
    y?: number;
  },
): Promise<FastifyReply> {
  try {
    const created = await resolveLocalBoardYjsService(app, hostProxy).createMarkdownDocument({
      folderId: input.folderId,
      title: input.title,
      body: input.body,
      ...(input.x !== undefined && input.y !== undefined ? { x: input.x, y: input.y } : {}),
      documentId: randomUUID(),
    });
    return reply.code(201).send(created);
  } catch (error) {
    return sendBoardYjsHostProxyError(reply, error);
  }
}

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

function documentContainer(document: MarkdownDocumentRecord): { folderId: string } {
  const folderId = documentFolderId(document);
  if (folderId === null) throw new Error("Markdown document folder not found");
  return { folderId };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
