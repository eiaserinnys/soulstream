import type { FastifyReply } from "fastify";
import type { MarkdownDocumentService } from "./markdown_document_service.js";
import { MarkdownDocumentVersionConflictError } from "./markdown_document_version.js";
import type { MarkdownDocumentRecord } from "./markdown_document_routes.js";

export async function createLocalMarkdownDocument(
  reply: FastifyReply, service: MarkdownDocumentService,
  input: { folderId: string; title: string; body: string; documentId?: string; x?: number; y?: number },
): Promise<FastifyReply> {
  try { return reply.code(201).send(await service.create(input)); }
  catch (error) { return sendError(reply, error); }
}

export async function updateLocalMarkdownDocument(
  reply: FastifyReply, service: MarkdownDocumentService, documentId: string,
  fields: { expectedVersion: number; title?: string; body?: string },
): Promise<FastifyReply> {
  try {
    const result = await service.update(documentId, fields);
    return result === null ? reply.code(404).send({ detail: "Document not found" }) : reply.send(result);
  } catch (error) {
    if (error instanceof MarkdownDocumentVersionConflictError) return reply.code(409).send({
      detail: "Markdown document version conflict", expectedVersion: error.expectedVersion, actualVersion: error.actualVersion,
    });
    return sendError(reply, error);
  }
}

export async function deleteLocalMarkdownDocument(
  reply: FastifyReply, service: MarkdownDocumentService, documentId: string,
): Promise<FastifyReply> {
  try { await service.delete(documentId); return reply.code(204).send(); }
  catch (error) { return sendError(reply, error); }
}

export function documentFolderId(document: MarkdownDocumentRecord): string | null {
  return stringOrNull(document.folderId) ?? stringOrNull(document.folder_id);
}

function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  const status = typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500;
  return reply.code(status).send({ detail: error instanceof Error ? error.message : "Document operation failed" });
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
