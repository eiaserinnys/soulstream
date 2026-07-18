import type { FastifyInstance } from "fastify";
import { z, type ZodTypeAny } from "zod";

import {
  authenticateDashboardHttpRequest,
  type BoardYjsAuthConfig,
} from "./board_yjs_auth.js";
import type { BoardYjsService } from "./board_yjs_service.js";
import {
  boardContainerKindInputSchema,
  boardItemTypeInputSchema,
} from "./board_container_kind_compat.js";

export interface BoardYjsHostRouteConfig {
  service: BoardYjsService;
  auth: BoardYjsAuthConfig;
}

const containerSchema = z.object({
  containerKind: boardContainerKindInputSchema,
  containerId: z.string().min(1),
});

const scopeSchema = z.object({
  folderId: z.string().min(1),
  containerKind: boardContainerKindInputSchema,
  containerId: z.string().min(1),
});

const rawBoardItemSchema = z.object({
  id: z.string().min(1),
  folderId: z.string().min(1),
  containerKind: boardContainerKindInputSchema.nullable().optional(),
  containerId: z.string().nullable().optional(),
  membershipKind: z.enum(["primary", "reference"]).nullable().optional(),
  sourceTaskItemId: z.string().nullable().optional(),
  sourceRunbookItemId: z.string().nullable().optional(),
  itemType: boardItemTypeInputSchema,
  itemId: z.string().min(1),
  x: z.number(),
  y: z.number(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();
const boardItemSchema = rawBoardItemSchema.transform((item) => {
  const {
    containerKind,
    containerId,
    membershipKind,
    sourceTaskItemId,
    sourceRunbookItemId,
    metadata,
    ...rest
  } = item;
  return {
    ...rest,
    ...(containerKind ? { containerKind } : {}),
    ...(containerId ? { containerId } : {}),
    ...(membershipKind ? { membershipKind } : {}),
    sourceTaskItemId: sourceTaskItemId ?? sourceRunbookItemId ?? null,
    metadata: metadata ?? {},
  };
});

const createMarkdownDocumentSchema = z.object({
  folderId: z.string().min(1),
  container: containerSchema.optional(),
  title: z.string(),
  body: z.string(),
  x: z.number(),
  y: z.number(),
  documentId: z.string().min(1),
});

const upsertSessionBoardItemSchema = z.object({
  folderId: z.string().min(1),
  container: containerSchema,
  sessionId: z.string().min(1),
  x: z.number(),
  y: z.number(),
  sourceTaskItemId: z.string().nullable().optional(),
});

const upsertTaskBoardItemSchema = z.object({
  folderId: z.string().min(1),
  boardItemId: z.string().min(1),
  taskId: z.string().min(1),
  title: z.string(),
  x: z.number(),
  y: z.number(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const upsertCustomViewBoardItemSchema = z.object({
  folderId: z.string().min(1),
  container: containerSchema,
  boardItemId: z.string().min(1),
  customViewId: z.string().min(1),
  title: z.string(),
  html: z.string(),
  revision: z.number().int(),
  x: z.number(),
  y: z.number(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const removeTaskBoardItemSchema = z.object({
  folderId: z.string().min(1),
  boardItemId: z.string().min(1),
});

const boardItemContainerSchema = z.object({
  container: containerSchema,
  boardItemId: z.string().min(1),
});

const updateBoardItemPositionSchema = boardItemContainerSchema.extend({
  x: z.number(),
  y: z.number(),
});

const moveBoardItemToContainerSchema = z.object({
  boardItem: boardItemSchema,
  targetScope: scopeSchema,
  position: z.object({ x: z.number(), y: z.number() }).optional(),
  idempotencyKey: z.string().min(1).optional(),
});

const updateMarkdownDocumentSchema = z.object({
  container: containerSchema,
  documentId: z.string().min(1),
  fields: z.object({
    title: z.string().optional(),
    body: z.string().optional(),
    expectedVersion: z.number().int().positive(),
  }),
});

const deleteMarkdownDocumentSchema = z.object({
  container: containerSchema,
  documentId: z.string().min(1),
});

export function registerBoardYjsHostRoutes(
  fastify: FastifyInstance,
  config: BoardYjsHostRouteConfig,
): void {
  registerHostPost(fastify, config, "create-markdown-document", createMarkdownDocumentSchema, (input) =>
    config.service.createMarkdownDocument(input));

  registerHostPost(fastify, config, "upsert-session-board-item", upsertSessionBoardItemSchema, (input) =>
    config.service.upsertSessionBoardItem(input));

  registerHostPost(fastify, config, "upsert-task-board-item", upsertTaskBoardItemSchema, (input) =>
    config.service.upsertTaskBoardItem(input));

  registerHostPost(fastify, config, "upsert-custom-view-board-item", upsertCustomViewBoardItemSchema, (input) =>
    config.service.upsertCustomViewBoardItem(input));

  registerHostPost(fastify, config, "remove-task-board-item", removeTaskBoardItemSchema, async (input) => {
    await config.service.removeTaskBoardItem(input.folderId, input.boardItemId);
    return { ok: true };
  });

  registerHostPost(fastify, config, "remove-board-item", boardItemContainerSchema, async (input) => {
    await config.service.removeBoardItem(input.container, input.boardItemId);
    return { ok: true };
  });

  registerHostPost(fastify, config, "update-board-item-position", updateBoardItemPositionSchema, async (input) => {
    await config.service.updateBoardItemPosition(input.container, input.boardItemId, input.x, input.y);
    return { ok: true };
  });

  registerHostPost(fastify, config, "move-board-item-to-container", moveBoardItemToContainerSchema, (input) =>
    config.service.moveBoardItemToContainer(input));

  registerHostPost(fastify, config, "update-markdown-document", updateMarkdownDocumentSchema, (input) =>
    config.service.updateMarkdownDocument(input.container, input.documentId, input.fields));

  registerHostPost(fastify, config, "delete-markdown-document", deleteMarkdownDocumentSchema, async (input) => {
    await config.service.deleteMarkdownDocument(input.container, input.documentId);
    return { ok: true };
  });
}

function registerHostPost<S extends ZodTypeAny>(
  fastify: FastifyInstance,
  config: BoardYjsHostRouteConfig,
  operation: string,
  schema: S,
  handler: (input: z.infer<S>) => Promise<unknown>,
): void {
  fastify.post<{ Body: unknown }>(
    `/api/internal/board-yjs/${operation}`,
    async (request, reply) => {
      try {
        await authenticateDashboardHttpRequest({
          requestHeaders: request.headers,
          config: config.auth,
        });
      } catch (err) {
        return reply.status(401).send({
          detail: {
            error: {
              code: "UNAUTHORIZED",
              message: err instanceof Error ? err.message : "Authentication failed",
            },
          },
        });
      }

      const parsed = schema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(422).send({
          detail: {
            error: {
              code: "INVALID_BOARD_YJS_HOST_REQUEST",
              message: parsed.error.message,
            },
          },
        });
      }

      try {
        return await handler(parsed.data);
      } catch (err) {
        request.log.error({ err, operation }, "Board Yjs host operation failed");
        return reply.status(500).send({
          detail: {
            error: {
              code: "BOARD_YJS_HOST_OPERATION_FAILED",
              message: err instanceof Error ? err.message : "Board Yjs host operation failed",
            },
          },
        });
      }
    },
  );
}
