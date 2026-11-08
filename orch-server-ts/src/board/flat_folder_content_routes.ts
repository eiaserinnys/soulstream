import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { verifyServiceBearerAuthorization } from "../auth/service_bearer.js";
import { CustomViewRevisionConflictError } from "./folder_content_types.js";
import { dispatchFlatReadOperation, getFlatReadOperationSchema, isFlatReadOperation } from "./flat_folder_content_operations.js";
import type { FlatFolderContentHost } from "./flat_folder_content_host.js";
import { MarkdownDocumentVersionConflictError } from "./markdown_document_version.js";

const schemas = {
  "create-markdown-document": z.object({ folderId: z.string().min(1), title: z.string(), body: z.string(),
    documentId: z.string().min(1).max(200).optional(), x: z.number().optional(), y: z.number().optional() }).strict(),
  "update-markdown-document": z.object({ documentId: z.string().min(1), fields: z.object({
    expectedVersion: z.number().int().positive(), title: z.string().optional(), body: z.string().optional() }).strict() }).strict(),
  "delete-markdown-document": z.object({ documentId: z.string().min(1) }).strict(),
  "move-markdown-document": z.object({ documentId: z.string().min(1), folderId: z.string().min(1) }).strict(),
  "move-board-item-to-folder": z.object({ boardItemId: z.string().min(1), folderId: z.string().min(1), idempotencyKey: z.string().min(1) }).strict(),
  "move-session-to-folder": z.object({ sessionId: z.string().min(1), folderId: z.string().min(1).nullable() }).strict(),
  "upsert-custom-view-board-item": z.object({ folderId: z.string().min(1), boardItemId: z.string().min(1),
    customViewId: z.string().min(1), title: z.string(), html: z.string(), revision: z.number().int(),
    x: z.number(), y: z.number(), metadata: z.record(z.string(), z.unknown()).optional() }).strict(),
  "remove-board-item": z.object({ folderId: z.string().min(1), boardItemId: z.string().min(1) }).strict(),
} as const;

export type FlatFolderContentRouteOptions = { host: FlatFolderContentHost; authBearerToken: string; environment?: string };
export const flatFolderContentRouteAuthRequirements = { "POST /internal/folder-content/:operation": true } as const;

export function registerFlatFolderContentRoutes(app: FastifyInstance, options: FlatFolderContentRouteOptions): void {
  app.post<{ Params: { operation: string } }>("/internal/folder-content/:operation", async (request, reply) => {
    const auth = verifyServiceBearerAuthorization(request.headers.authorization, options.authBearerToken, options.environment);
    if (!auth.ok) return reply.code(auth.statusCode).send({ detail: { error: { code: "UNAUTHORIZED", message: auth.reason } } });
    const operation = request.params.operation;
    const schema = schemas[operation as keyof typeof schemas] ?? getFlatReadOperationSchema(operation);
    if (!schema) return reply.code(404).send({ detail: { error: { code: "FOLDER_CONTENT_OPERATION_NOT_FOUND", message: operation } } });
    const parsed = schema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(422).send({ detail: { error: { code: "INVALID_FOLDER_CONTENT_REQUEST", message: parsed.error.message } } });
    try {
      if (isFlatReadOperation(operation)) return reply.send(await dispatchFlatReadOperation(operation, parsed.data, options.host));
      switch (operation) {
        case "create-markdown-document": return reply.send(await options.host.documents.create(parsed.data as z.infer<typeof schemas["create-markdown-document"]>));
        case "update-markdown-document": {
          const input = parsed.data as z.infer<typeof schemas["update-markdown-document"]>;
          return reply.send(await options.host.documents.update(input.documentId, input.fields));
        }
        case "delete-markdown-document": {
          const input = parsed.data as z.infer<typeof schemas["delete-markdown-document"]>;
          await options.host.documents.delete(input.documentId); return reply.send({ ok: true });
        }
        case "move-markdown-document": {
          const input = parsed.data as z.infer<typeof schemas["move-markdown-document"]>;
          return reply.send(await options.host.documents.move(input.documentId, input.folderId));
        }
        case "move-board-item-to-folder": {
          const input = parsed.data as z.infer<typeof schemas["move-board-item-to-folder"]>;
          return reply.send(await options.host.moveBoardItem(input.boardItemId, input.folderId, input.idempotencyKey));
        }
        case "move-session-to-folder": {
          const input = parsed.data as z.infer<typeof schemas["move-session-to-folder"]>;
          await options.host.sessions.moveSessionToFolder(input.sessionId, input.folderId); return reply.send({ ok: true });
        }
        case "upsert-custom-view-board-item": return reply.send(await options.host.upsertCustomViewBoardItem(parsed.data as z.infer<typeof schemas["upsert-custom-view-board-item"]>));
        case "remove-board-item": {
          const input = parsed.data as z.infer<typeof schemas["remove-board-item"]>;
          await options.host.removeBoardItem(input.folderId, input.boardItemId); return reply.send({ ok: true });
        }
      }
    } catch (error) {
      if (error instanceof MarkdownDocumentVersionConflictError) return reply.code(409).send({ detail: { error: {
        code: "MARKDOWN_DOCUMENT_VERSION_CONFLICT", message: error.message, documentId: error.documentId,
        expectedVersion: error.expectedVersion, actualVersion: error.actualVersion } } });
      if (error instanceof CustomViewRevisionConflictError) return reply.code(409).send({ detail: { error: {
        code: "CUSTOM_VIEW_REVISION_CONFLICT", message: error.message, customViewId: error.customViewId,
        expectedRevision: error.expectedRevision, actualRevision: error.actualRevision } } });
      const status = typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500;
      request.log.error({ err: error, operation }, "Folder content host operation failed");
      return reply.code(status).send({ detail: { error: { code: "FOLDER_CONTENT_OPERATION_FAILED", message: error instanceof Error ? error.message : "Operation failed" } } });
    }
  });
}
